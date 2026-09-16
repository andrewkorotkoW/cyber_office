"""Пути и настройки. Всё рантайм-состояние живёт в workspace/ — его можно снести и начать заново."""
from __future__ import annotations

import os
import shutil
import sys
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


def find_claude_bin() -> str:
    """AO_CLAUDE_BIN, если задан, побеждает всё остальное. Иначе — `claude` в PATH
    (на Windows ищем claude.cmd/claude.exe: так CLI ставится там обычно), и только
    если нигде не нашли — старый путь ~/.local/bin, даже если по нему пусто (чтобы
    было что показать в понятной ошибке при старте, см. app.main.main)."""
    env = os.getenv("AO_CLAUDE_BIN")
    if env:
        return env
    names = ("claude.cmd", "claude.exe", "claude") if sys.platform == "win32" else ("claude",)
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    local_name = "claude.exe" if sys.platform == "win32" else "claude"
    return str(Path.home() / ".local" / "bin" / local_name)


CLAUDE_BIN = find_claude_bin()
DEFAULT_MODEL = os.getenv("AO_MODEL", "sonnet")
MAX_TURNS = int(os.getenv("AO_MAX_TURNS", "100"))   # 40 не хватало на обзор проекта в 2000 строк
AO_TASK_TIMEOUT = int(os.getenv("AO_TASK_TIMEOUT", "5400"))   # 90 мин — потолок на claude -p одной задачи
AO_PLAN_TIMEOUT = int(os.getenv("AO_PLAN_TIMEOUT", "900"))    # 15 мин — потолок на планирование миссии
HOST = os.getenv("AO_HOST", "127.0.0.1")
# Telegram-мост: токен бота и список tg_id, кому можно командовать (пусто = мост выключен)
TG_TOKEN = os.getenv("AO_TG_TOKEN", "")
TG_ADMINS = {int(x) for x in os.getenv("AO_TG_ADMINS", "").replace(";", ",").split(",") if x.strip().isdigit()}
PORT = int(os.getenv("AO_PORT", "8600"))
# Путь к бинарнику Allure CLI (не логируется). Пусто/не найден — просто нет кнопки "Открыть в Allure".
ALLURE_BIN = os.getenv("AO_ALLURE_BIN", "")


def ensure_dirs() -> None:
    for d in (WORKSPACE, AGENTS_DIR, LOGS_DIR, WORKTREES_DIR):
        d.mkdir(parents=True, exist_ok=True)
