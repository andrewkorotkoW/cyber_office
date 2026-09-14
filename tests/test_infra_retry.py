"""Сбои инфраструктуры API (не вина промпта/агента): распознавание, автоповтор
с нарастающей паузой и восстановление предыдущей ветки как при ручном «повторить»."""
import asyncio
import subprocess

import pytest

from app.core.events import bus
from app.core.office import Office
from app.core.roster import Roster
from app.core.runner import FakeRunner, RunResult, infra_failure_reason
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


async def _wait(cond, timeout=5.0, step=0.02):
    for _ in range(int(timeout / step)):
        if cond():
            return True
        await asyncio.sleep(step)
    return False


# ------------------------------------------------------------ детектор причины
def test_infra_failure_reason_none_when_ok():
    assert infra_failure_reason(RunResult(True, "всё сделано")) is None


@pytest.mark.parametrize("text", [
    "Failed to authenticate. API Error: 403 Request not allowed",
    "rate limit exceeded, try again later",
    "the server is overloaded, please retry",
    "upstream returned 529",
    "503 Service Unavailable",
    "socket hang up: ECONNRESET",
])
def test_infra_failure_reason_detects_markers(text):
    reason = infra_failure_reason(RunResult(False, text, error=""))
    assert reason and text.split()[0].lower() not in ("",)  # причина непустая
    assert reason


def test_infra_failure_reason_ignores_ordinary_errors():
    r = RunResult(False, "тесты упали: AssertionError в test_calc.py", error="pytest exited 1")
    assert infra_failure_reason(r) is None


def test_infra_failure_reason_no_result_event_without_marker_text():
    """Ровно баг d0e75247: claude умер, не прислав result, но текст сам по себе без
    маркеров — код возврата без is_error всё равно считаем сбоем инфраструктуры."""
    r = RunResult(False, "", error="агент завершился без result-события", exit_code=1, is_error_result=False)
    assert infra_failure_reason(r)


def test_infra_failure_reason_agent_reported_error_is_not_infra():
    r = RunResult(False, "не смог найти файл конфигурации", error="ошибка", exit_code=1, is_error_result=True)
    assert infra_failure_reason(r) is None


# ------------------------------------------------------------ автоповтор в Office
async def test_auto_retry_recovers_after_infra_failures(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    runner = FakeRunner(delay=0.01, fail_times=2)
    office = Office(store, roster, runner, auto_retry_delays=(0.03, 0.03, 0.03), max_auto_retries=3)
    infra_events = []

    async def listen(ev):
        if ev.kind == "task.infra_failure":
            infra_events.append(ev.data)
    bus.subscribe(listen)

    t = await office.create_task("Т", "п", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "review", timeout=5)
    t = store.get(t.id)
    assert t.auto_retries == 0            # сброшен после успеха
    assert t.auto_retry_at is None
    assert t.error is None
    assert "Автоматический повтор офиса" in t.prompt
    assert len(infra_events) == 1 and infra_events[0]["exhausted"] is False   # уведомили только про первое падение

    branches = subprocess.run(["git", "branch", "--list", f"agent/{t.id}-prev"],
                               cwd=workspace["repo"], capture_output=True, text=True).stdout
    assert f"agent/{t.id}-prev" in branches           # прошлая попытка сохранена, как при ручном повторе
    bus.unsubscribe(listen)


async def test_auto_retry_exhausts_after_max_attempts(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    runner = FakeRunner(delay=0.01, fail_times=99)   # никогда не восстановится
    office = Office(store, roster, runner, auto_retry_delays=(0.02, 0.02, 0.02), max_auto_retries=3)
    infra_events = []

    async def listen(ev):
        if ev.kind == "task.infra_failure":
            infra_events.append(ev.data)
    bus.subscribe(listen)

    t = await office.create_task("Т", "п", workspace["repo"], "michael")
    assert await _wait(lambda: len(infra_events) >= 2, timeout=5)
    await asyncio.sleep(0.05)              # дать финальному _run доработать до конца
    t = store.get(t.id)
    assert t.status == "failed"
    assert t.auto_retries == 3
    assert t.auto_retry_at is None
    assert t.error
    assert len(infra_events) == 2          # первое падение + исчерпание, без шума на попытках 2 и 3
    assert infra_events[0]["exhausted"] is False and infra_events[0]["attempt"] == 1
    assert infra_events[1]["exhausted"] is True and infra_events[1]["attempt"] == 3
    bus.unsubscribe(listen)


async def test_auto_retry_waits_configured_delay(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    runner = FakeRunner(delay=0.01, fail_times=1)
    office = Office(store, roster, runner, auto_retry_delays=(0.3, 0.3, 0.3), max_auto_retries=3)

    t = await office.create_task("Т", "п", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "failed", timeout=2)
    t0 = store.get(t.id)
    assert t0.auto_retries == 1 and t0.auto_retry_at is not None

    await asyncio.sleep(0.1)               # задержка ещё не прошла
    assert store.get(t.id).status == "failed"

    assert await _wait(lambda: store.get(t.id).status == "review", timeout=3)


async def test_manual_retry_cancels_pending_auto_retry(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    runner = FakeRunner(delay=0.01, fail_times=1)
    office = Office(store, roster, runner, auto_retry_delays=(5.0, 5.0, 5.0), max_auto_retries=3)

    t = await office.create_task("Т", "п", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "failed", timeout=2)
    assert t.id in office._auto_retry

    assert await office.retry(t.id, "форсирую вручную")
    assert t.id not in office._auto_retry
    assert await _wait(lambda: store.get(t.id).status == "review", timeout=3)
