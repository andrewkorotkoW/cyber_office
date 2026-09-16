"""Путь к бинарникам .venv целевого репозитория: на POSIX — .venv/bin/<name>, на
Windows — .venv/Scripts/<name>.exe. sys.platform читается при каждом вызове (не
на импорте), чтобы тесты могли переключать ОС через monkeypatch."""
from __future__ import annotations

import sys
from pathlib import Path


def venv_bin(repo: str | Path, name: str) -> Path:
    if sys.platform == "win32":
        return Path(repo) / ".venv" / "Scripts" / f"{name}.exe"
    return Path(repo) / ".venv" / "bin" / name


def venv_python(repo: str | Path) -> Path:
    return venv_bin(repo, "python")
