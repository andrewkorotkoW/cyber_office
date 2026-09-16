"""Пункт 8 «Надёжность»: Office.delete_task() и Office.run_after_merge() — общие операции,
перенесённые из app/main.py и app/telegram.py в Office (коммиты 54dfa83/f7071fe), чтобы не
дублировать логику в двух местах. Ни один из этих двух методов раньше не имел прямого теста
на уровне Office (только REST /api/tasks/{id} DELETE для одного сценария — running, см.
tests/test_stop_and_lifecycle.py); здесь — остальные статусы и run_after_merge целиком:
успех, ошибка, отсутствие команды и (что не было покрыто вовсе) таймаут 120с с убийством
process group."""
from __future__ import annotations

import asyncio
import os
import subprocess

import pytest

import app.core.office as office_module
from app.core import procs
from app.core.events import bus
from app.core.office import Office
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


def _branch_exists(repo: str, branch: str) -> bool:
    out = subprocess.run(["git", "branch", "--list", branch], cwd=repo,
                         capture_output=True, text=True).stdout
    return branch in out


# ------------------------------------------------------------ Office.delete_task()

async def test_delete_task_unknown_id_returns_false(workspace):
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    assert await office.delete_task("does-not-exist") is False


async def test_delete_task_todo_queued_behind_another_task(workspace):
    """Задача, которая ещё не стартовала (ждёт в очереди у занятого агента): branch/worktree
    ещё None — delete_task не должен падать на worktree.remove(None, None, ...) и просто
    убирает задачу из хранилища."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.3))
    t1 = await office.create_task("Первая", "занимает агента", workspace["repo"], "michael")
    t2 = await office.create_task("Вторая", "ждёт своей очереди", workspace["repo"], "michael")
    assert store.get(t2.id).status == "todo" and store.get(t2.id).branch is None

    assert await office.delete_task(t2.id) is True
    assert store.get(t2.id) is None

    assert await _wait(lambda: store.get(t1.id).status == "review")   # первую задачу не задело


async def test_delete_task_running_stops_it_cleans_worktree_and_leaves_no_dangling_task(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.4))
    t = await office.create_task("Долгая", "текст", workspace["repo"], "michael")
    # status флипается в 'running' до создания worktree (см. office._run) — ждём ещё и branch,
    # иначе можно застать окно, где статус уже running, а branch/worktree ещё None
    assert await _wait(lambda: store.get(t.id).status == "running" and store.get(t.id).branch)
    branch, worktree_path = store.get(t.id).branch, store.get(t.id).worktree
    assert branch and worktree_path and os.path.isdir(worktree_path)

    assert await office.delete_task(t.id) is True

    assert store.get(t.id) is None                     # задачи больше нет
    assert "michael" not in office._running             # не осталось висящей asyncio.Task
    assert roster.get("michael").state == "idle"
    assert not os.path.isdir(worktree_path)             # worktree убран
    assert not _branch_exists(workspace["repo"], branch)   # и ветка удалена


async def test_delete_task_in_review_cleans_worktree_and_branch(workspace):
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    office = Office(store, roster, FakeRunner(delay=0.01))
    t = await office.create_task("Готова к ревью", "текст", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "review")
    branch, worktree_path = store.get(t.id).branch, store.get(t.id).worktree

    assert await office.delete_task(t.id) is True
    assert store.get(t.id) is None
    assert not os.path.isdir(worktree_path)
    assert not _branch_exists(workspace["repo"], branch)


async def test_delete_task_failed_cancels_pending_auto_retry(workspace):
    """delete_task на упавшей задаче с запланированным автоповтором должен отменить таймер —
    иначе он позже дёрнет retry() на уже удалённую (несуществующую) задачу."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    runner = FakeRunner(delay=0.01, fail_times=99)
    office = Office(store, roster, runner, auto_retry_delays=(5.0, 5.0, 5.0), max_auto_retries=3)
    t = await office.create_task("Упадёт", "текст", workspace["repo"], "michael")
    assert await _wait(lambda: store.get(t.id).status == "failed")
    assert t.id in office._auto_retry
    branch, worktree_path = store.get(t.id).branch, store.get(t.id).worktree

    assert await office.delete_task(t.id) is True
    assert t.id not in office._auto_retry
    assert store.get(t.id) is None
    assert not os.path.isdir(worktree_path)
    assert not _branch_exists(workspace["repo"], branch)


# ------------------------------------------------------------ Office.run_after_merge()

async def test_run_after_merge_noop_without_command(workspace):
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    events = []
    async def listen(ev):
        if ev.kind == "repo.after_merge":
            events.append(ev.data)
    bus.subscribe(listen)
    try:
        await office.run_after_merge(workspace["repo"], "task1", None)
        await asyncio.sleep(0.05)
        assert events == []
    finally:
        bus.unsubscribe(listen)


async def test_run_after_merge_success_emits_event_and_untracks_process(workspace):
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    events = []
    async def listen(ev):
        if ev.kind == "repo.after_merge":
            events.append(ev.data)
    bus.subscribe(listen)
    try:
        await office.run_after_merge(workspace["repo"], "task1", "echo hello-after-merge")
        assert await _wait(lambda: len(events) == 1)
        assert events[0]["ok"] is True
        assert events[0]["repo"] == workspace["repo"]
        assert "hello-after-merge" in events[0]["output"]
        assert procs._active == set()          # процесс снят с учёта после завершения
    finally:
        bus.unsubscribe(listen)


async def test_run_after_merge_nonzero_exit_reports_ok_false(workspace):
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    events = []
    async def listen(ev):
        if ev.kind == "repo.after_merge":
            events.append(ev.data)
    bus.subscribe(listen)
    try:
        await office.run_after_merge(workspace["repo"], "task1", "echo boom-output; exit 7")
        assert await _wait(lambda: len(events) == 1)
        assert events[0]["ok"] is False
        assert "boom-output" in events[0]["output"]
        assert procs._active == set()
    finally:
        bus.unsubscribe(listen)


async def test_run_after_merge_timeout_kills_process_group_and_reports(workspace, monkeypatch):
    """У run_after_merge жёстко зашит таймаут 120с (app/core/office.py) — не было ни одного
    теста, что он реально срабатывает и убивает всю process group, а не просто повисает.
    120 реальных секунд ждать в тесте нельзя — подменяем asyncio.wait_for так, чтобы вызов
    именно с timeout=120 (тот самый, из run_after_merge) сработал за 0.3с, а остальные вызовы
    (если есть) шли как обычно."""
    from app import config
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner())
    events = []
    async def listen(ev):
        if ev.kind == "repo.after_merge":
            events.append(ev.data)
    bus.subscribe(listen)

    orig_wait_for = asyncio.wait_for
    async def shortened_wait_for(fut, timeout=None):
        return await orig_wait_for(fut, timeout=0.3 if timeout == 120 else timeout)
    monkeypatch.setattr(office_module.asyncio, "wait_for", shortened_wait_for)

    try:
        started = asyncio.get_event_loop().time()
        # спит намного дольше подменённого таймаута и плодит дочерний процесс — как и
        # tests/test_runner_timeout.py, проверяем, что убивается вся группа, а не только шелл
        await office.run_after_merge(workspace["repo"], "task1",
                                     "sleep 30 & echo $! > child.pid; wait")
        elapsed = asyncio.get_event_loop().time() - started
        assert elapsed < 5

        assert await _wait(lambda: len(events) == 1)
        assert events[0]["ok"] is False
        assert "таймаут" in events[0]["output"]
        assert procs._active == set()

        child_pid_file = os.path.join(workspace["repo"], "child.pid")
        assert await _wait(lambda: os.path.exists(child_pid_file), timeout=2.0)
        child_pid = int(open(child_pid_file).read().strip())
        for _ in range(100):
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.05)
        else:
            pytest.fail(f"дочерний sleep {child_pid} всё ещё жив после таймаута after_merge")
    finally:
        bus.unsubscribe(listen)
