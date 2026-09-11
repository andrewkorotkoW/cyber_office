"""Память агента — markdown-файл на агента. Читается в системный промпт каждой
задачи, дописывается после каждой задачи. Просто, прозрачно, правится руками."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from app.config import AGENTS_DIR

MAX_CHARS_IN_PROMPT = 6000


def path(agent: str) -> Path:
    p = AGENTS_DIR / agent / "MEMORY.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_text(f"# Память агента {agent}\n\nЗаписи добавляются после каждой задачи.\n", encoding="utf-8")
    return p


def read(agent: str) -> str:
    text = path(agent).read_text(encoding="utf-8")
    return text[-MAX_CHARS_IN_PROMPT:] if len(text) > MAX_CHARS_IN_PROMPT else text


def append(agent: str, task_title: str, repo: str, summary: str) -> None:
    summary = " ".join(summary.split())[:600]
    with path(agent).open("a", encoding="utf-8") as fh:
        fh.write(f"\n## {datetime.now():%Y-%m-%d %H:%M} · {task_title}\nРепо: {repo}\n{summary}\n")
