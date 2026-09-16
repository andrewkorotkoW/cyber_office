"""app.core.lock: второй захват той же блокировки должен падать на текущей ОС
(fcntl на POSIX, msvcrt на Windows — сам тест ничего не мокает, гоняет реальный API)."""
from __future__ import annotations

from app.core import lock


def test_second_acquire_fails_while_first_held(tmp_path):
    path = tmp_path / "server.lock"
    fh1 = lock.acquire(path)
    try:
        try:
            lock.acquire(path)
            assert False, "второй захват той же блокировки должен был упасть"
        except lock.LockHeld:
            pass
    finally:
        fh1.close()


def test_acquire_succeeds_again_after_release(tmp_path):
    path = tmp_path / "server.lock"
    fh1 = lock.acquire(path)
    fh1.close()
    fh2 = lock.acquire(path)
    fh2.close()


def test_acquire_writes_placeholder_byte(tmp_path):
    """msvcrt.locking на Windows требует хотя бы 1 байт в файле — acquire() пишет
    его сама на обеих ОС, до того как вызывающий код запишет туда свой pid."""
    path = tmp_path / "server.lock"
    fh = lock.acquire(path)
    try:
        assert path.read_text() == "0"
    finally:
        fh.close()
