"""Кроссплатформенная эксклюзивная блокировка одного файла: второй сервер на том же
workspace не должен стартовать и затереть tasks.json. POSIX — fcntl.flock, Windows —
msvcrt.locking (blocking-режим здесь не нужен, оба варианта неблокирующие)."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import IO


class LockHeld(Exception):
    """Файл уже держит эксклюзивную блокировку другой процесс."""


def acquire(path: Path) -> IO[str]:
    """Открывает path и блокирует эксклюзивно без ожидания. Возвращает открытый
    файловый хендл — держать его открытым, пока нужна блокировка (закрытие хендла
    или завершение процесса её снимает). Бросает LockHeld, если файл уже занят."""
    fh = open(path, "w+")
    fh.write("0"); fh.flush(); fh.seek(0)   # msvcrt.locking требует хотя бы 1 байт в файле
    try:
        if sys.platform == "win32":
            import msvcrt
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise LockHeld(str(exc)) from exc
        else:
            import fcntl
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise LockHeld(str(exc)) from exc
    except LockHeld:
        fh.close()
        raise
    return fh
