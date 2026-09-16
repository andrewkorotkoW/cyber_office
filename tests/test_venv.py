"""app.core.venv: путь к бинарникам .venv репозитория по ОС — venv_bin читает
sys.platform при каждом вызове, поэтому monkeypatch переключает поведение без reload."""
from __future__ import annotations

from app.core import venv


def test_venv_python_posix(monkeypatch):
    monkeypatch.setattr(venv.sys, "platform", "linux")
    assert venv.venv_python("/repo") == venv.Path("/repo/.venv/bin/python")


def test_venv_python_darwin(monkeypatch):
    monkeypatch.setattr(venv.sys, "platform", "darwin")
    assert venv.venv_python("/repo") == venv.Path("/repo/.venv/bin/python")


def test_venv_python_windows(monkeypatch):
    monkeypatch.setattr(venv.sys, "platform", "win32")
    assert venv.venv_python("/repo") == venv.Path("/repo/.venv/Scripts/python.exe")


def test_venv_bin_windows_adds_exe_suffix(monkeypatch):
    monkeypatch.setattr(venv.sys, "platform", "win32")
    assert venv.venv_bin("/repo", "streamlit") == venv.Path("/repo/.venv/Scripts/streamlit.exe")


def test_venv_bin_posix_no_suffix(monkeypatch):
    monkeypatch.setattr(venv.sys, "platform", "linux")
    assert venv.venv_bin("/repo", "streamlit") == venv.Path("/repo/.venv/bin/streamlit")
