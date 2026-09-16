"""app.core.worktree._link_one: fallback, когда symlink недоступен (типичный случай —
Windows без прав разработчика). Каталог -> junction (mklink /J), файл -> копия.
Сам symlink_to подделываем через monkeypatch, чтобы тест не зависел от прав ОС,
на которой реально гоняется pytest."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.core import worktree


def _fail_symlink(self, target):
    raise OSError("symlink недоступен (нет прав)")


async def test_link_one_returns_false_on_posix_without_symlink_rights(tmp_path, monkeypatch):
    monkeypatch.setattr(worktree.sys, "platform", "linux")
    monkeypatch.setattr(Path, "symlink_to", _fail_symlink)
    src = tmp_path / "src"; src.mkdir()
    dst = tmp_path / "dst"
    assert await worktree._link_one(src, dst) is False
    assert not dst.exists()


async def test_link_one_falls_back_to_junction_for_dir_on_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(worktree.sys, "platform", "win32")
    monkeypatch.setattr(Path, "symlink_to", _fail_symlink)
    src = tmp_path / "src"; src.mkdir()
    dst = tmp_path / "dst"

    calls = []

    class FakeProc:
        async def wait(self):
            return 0

    async def fake_exec(*args, **kwargs):
        calls.append(args)
        dst.mkdir()   # имитирует результат успешного `mklink /J`
        return FakeProc()

    monkeypatch.setattr(worktree.asyncio, "create_subprocess_exec", fake_exec)
    assert await worktree._link_one(src, dst) is True
    assert calls[0][:3] == ("cmd", "/c", "mklink")
    assert dst.exists()


async def test_link_one_reports_failure_when_junction_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(worktree.sys, "platform", "win32")
    monkeypatch.setattr(Path, "symlink_to", _fail_symlink)
    src = tmp_path / "src"; src.mkdir()
    dst = tmp_path / "dst"

    class FakeProc:
        async def wait(self):
            return 1

    async def fake_exec(*args, **kwargs):
        return FakeProc()   # mklink "упал", dst не создан

    monkeypatch.setattr(worktree.asyncio, "create_subprocess_exec", fake_exec)
    assert await worktree._link_one(src, dst) is False


async def test_link_one_falls_back_to_copy_for_file_on_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(worktree.sys, "platform", "win32")
    monkeypatch.setattr(Path, "symlink_to", _fail_symlink)
    src = tmp_path / ".env"; src.write_text("SECRET=1\n", encoding="utf-8")
    dst = tmp_path / "worktree" / ".env"
    dst.parent.mkdir()

    assert await worktree._link_one(src, dst) is True
    assert dst.read_text(encoding="utf-8") == "SECRET=1\n"
    assert not dst.is_symlink()
