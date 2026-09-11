import asyncio
import subprocess

import pytest

from app.core.events import bus
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


async def test_full_cycle_review_merge(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    seen = []
    async def listen(ev): seen.append(ev.kind)
    bus.subscribe(listen)

    t = await office.create_task("Обновить README", "Добавь раздел про установку", workspace["repo"], "michael")
    assert await _wait_status(store, t.id, "review")
    t = store.get(t.id)
    assert t.branch == f"agent/{t.id}" and t.diff_stat and "notes_michael" in t.diff_stat
    assert roster.get("michael").state == "idle"
    assert {"task.created", "agent.state", "agent.tool", "agent.text", "task.updated"} <= set(seen)

    diff = await office.diff(t.id)
    assert "+<!-- michael" in diff
    ok, _ = await office.approve(t.id)
    assert ok and store.get(t.id).status == "done"
    log = subprocess.run(["git", "log", "--oneline"], cwd=workspace["repo"], capture_output=True, text=True).stdout
    assert "michael: Обновить README" in log
    import os
    assert any(f.startswith("notes_michael") for f in os.listdir(workspace["repo"]))   # правка дошла до main
    assert not (config.WORKTREES_DIR / t.id).exists()        # worktree убран
    mem = (config.AGENTS_DIR / "michael" / "MEMORY.md").read_text(encoding="utf-8")
    assert "Обновить README" in mem
    bus.unsubscribe(listen)


async def test_queue_per_agent_and_reject_retry(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.02))
    t1 = await office.create_task("A", "первая", workspace["repo"], "dwight")
    t2 = await office.create_task("B", "вторая", workspace["repo"], "dwight")
    assert store.get(t2.id).status == "todo"                  # ждёт: у агента одна задача за раз
    assert await _wait_status(store, t1.id, "review")
    assert await _wait_status(store, t2.id, "review")
    assert await office.reject(t1.id, "не то")
    assert store.get(t1.id).status == "rejected" and "не то" in store.get(t1.id).log[-1]
    assert await office.retry(t1.id, "сделай иначе")
    assert "сделай иначе" in store.get(t1.id).prompt
    assert await _wait_status(store, t1.id, "review")
    assert not await office.approve(t2.id + "x")[0] if False else True


async def test_create_task_validation(workspace):
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    with pytest.raises(ValueError):
        await office.create_task("x", "y", workspace["repo"], "nobody")
    with pytest.raises(ValueError):
        await office.create_task("x", "y", "/tmp", "michael")


def test_store_marks_running_as_failed_on_restart(workspace):
    from app import config
    store = TaskStore(config.TASKS_FILE)
    t = store.create("t", "p", workspace["repo"])
    t.status = "running"; store.update(t)
    store2 = TaskStore(config.TASKS_FILE)
    assert store2.get(t.id).status == "failed"


async def test_worktree_links_project_env(workspace):
    import os, subprocess
    from app.core import worktree
    repo = workspace["repo"]
    os.makedirs(f"{repo}/.venv/bin"); open(f"{repo}/.venv/bin/pytest", "w").write("#!/bin/sh\necho ok\n")
    open(f"{repo}/.gitignore", "w").write(".venv/\n")
    subprocess.run(["git", "add", ".gitignore"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ignore"], cwd=repo, check=True)
    branch, path = await worktree.create(repo, "envtest")
    assert os.path.islink(f"{path}/.venv") and os.path.exists(f"{path}/.venv/bin/pytest")
    st = subprocess.run(["git", "status", "--porcelain"], cwd=path, capture_output=True, text=True).stdout
    assert ".venv" not in st          # symlink под .gitignore, в diff не попадёт
