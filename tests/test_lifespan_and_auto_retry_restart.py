"""Пункты 5 и 7 «Надёжность»: побочные эффекты импорта app.main и поведение
Office.resume_pending_auto_retries() после «рестарта» сервера.

tests/test_stop_and_lifecycle.py уже проверяет TaskStore.load() саму по себе (не пишет файл на
чистом workspace) и happy path resume_pending_auto_retries (auto_retry_at в прошлом стреляет,
без auto_retry_at — игнорируется). Здесь — то, что не было закрыто: (а) именно app.main (Office
создаётся в lifespan, а не при импорте модуля — office=None до входа в TestClient-контекст, и
tasks.json не появляется ни при импорте, ни просто при входе в lifespan, только когда реально
создаётся задача); (б) resume_pending_auto_retries на битом auto_retry_at (не ISO-строка) и на
auto_retry_at далеко в будущем — фиксируем ТО поведение, что реально в коде (app/core/office.py):
битое значение очищается в None, будущее — планируется на оставшееся время, а не сразу."""
from __future__ import annotations

import importlib
from datetime import datetime, timedelta

import pytest

from app.core.office import Office
from app.core.roster import Roster
from app.core.runner import FakeRunner
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio   # часть тестов ниже синхронные (как в tests/test_stop_and_lifecycle.py) —
                                   # это ожидаемо даёт PytestWarning про asyncio-марку на sync-тестах


async def _wait(cond, timeout=6.0, step=0.02):
    import asyncio
    for _ in range(int(timeout / step)):
        if cond():
            return True
        await asyncio.sleep(step)
    return False


# ------------------------------------------------------------ побочные эффекты импорта

def test_importing_app_main_creates_no_office_and_no_tasks_json(workspace):
    from app import config
    assert not config.TASKS_FILE.exists()

    import app.main as main_module
    importlib.reload(main_module)

    assert main_module.office is None            # Office создаётся в lifespan, не на импорте
    assert not config.TASKS_FILE.exists()


def test_entering_lifespan_alone_does_not_write_tasks_json(workspace, monkeypatch):
    """Вход в lifespan (через `with TestClient(app):`) сам по себе — свежий TaskStore +
    resume_pending_auto_retries() на пустом хранилище — не должен ничего писать на диск,
    пока явно не создана задача."""
    from app import config
    monkeypatch.setenv("AO_FAKE", "1")
    import app.main as main_module
    importlib.reload(main_module)

    from fastapi.testclient import TestClient
    with TestClient(main_module.app) as client:
        assert main_module.office is not None
        assert not config.TASKS_FILE.exists()

        resp = client.post("/api/repos", json={"path": workspace["repo"]})
        assert resp.status_code == 200
        # GET /api/state — те же верхнеуровневые ключи, что и раньше (обратная совместимость)
        state = client.get("/api/state").json()
        assert set(state) == {"agents", "tasks", "missions", "repos", "design_md_repos", "mode", "claude_bin"}
        assert not config.TASKS_FILE.exists()      # ключ у state есть, а файла всё ещё нет

        resp = client.post("/api/tasks", json={"title": "T", "prompt": "p",
                                                "repo": workspace["repo"], "agent": "michael"})
        assert resp.status_code == 200
    assert config.TASKS_FILE.exists()              # только теперь реально записалось


# ------------------------------------------------------------ resume_pending_auto_retries — edge cases

async def test_resume_pending_auto_retries_clears_malformed_timestamp(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    t = store.create("Т", "п", workspace["repo"], "michael")
    t.status = "failed"
    t.auto_retry_at = "не-дата-совсем"
    store.update(t)

    office = Office(store, roster, FakeRunner(delay=0.01))
    office.resume_pending_auto_retries()

    assert t.id not in office._auto_retry            # не запланирован таймер на мусорное значение
    assert store.get(t.id).auto_retry_at is None      # и поле очищено, чтобы карточка не врала


async def test_resume_pending_auto_retries_schedules_remaining_delay_for_future_timestamp(workspace):
    """auto_retry_at далеко в будущем — таймер планируется на ОСТАВШЕЕСЯ время, а не срабатывает
    немедленно (в отличие от happy path в test_stop_and_lifecycle.py, где auto_retry_at уже в
    прошлом): фиксируем именно этот выбор реализации."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    t = store.create("Т", "п", workspace["repo"], "michael")
    t.status = "failed"
    t.auto_retry_at = (datetime.now() + timedelta(seconds=0.6)).isoformat(timespec="seconds")
    store.update(t)

    office = Office(store, roster, FakeRunner(delay=0.01))
    office.resume_pending_auto_retries()
    assert t.id in office._auto_retry

    await _wait(lambda: True, timeout=0.05)          # дать событийному циклу шанс — таймер ещё не должен сработать
    assert store.get(t.id).status == "failed"        # не сработал раньше времени

    assert await _wait(lambda: store.get(t.id).status == "review", timeout=3)
