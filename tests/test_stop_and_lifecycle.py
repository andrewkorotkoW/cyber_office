"""Пункты «Таймауты, остановка задач и чистый жизненный цикл сервера»: Office.stop()
(остановка running-задачи владельцем, без автоповтора), TaskStore.load() не должен
писать tasks.json, если ничего не поменялось, Office.resume_pending_auto_retries()
переживает рестарт сервера, симметрия a.state между _run() и _plan(), и REST-ручки
/api/tasks/{id}/stop и DELETE на running (по образцу tests/test_office_diff_note_summary.py)."""
from __future__ import annotations

import asyncio
import importlib
from datetime import datetime, timedelta

import pytest

from app.core.office import Office
from app.core.planner import FakePlanner
from app.core.roster import Roster
from app.core.runner import FakeRunner
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


async def _wait(cond, timeout=6.0, step=0.02):
    for _ in range(int(timeout / step)):
        if cond():
            return True
        await asyncio.sleep(step)
    return False


# ------------------------------------------------------------ Office.stop()

async def test_stop_running_task_marks_failed_without_auto_retry(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.3))
    t = await office.create_task("Долгая", "текст", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "running")

    assert await office.stop(t.id)
    t = store.get(t.id)
    assert t.status == "failed"
    assert t.error == "остановлена владельцем"
    assert "остановлена владельцем" in t.log[-1]
    assert t.auto_retry_at is None
    assert t.id not in office._auto_retry           # без автоповтора
    assert roster.get("michael").state == "idle"
    assert "michael" not in office._running


async def test_stop_unknown_or_not_running_returns_false(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    assert await office.stop("does-not-exist") is False

    t = await office.create_task("Быстрая", "текст", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "review")
    assert await office.stop(t.id) is False          # уже не running


# ------------------------------------------------------------ симметрия planning/idle

async def test_run_finally_does_not_clobber_planning_state(workspace):
    """office._plan() перезаписывает a.state в 'planning', даже если у агента уже была
    running-задача (см. prev_state = lead.state перед lead.state = 'planning'). Когда
    _run() этой задачи потом доходит до finally, она не должна затереть 'planning' обратно
    в 'idle' — только сбросить current_task."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.2), FakePlanner())
    a = roster.get("michael")

    t = await office.create_task("Т", "п", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "running")
    assert a.state == "working"

    # планирование миссии тем же агентом стартовало, пока задача ещё в работе — ровно
    # так это и происходит в office._plan()
    a.state = "planning"
    office._planning["fake-mission"] = asyncio.create_task(asyncio.sleep(10))
    try:
        assert await _wait(lambda: store.get(t.id).status == "review")
        # статус review выставляется чуть раньше, чем finally успевает сбросить current_task
        # (см. аналогичный комментарий в tests/test_office.py про agent.state == 'idle')
        assert await _wait(lambda: a.current_task is None)
        assert a.state == "planning"                # не перезаписано в idle
    finally:
        office._planning["fake-mission"].cancel()


# ------------------------------------------------------------ resume_pending_auto_retries

async def test_resume_pending_auto_retries_fires_after_restart(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    t = store.create("Т", "п", workspace["repo"], "michael")
    t.status = "failed"
    t.auto_retry_at = (datetime.now() + timedelta(seconds=0.05)).isoformat(timespec="seconds")
    t.auto_retries = 1
    store.update(t)

    office = Office(store, roster, FakeRunner(delay=0.01))
    office.resume_pending_auto_retries()
    assert t.id in office._auto_retry
    assert await _wait(lambda: store.get(t.id).status == "review", timeout=3)


async def test_resume_pending_auto_retries_ignores_tasks_without_retry_at(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    t = store.create("Т", "п", workspace["repo"], "michael")
    t.status = "failed"
    store.update(t)

    office = Office(store, roster, FakeRunner(delay=0.01))
    office.resume_pending_auto_retries()
    assert office._auto_retry == {}


# ------------------------------------------------------------ TaskStore.load() не пишет без нужды

def test_load_does_not_write_file_when_nothing_changed(workspace):
    from app import config
    store = TaskStore(config.TASKS_FILE)
    t = store.create("t", "p", workspace["repo"])          # create() уже сохранил файл
    t.status = "review"; store.update(t)
    mtime_before = config.TASKS_FILE.stat().st_mtime_ns

    store2 = TaskStore(config.TASKS_FILE)                  # чистая загрузка — нечего мигрировать/чинить
    assert store2.get(t.id).status == "review"
    assert config.TASKS_FILE.stat().st_mtime_ns == mtime_before


def test_load_does_not_create_file_when_workspace_is_fresh(workspace):
    from app import config
    assert not config.TASKS_FILE.exists()
    TaskStore(config.TASKS_FILE)
    assert not config.TASKS_FILE.exists()


def test_load_writes_when_running_task_gets_fixed_on_restart(workspace):
    from app import config
    store = TaskStore(config.TASKS_FILE)
    t = store.create("t", "p", workspace["repo"])
    t.status = "running"; store.update(t)

    store2 = TaskStore(config.TASKS_FILE)
    assert store2.get(t.id).status == "failed"
    raw = config.TASKS_FILE.read_text(encoding="utf-8")
    assert '"status": "failed"' in raw               # реально записалось на диск


# ------------------------------------------------------------ REST: /stop и DELETE на running

@pytest.fixture
def api(workspace, monkeypatch):
    monkeypatch.setenv("AO_FAKE", "1")
    import app.main as main_module
    importlib.reload(main_module)

    from fastapi.testclient import TestClient
    with TestClient(main_module.app) as client:
        resp = client.post("/api/repos", json={"path": workspace["repo"]})
        assert resp.status_code == 200
        yield client


async def test_rest_stop_running_task(api, workspace):
    client = api
    resp = client.post("/api/tasks", json={"title": "Т", "prompt": "текст подлиннее, чтобы точно застать running",
                                            "repo": workspace["repo"], "agent": "michael"})
    assert resp.status_code == 200
    task_id = resp.json()["id"]

    deadline = asyncio.get_event_loop().time() + 5
    while asyncio.get_event_loop().time() < deadline:
        st = client.get("/api/state").json()
        task = next(t for t in st["tasks"] if t["id"] == task_id)
        if task["status"] == "running":
            break
        await asyncio.sleep(0.02)
    else:
        raise AssertionError("задача не успела перейти в running")

    resp = client.post(f"/api/tasks/{task_id}/stop")
    assert resp.status_code == 200 and resp.json() == {"ok": True}

    st = client.get("/api/state").json()
    task = next(t for t in st["tasks"] if t["id"] == task_id)
    assert task["status"] == "failed"
    assert task["error"] == "остановлена владельцем"

    # второй раз остановить уже нельзя
    resp = client.post(f"/api/tasks/{task_id}/stop")
    assert resp.status_code == 400


async def test_rest_delete_running_task_stops_then_deletes(api, workspace):
    client = api
    resp = client.post("/api/tasks", json={"title": "Т", "prompt": "текст подлиннее, чтобы точно застать running",
                                            "repo": workspace["repo"], "agent": "michael"})
    task_id = resp.json()["id"]

    deadline = asyncio.get_event_loop().time() + 5
    while asyncio.get_event_loop().time() < deadline:
        st = client.get("/api/state").json()
        task = next(t for t in st["tasks"] if t["id"] == task_id)
        if task["status"] == "running":
            break
        await asyncio.sleep(0.02)
    else:
        raise AssertionError("задача не успела перейти в running")

    resp = client.delete(f"/api/tasks/{task_id}")
    assert resp.status_code == 200 and resp.json() == {"ok": True}

    st = client.get("/api/state").json()
    assert all(t["id"] != task_id for t in st["tasks"])   # удалена, а не отклонена с 400
