"""Пути и настройки. Всё рантайм-состояние живёт в workspace/ — его можно снести и начать заново."""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = Path(os.getenv("AO_WORKSPACE", ROOT / "workspace"))
AGENTS_DIR = WORKSPACE / "agents"
LOGS_DIR = WORKSPACE / "logs"
WORKTREES_DIR = WORKSPACE / "worktrees"
TASKS_FILE = WORKSPACE / "tasks.json"
ROSTER_FILE = WORKSPACE / "roster.json"

CLAUDE_BIN = os.getenv("AO_CLAUDE_BIN", str(Path.home() / ".local/bin/claude"))
DEFAULT_MODEL = os.getenv("AO_MODEL", "sonnet")
MAX_TURNS = int(os.getenv("AO_MAX_TURNS", "100"))   # 40 не хватало на обзор проекта в 2000 строк
HOST = os.getenv("AO_HOST", "127.0.0.1")
# Telegram-мост: токен бота и список tg_id, кому можно командовать (пусто = мост выключен)
TG_TOKEN = os.getenv("AO_TG_TOKEN", "")
TG_ADMINS = {int(x) for x in os.getenv("AO_TG_ADMINS", "").replace(";", ",").split(",") if x.strip().isdigit()}
PORT = int(os.getenv("AO_PORT", "8600"))


def ensure_dirs() -> None:
    for d in (WORKSPACE, AGENTS_DIR, LOGS_DIR, WORKTREES_DIR):
        d.mkdir(parents=True, exist_ok=True)
