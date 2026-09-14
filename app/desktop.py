"""Окно macOS для agent_office: сервер FastAPI в фоновом потоке + WKWebView с интерфейсом.

    .venv/bin/python -m app.desktop            # реальные агенты
    AO_FAKE=1 .venv/bin/python -m app.desktop  # имитация

Из .app-бандла запускается этот же модуль (см. scripts/build_app.sh).
"""
from __future__ import annotations

import logging
import sys
import threading
import time
import urllib.request
from pathlib import Path

import uvicorn
import webview

from app import config
from app.main import acquire_lock, app as fastapi_app

log = logging.getLogger("agent_office.desktop")
ICON = config.ROOT / "assets" / "icon.png"


def _serve(port: int) -> None:
    acquire_lock()
    uvicorn.run(fastapi_app, host=config.HOST, port=port, log_level="warning")


def _wait_ready(url: str, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1).read(1); return True
        except Exception:
            time.sleep(0.2)
    return False


def _set_dock_icon() -> None:
    """Из .app-бандла процесс — python, и Dock показал бы ракету Python; ставим свою иконку."""
    try:
        from AppKit import NSApplication, NSImage
        if ICON.exists():
            NSApplication.sharedApplication().setApplicationIconImage_(NSImage.alloc().initWithContentsOfFile_(str(ICON)))
    except Exception:
        log.debug("Dock icon not set", exc_info=True)


def _set_app_name() -> None:
    """Имя в меню-баре: без этого macOS пишет «Python», потому что процесс — интерпретатор."""
    try:
        from Foundation import NSBundle
        info = NSBundle.mainBundle().infoDictionary()
        info["CFBundleName"] = "cyber_office"
        info["CFBundleDisplayName"] = "cyber_office"
    except Exception:
        log.debug("app name not set", exc_info=True)


def _server_alive(url: str) -> bool:
    try:
        return b"agents" in urllib.request.urlopen(url + "api/state", timeout=1).read(200)
    except Exception:
        return False


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    _set_app_name()
    url = f"http://{config.HOST}:{config.PORT}/"
    if _server_alive(url):
        # сервер уже запущен (например, из терминала) — окно просто подключается к нему.
        # Два сервера на одном workspace затирали бы tasks.json друг другу.
        log.info("Подключаюсь к работающему серверу %s", url)
    else:
        threading.Thread(target=_serve, args=(config.PORT,), daemon=True).start()
        if not _wait_ready(url):
            print("Сервер не поднялся", file=sys.stderr); sys.exit(1)
    window = webview.create_window("cyber_office", url, width=1380, height=900, min_size=(1000, 680),
                                   background_color="#0e1117")
    webview.start(_set_dock_icon, debug=False)


if __name__ == "__main__":
    main()
