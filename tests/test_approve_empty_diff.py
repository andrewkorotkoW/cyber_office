"""Задача с пустым диффом (агент ничего не изменил) не принимается одной кнопкой — только с force."""
import asyncio

import pytest

from app.core.office import Office
from app.core.roster import Roster
from app.core.runner import FakeRunner
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


async def _wait_status(store, task_id, status, timeout=5.0):
    for _ in range(int(timeout / 0.05)):
        if store.get(task_id).status == status:
            return True
        await asyncio.sleep(0.05)
    return False


async def test_empty_diff_is_refused_without_force(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    t = await office.create_task("Пустая задача", "ничего не делай", workspace["repo"], "michael")
    assert await _wait_status(store, t.id, "review")
    t = store.get(t.id)
    t.diff_stat = ""            # имитируем сдачу без единой правки
    store.update(t)

    ok, msg = await office.approve(t.id)
    assert not ok and msg == office.EMPTY_DIFF_MSG
    assert store.get(t.id).status == "review"      # задача осталась на ревью, ничего не влито

    ok, _ = await office.approve(t.id, force=True)
    assert ok and store.get(t.id).status == "done"
