"""Пункт 3 «Надёжность»: claude -p / планировщик без таймаута = зависший агент до рестарта
сервера (см. docs/review_2026-09-16.md, п.3). ClaudeRunner.run и ClaudePlanner.plan оборачивают
подпроцесс в asyncio.wait_for(timeout=config.AO_TASK_TIMEOUT / AO_PLAN_TIMEOUT) и по таймауту
убивают всю process group (os.killpg, т.к. подпроцесс запущен с start_new_session=True — свой
pgid, см. app/core/runner.py и app/core/planner.py). Тесты ниже подставляют вместо настоящего
`claude` тестовый скрипт, который просто спит дольше таймаута и по дороге плодит дочерний процесс
(имитация того, что claude/pytest могут порождать под собой другие процессы) — и проверяют, что
после таймаута оба процесса реально мертвы (os.kill(pid, 0) -> ProcessLookupError), а не просто
что RunResult(ok=False) вернулся."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from pathlib import Path

import pytest

from app import config
from app.core.planner import ClaudePlanner
from app.core.runner import ClaudeRunner

pytestmark = pytest.mark.asyncio

# Пишет свой pid и pid дочернего процесса в pids.json (в текущей рабочей директории — единственный
# канал передачи данных наружу, т.к. ClaudeRunner/ClaudePlanner сами формируют argv и не оставляют
# места для лишних аргументов), затем спит намного дольше любого разумного тестового таймаута.
HANG_SCRIPT = """#!/usr/bin/env python3
import json, os, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
# пишем через os.rename (атомарно на одной ФС) — иначе читающая сторона может застать
# файл уже созданным, но ещё пустым (open(..., 'w') создаёт файл раньше, чем json.dump
# успевает в него что-то записать)
with open("pids.json.tmp", "w") as f:
    json.dump({"pid": os.getpid(), "child_pid": child.pid}, f)
    f.flush()
os.replace("pids.json.tmp", "pids.json")
time.sleep(120)
"""


@pytest.fixture
def hang_bin(tmp_path) -> Path:
    p = tmp_path / "hang_claude.py"
    p.write_text(HANG_SCRIPT, encoding="utf-8")
    p.chmod(0o755)
    return p


def _read_pids(tmp_path: Path, timeout: float = 10.0) -> dict:
    pidfile = tmp_path / "pids.json"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pidfile.exists():
            try:
                return json.loads(pidfile.read_text())
            except json.JSONDecodeError:
                pass
        time.sleep(0.02)
    raise AssertionError("хвостовой процесс не успел записать pids.json — тест окружения, не таймаута")


def _assert_process_gone(pid: int, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    pytest.fail(f"процесс {pid} всё ещё жив после таймаута и os.killpg")


async def test_claude_runner_timeout_returns_failed_result_and_kills_process_group(tmp_path, hang_bin, monkeypatch):
    monkeypatch.setattr(config, "AO_TASK_TIMEOUT", 1.0)
    runner = ClaudeRunner(binary=str(hang_bin))

    started = time.monotonic()
    res = await runner.run("michael", "system", "sonnet", "сделай что-нибудь", str(tmp_path), "task1")
    elapsed = time.monotonic() - started

    assert res.ok is False
    assert "таймаут" in (res.error or "")
    assert elapsed < 10   # не зависли на 120с сна хвостового скрипта

    pids = _read_pids(tmp_path)
    _assert_process_gone(pids["pid"])
    _assert_process_gone(pids["child_pid"])   # дочерний процесс тоже убит, не осиротел


async def test_claude_planner_timeout_raises_and_kills_process_group(tmp_path, hang_bin, monkeypatch):
    monkeypatch.setattr(config, "AO_PLAN_TIMEOUT", 1.0)
    planner = ClaudePlanner(binary=str(hang_bin))

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="таймаут"):
        await planner.plan("цель миссии", str(tmp_path), {"michael": "разработчик"})
    elapsed = time.monotonic() - started
    assert elapsed < 10

    pids = _read_pids(tmp_path)
    _assert_process_gone(pids["pid"])
    _assert_process_gone(pids["child_pid"])


async def test_claude_runner_stop_via_cancellation_also_kills_process_group(tmp_path, hang_bin, monkeypatch):
    """Office.stop() отменяет asyncio.Task, что бросает CancelledError внутрь ClaudeRunner.run
    (см. app/core/office.py::Office.stop, app/core/runner.py::ClaudeRunner.run except CancelledError) —
    и это тоже должно убивать процесс, а не просто отсоединяться от него.

    Важно: ждём появления pids.json через `await asyncio.sleep` (не блокирующий time.sleep!) —
    иначе цикл событий никогда не передаст управление только что созданной task, и она не успеет
    даже запустить подпроцесс. А завершение task гарантируем в finally независимо от исхода
    assert'ов — иначе незавершённый asyncio.Task с живым asyncio-subprocess вешает закрытие
    event loop у pytest-asyncio намертво (см. память cyber_office_office_retry_test_hang)."""
    monkeypatch.setattr(config, "AO_TASK_TIMEOUT", 60.0)   # не должен успеть сработать раньше отмены
    runner = ClaudeRunner(binary=str(hang_bin))
    pidfile = tmp_path / "pids.json"

    task = asyncio.create_task(runner.run("michael", "system", "sonnet", "текст", str(tmp_path), "task1"))
    try:
        pids = None
        for _ in range(500):   # до 10с, не блокируя цикл событий (await asyncio.sleep, не time.sleep)
            if pidfile.exists():
                try:
                    pids = json.loads(pidfile.read_text())
                    break
                except json.JSONDecodeError:
                    pass
            await asyncio.sleep(0.02)
        if pids is None:
            raise AssertionError("хвостовой процесс не успел записать pids.json")

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(BaseException):
                await task

    _assert_process_gone(pids["pid"])
    _assert_process_gone(pids["child_pid"])
