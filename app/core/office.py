"""Оркестрация: очередь задач по агентам, жизненный цикл, ревью и мердж.

Один агент — одна задача одновременно (как один человек за столом). Остальные
его задачи ждут в todo. Разные агенты работают параллельно.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict

from app.core import memory, worktree
from app.core.events import bus
from app.core.planner import Planner
from app.core.roster import Roster
from app.core.runner import Runner
from app.core.tasks import Mission, Task, TaskStore

log = logging.getLogger(__name__)

PROMPT_TEMPLATE = """Задача: {title}

{prompt}

Ты работаешь в отдельной git-ветке в каталоге {cwd}. Правь файлы прямо здесь.
Когда закончишь — сделай `git add -A && git commit -m "<что сделал>"` и ответь резюме.
"""


class Office:
    def __init__(self, store: TaskStore, roster: Roster, runner: Runner, planner: Planner | None = None) -> None:
        self.store, self.roster, self.runner, self.planner = store, roster, runner, planner
        self._running: dict[str, asyncio.Task] = {}
        self._planning: dict[str, asyncio.Task] = {}

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
        task.status = "running"; task.note("агент начал работу"); self.store.update(task)
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
            task.diff_stat = await worktree.diff_stat(task.repo, branch)
            if res.ok:
                task.status = "review"; task.note("готово, ждёт ревью")
                memory.append(a.name, task.title, task.repo, res.text)
            else:
                task.status = "failed"; task.note(f"ошибка: {res.error}")
        except Exception as exc:
            log.exception("task %s failed", task.id)
            task.status = "failed"; task.note(f"сбой: {exc}")
        finally:
            self.store.update(task)
            a.state, a.current_task = "idle", None
            self._running.pop(a.name, None)
            await bus.emit("agent.state", a.name, task.id, state="idle")
            await bus.emit("task.updated", a.name, task.id, task=_pub(task))
            self.kick(a.name)

    # ------------------------------------------------------------ ревью
    async def diff(self, task_id: str) -> str:
        t = self.store.get(task_id)
        if not t or not t.branch:
            return ""
        return await worktree.diff_full(t.repo, t.branch)

    async def approve(self, task_id: str) -> tuple[bool, str]:
        t = self.store.get(task_id)
        if not t or t.status != "review":
            return False, "задача не на ревью"
        ok, out = await worktree.merge(t.repo, t.branch, f"{t.agent}: {t.title} (#{t.id})")
        if ok:
            await worktree.remove(t.repo, t.branch, t.worktree, delete_branch=True)
            t.status = "done"; t.note("одобрено, влито в main")
        else:
            t.status = "failed"
            t.note("конфликт с main (другая задача изменила те же файлы) — нажми «Повторить», "
                   "агент сделает заново поверх свежего main")
        self.store.update(t)
        await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
        if ok:
            await self._check_mission(t.mission_id)
            self.kick_all()          # зависимые задачи могли разблокироваться
        return ok, out

    async def reject(self, task_id: str, reason: str = "") -> bool:
        t = self.store.get(task_id)
        if not t or t.status not in ("review", "failed"):
            return False
        await worktree.remove(t.repo, t.branch, t.worktree, delete_branch=True)
        t.status = "rejected"; t.note("отклонено" + (f": {reason}" if reason else ""))
        self.store.update(t)
        await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
        return True

    async def retry(self, task_id: str, extra: str = "") -> bool:
        """Отклонённую/упавшую задачу — заново, с дополнением к промпту."""
        t = self.store.get(task_id)
        if not t or t.status not in ("rejected", "failed"):
            return False
        prev = await worktree.keep_previous(t.repo, t.branch, t.worktree)
        if prev and t.diff_stat:
            base = await worktree.default_branch(t.repo)
            t.prompt += (f"\n\nПредыдущая попытка сохранена в ветке `{prev}` (она устарела относительно {base}: "
                         f"другая задача уже изменила те же файлы). Не переделывай с нуля: посмотри "
                         f"`git diff {base}...{prev}`, перенеси готовую работу (`git cherry-pick` коммитов из {prev} "
                         f"или вручную), разреши конфликты в пользу актуального {base} и снова прогони тесты.")
        if extra:
            t.prompt += f"\n\nУточнение от ревьюера: {extra}"
        t.status, t.branch, t.worktree, t.result, t.diff_stat = "todo", None, None, None, None
        t.note("отправлена заново"); self.store.update(t)
        await bus.emit("task.updated", t.agent, t.id, task=_pub(t))
        self.kick(t.agent)
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
            lead.state = prev_state if lead.name in self._running else "idle"
            self._planning.pop(m.id, None)
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
