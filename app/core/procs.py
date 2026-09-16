"""Реестр активных групп процессов (claude/pytest/after_merge), запущенных с
start_new_session=True — pgid совпадает с pid. Runner/Planner/testlab регистрируют
свой процесс на время жизни и снимают с учёта по завершении (успех/таймаут/отмена).

Нужен для чистого выключения сервера (app.main lifespan shutdown): если сервер
остановили посреди работы агента или прогона тестов, дочерний процесс не должен
остаться сиротой — при shutdown убиваем всё, что ещё числится в реестре.
"""
from __future__ import annotations

import os
import signal

_active: set[int] = set()


def track(pgid: int) -> None:
    _active.add(pgid)


def untrack(pgid: int) -> None:
    _active.discard(pgid)


def killall() -> None:
    for pgid in list(_active):
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    _active.clear()
