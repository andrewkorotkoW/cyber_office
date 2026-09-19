"""Оркестрация: очередь задач по агентам, жизненный цикл, ревью и мердж.

Один агент — одна задача одновременно (как один человек за столом). Остальные
его задачи ждут в todo. Разные агенты работают параллельно.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Callable

from app.core import memory, procs, worktree
from app.core.events import bus
from app.core.planner import Planner
from app.core.roster import Roster
from app.core.runner import Runner, RunResult, infra_failure_reason
from app.core.tasks import Mission, Task, TaskStore

log = logging.getLogger(__name__)

PROMPT_TEMPLATE = """Задача: {title}

{prompt}

Ты работаешь в отдельной git-ветке в каталоге {cwd}. Правь файлы прямо здесь.
Когда закончишь — сделай `git add -A && git commit -m "<что сделал>"` и ответь резюме.
"""

PREV_HINT_MARKER = "Предыдущая попытка сохранена в ветке `"


def _strip_prev_hint(prompt: str) -> str:
    """Убирает из промпта прошлую подсказку про -prev (если есть), чтобы на подряд идущих
    retry в тексте задачи была только одна актуальная — иначе она дублировалась бы на
    каждый повтор. Подсказка — один абзац, отделённый пустыми строками."""
    idx = prompt.find(PREV_HINT_MARKER)
    if idx == -1:
        return prompt
    start = prompt.rfind("\n\n", 0, idx)
    start = start if start != -1 else idx
    end = prompt.find("\n\n", idx)
    end = end if end != -1 else len(prompt)
    return prompt[:start] + prompt[end:]


class Office:
    def __init__(self, store: TaskStore, roster: Roster, runner: Runner, planner: Planner | None = None,
                 auto_retry_delays: tuple[float, ...] = (120.0, 300.0, 900.0), max_auto_retries: int = 3,
                 base_for: Callable[[str], str | None] | None = None) -> None:
        self.store, self.roster, self.runner, self.planner = store, roster, runner, planner
        self.auto_retry_delays, self.max_auto_retries = auto_retry_delays, max_auto_retries
        self.base_for = base_for or (lambda repo: None)   # repos.json: base-ветка репо, если задана явно
        self._running: dict[str, asyncio.Task] = {}
        self._planning: dict[str, asyncio.Task] = {}
        self._auto_retry: dict[str, asyncio.Task] = {}   # task_id -> отложенный автоповтор после сбоя API

    # ------------------------------------------------------------ задачи
    async def create_task(self, title: str, prompt: str, repo: str, agent: str) -> Task:
        if not self.roster.get(agent):
            raise ValueError(f"нет агента {agent}")
        if not await worktree.is_repo(repo):
            raise ValueError(f"{repo} — не git-репозиторий")
        task = self.store.create(title, prompt, repo, agent)
        await bus.emit("task.created", agent, task.id, task=_pub(task))
        self.kick(agent)
        return task

    def kick(self, agent: str) -> None:
        """Если агент свободен и у него есть todo — запускаем следующую."""
        a = self.roster.get(agent)
        if a is None or a.state != "idle" or agent in self._running:
            return
        todo = [t for t in self.store.by_status("todo") if t.agent == agent and self.store.deps_done(t)]
        if todo:
            self._running[agent] = asyncio.create_task(self._run(todo[0]))

    def kick_all(self) -> None:
        for name in self.roster.agents:
            self.kick(name)

    async def _run(self, task: Task) -> None:
        a = self.roster.get(task.agent)
        assert a is not None
        a.state, a.current_task = "working", task.id
        task.status = "running"; task.started_at = datetime.now().isoformat(timespec="seconds")
        task.note("агент начал работу"); self.store.update(task)
        await bus.emit("agent.state", a.name, task.id, state="working")
        await bus.emit("task.updated", a.name, task.id, task=_pub(task))
        try:
            branch, path = await worktree.create(task.repo, task.id)
            task.branch, task.worktree = branch, path
            system = a.system + "\n\nТвоя память (заметки с прошлых задач):\n" + memory.read(a.name)
            res = await self.runner.run(a.name, system, a.model, PROMPT_TEMPLATE.format(
                title=task.title, prompt=task.prompt, cwd=path), path, task.id)
            await worktree.commit_all(path, f"{a.name}: {task.title}")   # если агент забыл закоммитить
            task.result, task.cost_usd, task.turns = res.text, res.cost_usd, res.turns
            task.diff_stat = await worktree.diff_stat(task.repo, branch, self.base_for(task.repo))
            if res.ok:
                task.status = "review"; task.finished_at = datetime.now().isoformat(timespec="seconds")
                task.note("готово, ждёт ревью")
                task.error, task.auto_retries, task.auto_retry_at = None, 0, None
                task.behind_main, task.overlap_files = await worktree.staleness(task.repo, branch, self.base_for(task.repo))
                if task.overlap_files:
                    task.note(f"ветка отстала от main на {task.behind_main}, пересекается: {', '.join(task.overlap_files[:5])}")
                memory.append(a.name, task.title, task.repo, res.text)
            else:
                reason = infra_failure_reason(res)
                task.status = "failed"; task.finished_at = datetime.now().isoformat(timespec="seconds")
                task.error = reason or res.error or "неизвестная ошибка"
                task.note(f"ошибка: {task.error}")
                if reason:
                    await self._handle_infra_failure(task, reason)
        except asyncio.CancelledError:
            # остановлена владельцем (см. Office.stop) — не сбой инфраструктуры, без автоповтора
            task.status = "failed"; task.finished_at = datetime.now().isoformat(timespec="seconds")
            task.error = "остановлена владельцем"
            task.note("остановлена владельцем")
        except Exception as exc:
            log.exception("task %s failed", task.id)
            task.status = "failed"; task.finished_at = datetime.now().isoformat(timespec="seconds")
            reason = infra_failure_reason(RunResult(False, task.result or "", error=str(exc)))
            task.error = reason or str(exc)
            task.note(f"сбой: {exc}")
            if reason:
                await self._handle_infra_failure(task, reason)
        finally:
            self.store.update(task)
            # self._planning ключуется id миссии, а не именем агента — надёжный признак
            # того, что параллельно идёт _plan() этого же агента, это a.state == 'planning'
            # (его выставляет только _plan, см. симметричный prev_state = lead.state там же)
            if a.state == "planning" and self._planning:
                a.current_task = None
            else:
                a.state, a.current_task = "idle", None
            self._running.pop(a.name, None)
            await bus.emit("agent.state", a.name, task.id, state=a.state)
            await bus.emit("task.updated", a.name, task.id, task=_pub(task))
            self.kick(a.name)

    async def stop(self, task_id: str) -> bool:
        """Отменяет работающую задачу (кнопка «Остановить»). _run() сама обрабатывает
        отмену (см. except asyncio.CancelledError выше) — тут просто дожидаемся её finally."""
        t = self.store.get(task_id)
        if not t or t.status != "running":
            return False
        running = self._running.get(t.agent)
        if running is None:
            return False
        running.cancel()
        try:
            await running
        except asyncio.CancelledError:
            pass
        return True

    # ---------------------------------------------------- автоповтор при сбое API
    async def _handle_infra_failure(self, task: Task, reason: str) -> None:
        """Похоже на временный сбой API/сети (а не ошибку в промпте) — самим повторить
        через нарастающую паузу, вместо того чтобы будить владельца на каждую мелочь.
        Уведомляем только на первом падении и когда попытки кончились (см. telegram.py)."""
        if task.auto_retries >= self.max_auto_retries:
            task.auto_retry_at = None
            await bus.emit("task.infra_failure", task.agent, task.id, task=_pub(task), reason=reason,
                           exhausted=True, attempt=task.auto_retries, max_retries=self.max_auto_retries)
            return
        delay = self.auto_retry_delays[min(task.auto_retries, len(self.auto_retry_delays) - 1)]
        is_first = task.auto_retries == 0
        task.auto_retries += 1
        task.auto_retry_at = (datetime.now() + timedelta(seconds=delay)).isoformat(timespec="seconds")
        if is_first:
            await bus.emit("task.infra_failure", task.agent, task.id, task=_pub(task), reason=reason,
                           exhausted=False, attempt=task.auto_retries, max_retries=self.max_auto_retries, delay=delay)
        self._auto_retry[task.id] = asyncio.create_task(self._auto_retry_after(task.id, delay))

    async def _auto_retry_after(self, task_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        finally:
            self._auto_retry.pop(task_id, None)
        t = self.store.get(task_id)
        if t and t.status == "failed":
            await self.retry(task_id, "Автоматический повтор офиса после сбоя API — просто переотправил задачу.")

    def cancel_auto_retry(self, task_id: str) -> None:
        fut = self._auto_retry.pop(task_id, None)
        if fut and not fut.done():
            fut.cancel()

    async def delete_task(self, task_id: str) -> bool:
        """Останавливает работающую задачу, чистит связанный worktree и убирает задачу
        из хранилища. Не ошибка, если задачи уже нет (см. app.main и app.telegram)."""
        t = self.store.get(task_id)
        if t and t.status == "running":
            await self.stop(task_id)   # t обновится на месте (та же ссылка)
        self.cancel_auto_retry(task_id)
        if t and t.status in ("review", "failed"):
            await worktree.remove(t.repo, t.branch, t.worktree, delete_branch=True)
        return self.store.delete(task_id)

    def resume_pending_auto_retries(self) -> None:
        """После рестарта сервера отложенные asyncio.Task на автоповтор не переживают
        перезапуск — карточка обещает t.auto_retry_at, которого фактически не будет.
        Вызывается из app.main lifespan сразу после создания Office: пересоздаём
        таймер на оставшееся время (или сразу, если время уже прошло)."""
        for t in self.store.by_status("failed"):
            if not t.auto_retry_at or t.id in self._auto_retry:
                continue
            try:
                at = datetime.fromisoformat(t.auto_retry_at)
            except ValueError:
                t.auto_retry_at = None
                self.store.update(t)
                continue
            remaining = max(0.0, (at - datetime.now()).total_seconds())
            self._auto_retry[t.id] = asyncio.create_task(self._auto_retry_after(t.id, remaining))

    # ------------------------------------------------------------ ревью
    async def diff(self, task_id: str) -> str:
        t = self.store.get(task_id)
        if not t:
            return ""
        if t.status == "done" and t.merge_commit:
            return await worktree.diff_merge_commit(t.repo, t.merge_commit)
        if not t.branch:
            return ""
        return await worktree.diff_full(t.repo, t.branch, self.base_for(t.repo))

    async def approve(self, task_id: str) -> tuple[bool, str]:
        t = self.store.get(task_id)
        if not t or t.status != "review":
            return False, "задача не на ревью"
        status, out = await worktree.merge(t.repo, t.branch, f"{t.agent}: {t.title} (#{t.id})", self.base_for(t.repo))
        if status == "ok":
            t.merge_commit = out
            await worktree.remove(t.repo, t.branch, t.worktree, delete_branch=True)
            if t.prev_branch:
                await worktree.remove(t.repo, t.prev_branch, None, delete_branch=True)
                t.prev_branch = None
            t.status = "done"; t.note("одобрено, влито в main")
        elif status == "conflict":
            # конфликт: не роняем задачу в «ошибка», а сразу отправляем агента переносить
            # готовую работу поверх свежего main (retry сохраняет прошлую ветку и даёт подсказку)
            t.status = "failed"
            t.note("конфликт с main — автоматически запущен перенос поверх свежего main")
            self.store.update(t)
            await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
            await self.retry(t.id, "Мердж в main конфликтнул. Перенеси свою работу поверх актуального main.")
            return False, "конфликт: задача отправлена на перенос поверх main"
        else:   # ошибка git, не конфликт — пользователь должен разобраться сам, без автоповтора
            t.status = "failed"; t.error = out
            t.note(f"ошибка мерджа: {out[:200]}")
            self.store.update(t)
            await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
            return False, out
        self.store.update(t)
        await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
        await self._check_mission(t.mission_id)
        await self._refresh_staleness(t.repo)
        self.kick_all()          # зависимые задачи могли разблокироваться
        return True, out

    async def run_after_merge(self, repo: str, task_id: str, after_merge_cmd: str | None) -> None:
        """Хук после вливания в main: например, перезапуск бота на новом коде. Команда и repo
        передаются вызывающим кодом (Office не знает про repos.json, см. app.main._after_merge_cmd)."""
        if not after_merge_cmd:
            return
        proc = await asyncio.create_subprocess_shell(after_merge_cmd, cwd=repo, stdout=asyncio.subprocess.PIPE,
                                                      stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        procs.track(proc.pid)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await bus.emit("repo.after_merge", None, task_id, repo=repo, ok=False, output="таймаут 120с")
            log.info("after_merge %s: таймаут 120с", repo)
            return
        finally:
            procs.untrack(proc.pid)
        text = out.decode("utf-8", errors="replace").strip()[-400:]
        await bus.emit("repo.after_merge", None, task_id, repo=repo, ok=proc.returncode == 0, output=text)
        log.info("after_merge %s: exit %s %s", repo, proc.returncode, text)

    async def _refresh_staleness(self, repo: str) -> None:
        """main изменился — пересчитать отставание у всех задач этого репо, ждущих ревью."""
        base = self.base_for(repo)
        for t in self.store.by_status("review"):
            if t.repo == repo and t.branch:
                t.behind_main, t.overlap_files = await worktree.staleness(repo, t.branch, base)
                self.store.update(t)
                await bus.emit("task.updated", t.agent, t.id, task=_pub(t))

    async def reject(self, task_id: str, reason: str = "") -> bool:
        t = self.store.get(task_id)
        if not t or t.status not in ("review", "failed"):
            return False
        self.cancel_auto_retry(task_id)
        await worktree.remove(t.repo, t.branch, t.worktree, delete_branch=True)
        t.status = "rejected"; t.auto_retries, t.auto_retry_at = 0, None
        t.note("отклонено" + (f": {reason}" if reason else ""))
        self.store.update(t)
        await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
        return True

    async def retry(self, task_id: str, extra: str = "") -> bool:
        """Отклонённую/упавшую задачу — заново, с дополнением к промпту."""
        t = self.store.get(task_id)
        if not t or t.status not in ("rejected", "failed"):
            return False
        self.cancel_auto_retry(task_id)
        prev = await worktree.keep_previous(t.repo, t.branch, t.worktree)
        t.prompt = _strip_prev_hint(t.prompt)   # на подряд идущих retry подсказка не должна множиться
        if prev:
            t.prev_branch = prev
        if prev and t.diff_stat:
            base = await worktree.default_branch(t.repo, self.base_for(t.repo))
            t.prompt += (f"\n\n{PREV_HINT_MARKER}{prev}` (она устарела относительно {base}: "
                         f"другая задача уже изменила те же файлы). Не переделывай с нуля: посмотри "
                         f"`git diff {base}...{prev}`, перенеси готовую работу (`git cherry-pick` коммитов из {prev} "
                         f"или вручную), разреши конфликты в пользу актуального {base} и снова прогони тесты.")
        if extra:
            t.prompt += f"\n\nУточнение от ревьюера: {extra}"
        if t.pending_notes:
            t.prompt += "\n\nДополнения, присланные пока агент работал:\n" + "\n".join(f"- {n}" for n in t.pending_notes)
            t.pending_notes = []
        t.status, t.branch, t.worktree, t.result, t.diff_stat = "todo", None, None, None, None
        t.started_at, t.finished_at = None, None
        t.behind_main, t.overlap_files = 0, []
        t.error, t.auto_retry_at = None, None   # auto_retries не сбрасываем — это счётчик подряд идущих сбоев API
        t.note("отправлена заново"); self.store.update(t)
        await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
        self.kick(t.agent)
        return True

    async def add_note(self, task_id: str, text: str) -> bool:
        """Дописать уточнение к задаче, которая ещё в работе — агент увидит его при следующем retry."""
        t = self.store.get(task_id)
        if not t or t.status != "running":
            return False
        t.note(f"✍️ дописано: {text}")
        t.pending_notes.append(text)
        del t.pending_notes[:-20]
        self.store.update(t)
        await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
        return True

    # ------------------------------------------------------------ миссии
    async def create_mission(self, goal: str, repo: str) -> Mission:
        if self.planner is None:
            raise ValueError("планировщик не настроен")
        if not goal.strip():
            raise ValueError("пустая цель")
        if not await worktree.is_repo(repo):
            raise ValueError(f"{repo} — не git-репозиторий")
        m = self.store.create_mission(goal, repo)
        await bus.emit("mission.created", "michael", None, mission=asdict(m))
        self._planning[m.id] = asyncio.create_task(self._plan(m))
        return m

    async def _plan(self, m: Mission) -> None:
        lead = self.roster.get("michael") or next(iter(self.roster.agents.values()))
        prev_state = lead.state          # планирование может идти параллельно с его задачей
        lead.state = "planning"
        await bus.emit("agent.state", lead.name, None, state="planning")
        await bus.emit("agent.text", lead.name, None, text=f"Планирую миссию: {m.goal[:120]}")
        try:
            team = {a.name: a.title for a in self.roster.agents.values()}
            plan = await self.planner.plan(m.goal, m.repo, team)
            if m.id not in self.store.missions:      # миссию удалили, пока шло планирование
                return
            m.summary, m.cost_usd = plan.summary, plan.cost_usd
            key_to_id: dict[str, str] = {}
            for pt in plan.tasks:            # план уже проверен на циклы; создаём в порядке плана
                t = self.store.create(pt.title, pt.prompt, m.repo, pt.agent, mission_id=m.id,
                                      depends_on=[key_to_id[d] for d in pt.depends_on if d in key_to_id])
                key_to_id[pt.key] = t.id
                await bus.emit("task.created", pt.agent, t.id, task=_pub(t))
            # зависимости, объявленные «вперёд» (на задачу, созданную позже)
            for pt in plan.tasks:
                t = self.store.get(key_to_id[pt.key])
                t.depends_on = [key_to_id[d] for d in pt.depends_on if d in key_to_id]
                self.store.update(t)
            m.status = "active"
            await bus.emit("agent.text", lead.name, None, text=f"План: {plan.summary} — {len(plan.tasks)} подзадач.")
        except Exception as exc:
            log.exception("mission %s planning failed", m.id)
            m.status, m.error = "failed", str(exc)
        finally:
            self.store.save()
            self._planning.pop(m.id, None)
            # prev_state мог быть "planning" от параллельного планирования, которое уже
            # завершилось — восстанавливаем состояние по фактам, а не по снимку
            if self._planning:
                lead.state = "planning"
            elif lead.name in self._running:
                lead.state = "working"
            else:
                lead.state = "idle"
            await bus.emit("agent.state", lead.name, None, state=lead.state)
            await bus.emit("mission.updated", lead.name, None, mission=asdict(m))
            self.kick_all()

    async def _check_mission(self, mission_id: str | None) -> None:
        if not mission_id:
            return
        m = self.store.missions.get(mission_id)
        if m and m.status == "active" and all(t.status == "done" for t in self.store.mission_tasks(m.id)):
            m.status = "done"; self.store.save()
            await bus.emit("mission.updated", None, None, mission=asdict(m))

    def snapshot(self) -> dict:
        return {"agents": self.roster.public(), "tasks": [_pub(t) for t in self.store.tasks.values()],
                "missions": [asdict(m) for m in self.store.missions.values()]}


def _pub(t: Task) -> dict:
    d = asdict(t); d["prompt"] = d["prompt"][:2000]; return d


def build_summary(store: TaskStore, since: str) -> dict:
    """done_tasks/cost_usd — по updated_at задач; done_missions — по максимуму updated_at
    среди задач миссии (у Mission нет собственной метки завершения)."""
    tasks_since = [t for t in store.tasks.values() if t.updated_at[:10] >= since]
    done_tasks = sum(1 for t in tasks_since if t.status == "done")
    cost_usd = sum(t.cost_usd for t in tasks_since)
    done_missions = 0
    for m in store.missions.values():
        if m.status != "done":
            continue
        mt = store.mission_tasks(m.id)
        if mt and max(t.updated_at for t in mt)[:10] >= since:
            done_missions += 1
    return {"since": since, "done_tasks": done_tasks, "done_missions": done_missions, "cost_usd": cost_usd}
