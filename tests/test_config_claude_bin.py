"""app.config.find_claude_bin: AO_CLAUDE_BIN побеждает всё, иначе PATH (shutil.which,
на Windows claude.cmd/claude.exe), иначе ~/.local/bin как последний вариант — даже
если там пусто, чтобы было что показать в ошибке при старте (app.main.main)."""
from __future__ import annotations

from pathlib import Path

from app import config


def test_env_var_wins_over_everything(monkeypatch):
    monkeypatch.setenv("AO_CLAUDE_BIN", "/custom/claude")
    monkeypatch.setattr(config.shutil, "which", lambda name: "/usr/bin/claude")
    assert config.find_claude_bin() == "/custom/claude"


def test_finds_claude_in_path_posix(monkeypatch):
    monkeypatch.delenv("AO_CLAUDE_BIN", raising=False)
    monkeypatch.setattr(config.sys, "platform", "linux")
    monkeypatch.setattr(config.shutil, "which", lambda name: "/usr/local/bin/claude" if name == "claude" else None)
    assert config.find_claude_bin() == "/usr/local/bin/claude"


def test_finds_claude_cmd_in_path_windows(monkeypatch):
    monkeypatch.delenv("AO_CLAUDE_BIN", raising=False)
    monkeypatch.setattr(config.sys, "platform", "win32")
    which_calls = []

    def fake_which(name):
        which_calls.append(name)
        return r"C:\Users\x\AppData\Roaming\npm\claude.cmd" if name == "claude.cmd" else None

    monkeypatch.setattr(config.shutil, "which", fake_which)
    result = config.find_claude_bin()
    assert result == r"C:\Users\x\AppData\Roaming\npm\claude.cmd"
    assert which_calls[0] == "claude.cmd"   # .cmd/.exe проверяются раньше голого имени


def test_falls_back_to_local_bin_when_not_in_path(monkeypatch):
    monkeypatch.delenv("AO_CLAUDE_BIN", raising=False)
    monkeypatch.setattr(config.sys, "platform", "linux")
    monkeypatch.setattr(config.shutil, "which", lambda name: None)
    assert config.find_claude_bin() == str(Path.home() / ".local" / "bin" / "claude")


def test_falls_back_to_local_bin_exe_on_windows(monkeypatch):
    monkeypatch.delenv("AO_CLAUDE_BIN", raising=False)
    monkeypatch.setattr(config.sys, "platform", "win32")
    monkeypatch.setattr(config.shutil, "which", lambda name: None)
    assert config.find_claude_bin() == str(Path.home() / ".local" / "bin" / "claude.exe")
