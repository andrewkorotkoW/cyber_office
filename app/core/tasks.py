"""Задачи: человекочитаемый tasks.json. Статусы — жизненный цикл одной задачи:

  todo -> running -> review -> done
                 \\-> failed        (агент упал / лимит)
        review -> rejected          (человек отклонил diff)

review — главная точка контроля: агент работает в своём git worktree и не может
попасть в main, пока человек не одобрит diff. Это и есть «поводок».
"""
from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from app.config import TASKS_FILE

STATUSES = ("todo", "running", "review", "done", "failed", "rejected")
MISSION_STATUSES = ("planning", "active", "done", "failed")


@dataclass(slots=True)
class Mission:
    id: str
    goal: str
    repo: str
    status: str = "planning"
    summary: str = ""
    cost_usd: float = 0.0
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    error: str | None = None


@dataclass(slots=True)
class Task:
    id: str
    title: str
    prompt: str
    repo: str                                   # абсолютный путь к git-репозиторию
    agent: str = "michael"
    status: str = "todo"
    branch: str | None = None
    worktree: str | None = None
    result: str | None = None                   # финальный текст агента
    error: str | None = None                    # причина падения (в т.ч. распознанный сбой API)
    diff_stat: str | None = None
    cost_usd: float = 0.0
    turns: int = 0
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    log: list[str] = field(default_factory=list)   # короткая хроника для карточки
    mission_id: str | None = None
    depends_on: list[str] = field(default_factory=list)   # id задач, которые должны быть done
    behind_main: int = 0                        # на сколько коммитов ветка отстала от main
    overlap_files: list[str] = field(default_factory=list)   # файлы, изменённые и в main, и в ветке
    auto_retries: int = 0                       # сколько раз офис уже сам перезапускал задачу подряд из-за сбоя API
    auto_retry_at: str | None = None            # когда сработает следующий автоповтор (None — не запланирован)
    merge_commit: str | None = None             # sha коммита мерджа в main (для diff после done, когда worktree уже удалён)
    pending_notes: list[str] = field(default_factory=list)   # заметки, присланные пока задача ещё running
    started_at: str | None = None               # когда агент начал работу (для длительности на графе миссии)
    finished_at: str | None = None              # когда задача пришла к review/done/failed
    prev_branch: str | None = None              # <branch>-prev от последнего retry — удаляется при успешном approve

    def touch(self) -> None:
        self.updated_at = datetime.now().isoformat(timespec="seconds")

    def note(self, line: str) -> None:
        self.log.append(f"{datetime.now():%H:%M:%S} {line}")
        del self.log[:-60]
        self.touch()


class TaskStore:
    def __init__(self, path: Path = TASKS_FILE) -> None:
        self.path = path
        self.tasks: dict[str, Task] = {}
        self.missions: dict[str, Mission] = {}
        self.load()

    def load(self) -> None:
        """Просто создать/импортировать TaskStore не должно трогать tasks.json на диске —
        save() зовём только если что-то реально поменялось (миграция старого формата,
        задача была в running, миссия — в planning)."""
        changed = False
        if self.path.exists():
            raw = json.loads(self.path.read_text(encoding="utf-8") or "[]")
            if isinstance(raw, list):          # старый формат: только список задач
                raw = {"tasks": raw, "missions": []}
                changed = True
            self.tasks = {t["id"]: Task(**t) for t in raw.get("tasks", [])}
            self.missions = {m["id"]: Mission(**m) for m in raw.get("missions", [])}
            for m in self.missions.values():
                if m.status == "planning":
                    m.status = "failed"; m.error = "процесс перезапущен во время планирования"
                    changed = True
        # процесс перезапустили посреди работы — такие задачи не «running», а сломанные
        for t in self.tasks.values():
            if t.status == "running":
                t.status = "failed"; t.note("процесс перезапущен во время работы")
                changed = True
        if changed:
            self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        payload = {"tasks": [asdict(t) for t in self.tasks.values()],
                   "missions": [asdict(m) for m in self.missions.values()]}
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def create(self, title: str, prompt: str, repo: str, agent: str = "michael",
               mission_id: str | None = None, depends_on: list[str] | None = None) -> Task:
        t = Task(id=uuid.uuid4().hex[:8], title=title.strip()[:120], prompt=prompt.strip(), repo=repo, agent=agent,
                 mission_id=mission_id, depends_on=list(depends_on or []))
        t.note("создана")
        self.tasks[t.id] = t
        self.save()
        return t

    def get(self, task_id: str) -> Task | None:
        return self.tasks.get(task_id)

    def update(self, task: Task) -> None:
        task.touch()
        self.tasks[task.id] = task
        self.save()

    def by_status(self, *statuses: str) -> list[Task]:
        return sorted((t for t in self.tasks.values() if t.status in statuses), key=lambda t: t.created_at)

    def delete(self, task_id: str) -> bool:
        if task_id in self.tasks:
            del self.tasks[task_id]; self.save(); return True
        return False


    # ------------------------------------------------------------ миссии
    def create_mission(self, goal: str, repo: str) -> Mission:
        m = Mission(id=uuid.uuid4().hex[:8], goal=goal.strip(), repo=repo)
        self.missions[m.id] = m
        self.save()
        return m

    def mission_tasks(self, mission_id: str) -> list[Task]:
        return sorted((t for t in self.tasks.values() if t.mission_id == mission_id), key=lambda t: t.created_at)

    def deps_done(self, task: Task) -> bool:
        return all((self.tasks.get(d) or Task(id=d, title="", prompt="", repo="", status="done")).status == "done"
                   for d in task.depends_on)
