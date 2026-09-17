"""Создание нового проекта прямо из офиса (окно миссии/задачи, кнопка «Репозиторий»,
Telegram /newproject) — чтобы миссии и задачи под новую идею не приземлялись по ошибке
в чужой репозиторий. См. README «Новый проект из офиса»."""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

from app.core.events import bus

log = logging.getLogger(__name__)

NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
TEMPLATES = ("python", "web", "empty")

GITIGNORE = {
    "python": "__pycache__/\n*.pyc\n.venv/\n.pytest_cache/\n",
    "web": "node_modules/\ndist/\n.env\n",
    "empty": "",
}

SMOKE_TEST = '''def test_smoke():
    # проект создан и pytest его видит
    assert True
'''


async def _run(cwd: Path, *args: str) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=str(cwd), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    return proc.returncode, out.decode("utf-8", errors="replace").strip()


async def create(projects_dir: Path, name: str, description: str, template: str) -> str:
    """Создаёт <projects_dir>/<name>: git init -b main, README (название + описание),
    .gitignore под шаблон, для "python" — пустой requirements.txt и tests/ со smoke-тестом,
    первый коммит. Возвращает абсолютный путь. ValueError — понятная причина для 400."""
    name = (name or "").strip()
    if not NAME_RE.match(name):
        raise ValueError("имя проекта — только латиница, цифры, «_» и «-»")
    if template not in TEMPLATES:
        raise ValueError(f"неизвестный шаблон: {template}")
    path = Path(projects_dir) / name
    if path.exists():
        raise ValueError(f"{path} уже существует")
    projects_dir = Path(projects_dir)
    projects_dir.mkdir(parents=True, exist_ok=True)
    path.mkdir()
    code, out = await _run(path, "git", "init", "-q", "-b", "main")
    if code != 0:
        raise ValueError(f"git init: {out}")
    description = (description or "").strip()
    (path / "README.md").write_text(f"# {name}\n\n{description}\n" if description else f"# {name}\n",
                                     encoding="utf-8")
    (path / ".gitignore").write_text(GITIGNORE[template], encoding="utf-8")
    if template == "python":
        (path / "requirements.txt").write_text("", encoding="utf-8")
        tests_dir = path / "tests"
        tests_dir.mkdir()
        (tests_dir / "test_smoke.py").write_text(SMOKE_TEST, encoding="utf-8")
    await _run(path, "git", "add", "-A")
    code, out = await _run(path, "git", "-c", "user.name=cyber_office", "-c", "user.email=agent@office.local",
                            "commit", "-q", "-m", "начало проекта")
    if code != 0:
        raise ValueError(f"git commit: {out}")
    return str(path)


async def setup_venv(path: str) -> None:
    """`python3 -m venv .venv` в фоне (вызывающий код запускает это через asyncio.create_task,
    не дожидаясь), чтобы POST /api/repos/new не блокировался на секунды создания окружения.
    Событие repo.ready сообщает интерфейсу, что .venv готов (или почему не вышло —
    репозиторий при этом уже зарегистрирован и им можно пользоваться без .venv)."""
    code, out = await _run(Path(path), "python3", "-m", "venv", ".venv")
    if code != 0:
        log.warning("не удалось создать .venv для %s: %s", path, out)
    await bus.emit("repo.ready", None, None, path=path, ok=code == 0, output="" if code == 0 else out[-400:])
