"""Репозиторий на паузе: его todo-задачи не берутся в работу, после снятия паузы — берутся."""
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


async def test_paused_repo_tasks_stay_todo_until_resumed(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    office.set_repo_paused(workspace["repo"], True)
    t = await office.create_task("На паузе", "ничего", workspace["repo"], "michael")
    await asyncio.sleep(0.3)
    assert store.get(t.id).status == "todo"
    assert workspace["repo"] in office.paused_repos and office._paused_file().exists()
    office.set_repo_paused(workspace["repo"], False)
    assert await _wait_status(store, t.id, "review")
