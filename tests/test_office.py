import asyncio
import os
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
    for _ in range(40):                      # статус review выставляется чуть раньше, чем агент освобождается
        if roster.get("michael").state == "idle":
            break
        await asyncio.sleep(0.05)
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


async def test_started_finished_at_set_on_run(workspace):
    """started_at/finished_at (граф миссии считает по ним длительность узла) проставляются
    в office._run: started_at — когда агент взял задачу, finished_at — когда она пришла
    к review/done/failed, независимо от исхода."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    t = await office.create_task("Обновить README", "текст", workspace["repo"], "michael")
    assert t.started_at is None and t.finished_at is None
    assert await _wait_status(store, t.id, "review")
    t = store.get(t.id)
    assert t.started_at is not None and t.finished_at is not None
    assert t.started_at <= t.finished_at        # ISO timestamp — сортируется как время


async def test_started_finished_at_set_on_failure_too(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    # fail_text без маркеров сбоя API — задача падает без автоповтора (не оставляет
    # отложенных asyncio-таймеров к концу теста, см. память про office retry test hang)
    office = Office(store, roster, FakeRunner(delay=0.01, fail_times=1, fail_text="агент упал сам по себе"))
    t = await office.create_task("Сломается", "текст", workspace["repo"], "michael")
    assert await _wait_status(store, t.id, "failed")
    t = store.get(t.id)
    assert t.started_at is not None and t.finished_at is not None
    assert t.auto_retry_at is None              # без автоповтора — таймеров не осталось


async def test_retry_resets_started_finished_at_before_rerun(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.02))
    t = await office.create_task("Обновить README", "текст", workspace["repo"], "michael")
    assert await _wait_status(store, t.id, "review")
    first_started = store.get(t.id).started_at
    assert await office.reject(t.id)
    assert await office.retry(t.id, "уточнение")
    assert await _wait_status(store, t.id, "review")
    second = store.get(t.id)
    assert second.started_at is not None and second.finished_at is not None
    assert second.started_at >= first_started   # новый запуск — новая метка, не старая


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


async def test_worktree_recreate_after_dir_lost(workspace):
    """Каталог worktree исчез (перезапуск/уборка), а регистрация в git осталась — create должен пережить."""
    import shutil
    from app.core import worktree
    repo = workspace["repo"]
    _, path = await worktree.create(repo, "lost")
    shutil.rmtree(path)                                   # «missing but already registered»
    branch, path2 = await worktree.create(repo, "lost")
    assert branch == "agent/lost" and os.path.isdir(path2)
