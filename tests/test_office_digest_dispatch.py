"""Оскар не берёт задачи из очереди (docs/missions/2026-09-25_status_button_ralph.md,
NON_WORKER_AGENTS в app/core/roster.py). Два независимых пути исключения в app/core/office.py:
явное назначение agent='oscar' на создание задачи (Office.create_task) и общий цикл
автостарта (Office.kick/kick_all), который мог бы подхватить чужую todo-задачу с
agent='oscar', попавшую в store в обход create_task."""
import asyncio

import pytest

from app.core.office import Office
from app.core.roster import Roster
from app.core.runner import FakeRunner
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


async def test_create_task_rejects_explicit_oscar_agent(workspace):
    from app import config

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))

    with pytest.raises(ValueError):
        await office.create_task("Т", "п", workspace["repo"], "oscar")
    assert not store.tasks


async def test_general_dispatch_never_starts_a_stray_oscar_todo_task(workspace):
    """Задача с agent='oscar', созданная напрямую через store (минуя office.create_task,
    например старыми данными или ручной правкой tasks.json), не должна быть подхвачена
    ни точечным kick('oscar'), ни общим kick_all()."""
    from app import config

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    t = store.create("Т", "п", workspace["repo"], "oscar")
    office = Office(store, roster, FakeRunner(delay=0.01))

    office.kick("oscar")
    office.kick_all()
    await asyncio.sleep(0.2)

    assert store.get(t.id).status == "todo"
    assert "oscar" not in office._running
    assert roster.get("oscar").state == "idle"
