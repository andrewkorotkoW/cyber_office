"""Тесты на новые ручки офиса (по образцу tests/test_missions.py / test_infra_retry.py):
office.diff() для завершённой (done) задачи, office.add_note() для задачи в работе с
последующим попаданием заметки в промпт при retry(), и build_summary()."""
import asyncio

import pytest

from app.core.office import Office, build_summary
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


# ------------------------------------------------------------ diff() для done-задачи

async def test_diff_for_done_task_contains_the_file_fake_runner_touched(workspace):
    """FakeRunner создаёт notes_{agent}_{task_id}.md в worktree (app/core/runner.py::FakeRunner.run).
    После approve() задача переходит в status=='done', worktree удаляется, но office.diff() должен
    брать diff по сохранённому merge_commit (см. office.py::diff) и всё равно показывать эту правку."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    t = await office.create_task("A", "сделай что-нибудь", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "review")
    ok, _ = await office.approve(t.id)
    assert ok
    t = store.get(t.id)
    assert t.status == "done" and t.merge_commit

    diff_text = await office.diff(t.id)
    assert f"notes_michael_{t.id}.md" in diff_text


async def test_diff_for_unknown_task_is_empty(workspace):
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    assert await office.diff("does-not-exist") == ""


# ------------------------------------------------------------ add_note()

async def test_add_note_while_running_lands_in_log_and_later_in_retry_prompt(workspace):
    """add_note() разрешён только для status=='running' (office.py::add_note). Полный жизненный
    цикл без подмены внутреннего состояния руками: running -> add_note -> review -> reject ->
    retry() — заметка должна попасть в t.log сразу и в t.prompt при следующем retry()."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    # delay достаточно большой, чтобы гарантированно застать задачу в status=='running'
    # до того, как FakeRunner (4 шага х delay + финальная пауза) успеет её завершить
    office = Office(store, roster, FakeRunner(delay=0.2))
    t = await office.create_task("A", "исходный промпт", workspace["repo"], "michael")

    assert await _wait(lambda: store.get(t.id).status == "running", timeout=1.0)
    ok = await office.add_note(t.id, "не забудь про edge case X")
    assert ok is True
    running_task = store.get(t.id)
    assert any("не забудь про edge case X" in line for line in running_task.log)
    assert "не забудь про edge case X" in running_task.pending_notes

    assert await _wait(lambda: store.get(t.id).status == "review")
    assert await office.reject(t.id, "перепроверь")
    assert store.get(t.id).status == "rejected"

    assert await office.retry(t.id)
    retried = store.get(t.id)
    assert retried.status == "todo"
    assert "не забудь про edge case X" in retried.prompt
    assert retried.pending_notes == []   # перенесённые в prompt заметки очищаются
    # дожидаемся, пока перезапущенный агентом прогон реально завершится — иначе фоновая
    # asyncio-задача Office._run() всё ещё летит, когда тест закончится, и закрытие event loop
    # pytest-asyncio виснет на незавершённом asyncio-subprocess (см. tests/test_office.py::
    # test_queue_per_agent_and_reject_retry — тот же паттерн retry() + ожидание review в конце)
    assert await _wait(lambda: store.get(t.id).status == "review")


@pytest.mark.parametrize("target_status", ["review", "failed"])
async def test_add_note_refused_outside_running_and_does_not_touch_retry(workspace, target_status):
    """Для status в (review, failed) add_note() должен вернуть False и не подменять retry —
    ни лога, ни pending_notes, ни изменения prompt при последующем retry() быть не должно."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    if target_status == "review":
        office = Office(store, roster, FakeRunner(delay=0.01))
        t = await office.create_task("A", "исходный промпт", workspace["repo"], "michael")
        assert await _wait(lambda: store.get(t.id).status == "review")
    else:
        office = Office(store, roster, FakeRunner(delay=0.01, fail_times=99), max_auto_retries=0)
        t = await office.create_task("A", "исходный промпт", workspace["repo"], "michael")
        assert await _wait(lambda: store.get(t.id).status == "failed")

    before = store.get(t.id)
    log_len_before, prompt_before = len(before.log), before.prompt

    ok = await office.add_note(t.id, "просочившаяся заметка")
    assert ok is False
    after = store.get(t.id)
    assert after.status == target_status
    assert len(after.log) == log_len_before   # лог не тронут
    assert after.pending_notes == []

    if target_status == "review":
        assert await office.reject(t.id)
    assert await office.retry(t.id)
    retried = store.get(t.id)
    assert "просочившаяся заметка" not in retried.prompt
    assert retried.prompt == prompt_before or retried.prompt.startswith(prompt_before)
    # дожидаемся, пока перезапущенный прогон реально осядет в терминальном статусе — иначе
    # фоновая asyncio-задача Office._run() всё ещё летит, когда тест закончится, и закрытие
    # event loop pytest-asyncio виснет на незавершённом asyncio-subprocess (см. tests/test_office.py::
    # test_queue_per_agent_and_reject_retry — тот же паттерн retry() + ожидание в конце теста)
    assert await _wait(lambda: store.get(t.id).status == target_status)


# ------------------------------------------------------------ build_summary()

async def test_build_summary_counts_done_tasks_missions_and_cost(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))

    t1 = await office.create_task("A", "a", workspace["repo"], "michael")
    t2 = await office.create_task("B", "b", workspace["repo"], "dwight")
    assert await _wait(lambda: store.get(t1.id).status == "review" and store.get(t2.id).status == "review")
    ok1, _ = await office.approve(t1.id); assert ok1
    ok2, _ = await office.approve(t2.id); assert ok2

    today = store.get(t1.id).updated_at[:10]
    summary = build_summary(store, today)
    assert summary["done_tasks"] == 2
    assert summary["done_missions"] == 0   # задачи созданы вне миссии
    assert summary["cost_usd"] == pytest.approx(0.0)   # FakeRunner не тратит деньги
    assert summary["since"] == today


async def test_build_summary_with_future_date_is_all_zeros(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    t = await office.create_task("A", "a", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "review")
    ok, _ = await office.approve(t.id); assert ok

    summary = build_summary(store, "2999-01-01")
    assert summary == {"since": "2999-01-01", "done_tasks": 0, "done_missions": 0, "cost_usd": 0.0}
