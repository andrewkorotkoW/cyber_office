"""app.core.allure.open_in_browser: заменяет старый жёстко macOS-шный
subprocess.Popen(["open", ...]) — на Windows os.startfile, на Linux xdg-open (или
webbrowser.open, если его нет в PATH), на macOS прежнее поведение через `open`."""
from __future__ import annotations

from pathlib import Path

from app.core import allure


def test_open_in_browser_uses_startfile_on_windows(monkeypatch):
    monkeypatch.setattr(allure.sys, "platform", "win32")
    calls = []
    monkeypatch.setattr(allure.os, "startfile", lambda p: calls.append(p), raising=False)
    allure.open_in_browser(Path("/report/index.html"))
    assert calls == ["/report/index.html"]


def test_open_in_browser_uses_open_on_macos(monkeypatch):
    monkeypatch.setattr(allure.sys, "platform", "darwin")
    calls = []
    monkeypatch.setattr(allure.subprocess, "Popen", lambda args: calls.append(args))
    allure.open_in_browser(Path("/report/index.html"))
    assert calls == [["open", "/report/index.html"]]


def test_open_in_browser_uses_xdg_open_on_linux_when_available(monkeypatch):
    monkeypatch.setattr(allure.sys, "platform", "linux")
    monkeypatch.setattr(allure.shutil, "which", lambda name: "/usr/bin/xdg-open" if name == "xdg-open" else None)
    calls = []
    monkeypatch.setattr(allure.subprocess, "Popen", lambda args: calls.append(args))
    allure.open_in_browser(Path("/report/index.html"))
    assert calls == [["/usr/bin/xdg-open", "/report/index.html"]]


def test_open_in_browser_falls_back_to_webbrowser_on_linux_without_xdg_open(monkeypatch):
    monkeypatch.setattr(allure.sys, "platform", "linux")
    monkeypatch.setattr(allure.shutil, "which", lambda name: None)
    calls = []
    monkeypatch.setattr(allure.webbrowser, "open", lambda uri: calls.append(uri))
    allure.open_in_browser(Path("/report/index.html"))
    assert calls == [Path("/report/index.html").as_uri()]
