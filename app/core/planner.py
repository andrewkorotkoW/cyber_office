"""Планировщик миссии: большая цель -> список подзадач с исполнителями и зависимостями.

Майкл запускается в режиме «только чтение» (без правок), изучает репозиторий и
отвечает строгим JSON. Дальше подзадачи идут обычным путём: worktree -> ревью ->
мердж. Зависимая подзадача стартует только когда все её зависимости влиты в main,
поэтому она видит результат предыдущих.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app import config
from app.config import CLAUDE_BIN
from app.core import procs
from app.core.runner import DESIGN_MD_HINT, looks_like_ui_task

READ_ONLY_TOOLS = "Read,Grep,Glob,LS,Bash(ls*),Bash(cat*),Bash(git log*),Bash(git status*),Bash(find*),Bash(wc*)"

PLAN_PROMPT = """Ты — руководитель небольшой команды разработчиков. Изучи репозиторий (структура, README,
тесты) и разбей цель на подзадачи для команды. Ничего не правь — только читай.

Цель: {goal}

Команда (name — кто это):
{team}

Правила:
- 2–6 подзадач, каждая — законченный кусок работы с проверяемым результатом.
- Подзадачи выполняются в отдельных git-ветках и вливаются в main по одной, поэтому
  если задача B использует результат A — укажи depends_on: ["A-id"].
- Не плоди зависимостей без нужды: независимые задачи идут параллельно.
- prompt — полное техзадание исполнителю: что, где (пути), критерии готовности, какие тесты запустить.
- Последняя подзадача обычно — документация или интеграционная проверка.
- Роли строгие: реализацию кода (фичи, ручки, парсеры, UI) давай только разработчику (michael);
  инженеру по качеству (dwight) — только тесты и поиск дефектов; писателю (pam) — только документацию.
  Если задача смешанная — раздели её на «сделать» (michael) и «покрыть тестами» (dwight).

Ответь ТОЛЬКО JSON без пояснений, вида:
{{"summary": "одно предложение, как решаем",
  "tasks": [{{"id": "t1", "title": "…", "agent": "michael", "prompt": "…", "depends_on": []}},
            {{"id": "t2", "title": "…", "agent": "dwight", "prompt": "…", "depends_on": ["t1"]}}]}}
"""


@dataclass(slots=True)
class PlannedTask:
    key: str
    title: str
    agent: str
    prompt: str
    depends_on: list[str]


@dataclass(slots=True)
class Plan:
    summary: str
    tasks: list[PlannedTask]
    cost_usd: float = 0.0


class Planner(Protocol):
    async def plan(self, goal: str, repo: str, team: dict[str, str]) -> Plan: ...


def parse_plan(text: str, known_agents: set[str], default_agent: str = "michael") -> Plan:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("в ответе планировщика нет JSON")
    data = json.loads(m.group(0), strict=False)
    raw = data.get("tasks") or []
    if not 1 <= len(raw) <= 8:
        raise ValueError(f"план должен содержать 1–8 подзадач, получено {len(raw)}")
    keys = {str(t.get("id") or f"t{i+1}") for i, t in enumerate(raw)}
    tasks = []
    for i, t in enumerate(raw):
        key = str(t.get("id") or f"t{i+1}")
        agent = t.get("agent") if t.get("agent") in known_agents else default_agent
        deps = [d for d in (t.get("depends_on") or []) if d in keys and d != key]
        title, prompt = str(t.get("title") or "").strip(), str(t.get("prompt") or "").strip()
        if not title or not prompt:
            raise ValueError(f"подзадача {key} без названия или описания")
        tasks.append(PlannedTask(key, title[:120], agent, prompt, deps))
    _check_cycles(tasks)
    return Plan(str(data.get("summary") or "").strip(), tasks)


def _add_design_hint(plan: Plan, goal: str, repo: str) -> Plan:
    """Дизайн-миссия (цель похожа на UI-работу) в репозитории с DESIGN.md — подсказать
    ссылку на него в промпте каждой подзадачи, как это делает runner.design_md_addendum
    для отдельных задач."""
    if looks_like_ui_task(goal) and (Path(repo) / "DESIGN.md").exists():
        for t in plan.tasks:
            t.prompt += DESIGN_MD_HINT
    return plan


def _check_cycles(tasks: list[PlannedTask]) -> None:
    deps = {t.key: set(t.depends_on) for t in tasks}
    seen: set[str] = set()
    def visit(k: str, stack: set[str]) -> None:
        if k in stack:
            raise ValueError("в плане циклическая зависимость")
        if k in seen:
            return
        stack.add(k)
        for d in deps.get(k, ()):
            visit(d, stack)
        stack.discard(k); seen.add(k)
    for k in deps:
        visit(k, set())


class ClaudePlanner:
    def __init__(self, binary: str = CLAUDE_BIN, model: str = "sonnet") -> None:
        self.binary, self.model = binary, model

    async def plan(self, goal: str, repo: str, team: dict[str, str]) -> Plan:
        team_txt = "\n".join(f"- {n}: {d}" for n, d in team.items())
        args = [self.binary, "-p", PLAN_PROMPT.format(goal=goal, team=team_txt),
                "--output-format", "json", "--max-turns", "25", "--model", self.model,
                "--allowedTools", READ_ONLY_TOOLS]
        env = {**os.environ, "PATH": f"{Path(self.binary).parent}:{os.environ.get('PATH', '')}"}
        proc = await asyncio.create_subprocess_exec(*args, cwd=repo, env=env,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                    limit=32 * 1024 * 1024, start_new_session=True)
        procs.track(proc.pid)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=config.AO_PLAN_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise RuntimeError(f"планировщик не ответил за {config.AO_PLAN_TIMEOUT}с — таймаут")
        except asyncio.CancelledError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise
        finally:
            procs.untrack(proc.pid)
        try:
            msg = json.loads(out.decode("utf-8", errors="replace"), strict=False)
        except json.JSONDecodeError:
            raise RuntimeError(f"планировщик не ответил JSON: {err.decode(errors='replace')[-300:]}")
        if msg.get("is_error"):
            raise RuntimeError(f"планировщик: {msg.get('result')}")
        plan = parse_plan(msg.get("result") or "", set(team))
        plan.cost_usd = float(msg.get("total_cost_usd") or 0)
        return _add_design_hint(plan, goal, repo)


class FakePlanner:
    async def plan(self, goal: str, repo: str, team: dict[str, str]) -> Plan:
        await asyncio.sleep(0.05)
        agents = list(team)
        plan = Plan(f"Имитация плана для: {goal[:40]}", [
            PlannedTask("t1", "Реализовать основу", agents[0], f"Сделай основу для: {goal}", []),
            PlannedTask("t2", "Покрыть тестами", agents[1 % len(agents)], "Напиши тесты к основе", ["t1"]),
            PlannedTask("t3", "Обновить README", agents[2 % len(agents)], "Опиши изменения в README", ["t1"]),
        ])
        return _add_design_hint(plan, goal, repo)
