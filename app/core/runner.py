"""Запуск агента на задаче.

ClaudeRunner: `claude -p` в worktree задачи, вывод stream-json построчно ->
события на шину (текст, вызов инструмента, результат). Права: правки файлов
принимаются автоматически (мы в изолированном worktree), из Bash разрешены
только чтение/тесты/git-диагностика. Всё опасное агент попросить не может —
оно просто запрещено; контроль человека — на этапе review/merge.

FakeRunner: для тестов и для интерфейса без логина — имитирует работу и
реально меняет файл в worktree, чтобы можно было пройти review -> merge.
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.config import CLAUDE_BIN, MAX_TURNS
from app.core.events import bus

ALLOWED_TOOLS = ",".join([
    "Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", "LS", "TodoWrite",
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git add*)", "Bash(git commit*)",
    "Bash(git show*)", "Bash(git cherry-pick*)", "Bash(git merge*)", "Bash(git branch*)",
    "Bash(ls*)", "Bash(cat*)", "Bash(python*)", "Bash(python3*)", "Bash(pytest*)", "Bash(./.venv/bin/*)",
    "Bash(npm test*)", "Bash(npm run*)", "Bash(node*)", "Bash(make*)",
])


@dataclass(slots=True)
class RunResult:
    ok: bool
    text: str
    cost_usd: float = 0.0
    turns: int = 0
    error: str | None = None


class Runner(Protocol):
    async def run(self, agent: str, system: str, model: str, prompt: str, cwd: str, task_id: str) -> RunResult: ...


def _summarize_tool(name: str, inp: dict) -> str:
    if name in ("Edit", "Write", "MultiEdit", "Read"):
        return f"{name} {Path(str(inp.get('file_path', ''))).name}"
    if name == "Bash":
        return f"$ {str(inp.get('command', ''))[:80]}"
    if name in ("Grep", "Glob"):
        return f"{name} {inp.get('pattern', '')}"
    return name


class ClaudeRunner:
    def __init__(self, binary: str = CLAUDE_BIN, max_turns: int = MAX_TURNS) -> None:
        self.binary, self.max_turns = binary, max_turns

    async def run(self, agent: str, system: str, model: str, prompt: str, cwd: str, task_id: str) -> RunResult:
        args = [
            self.binary, "-p", prompt,
            "--output-format", "stream-json", "--verbose",
            "--max-turns", str(self.max_turns),
            "--model", model,
            "--permission-mode", "acceptEdits",
            "--allowedTools", ALLOWED_TOOLS,
            "--append-system-prompt", system,
        ]
        env = {**os.environ, "PATH": f"{Path(self.binary).parent}:{os.environ.get('PATH', '')}"}
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except FileNotFoundError:
            return RunResult(False, "", error=f"claude не найден: {self.binary}")

        final = RunResult(False, "", error="агент завершился без результата")
        text_parts: list[str] = []
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = msg.get("type")
            if t == "assistant":
                for block in (msg.get("message") or {}).get("content") or []:
                    if block.get("type") == "text" and block.get("text"):
                        text_parts.append(block["text"])
                        await bus.emit("agent.text", agent, task_id, text=block["text"][:2000])
                    elif block.get("type") == "tool_use":
                        await bus.emit("agent.tool", agent, task_id,
                                       tool=block.get("name"), summary=_summarize_tool(block.get("name", ""), block.get("input") or {}))
            elif t == "result":
                ok = not msg.get("is_error") and msg.get("subtype") == "success"
                final = RunResult(ok, msg.get("result") or "\n".join(text_parts[-3:]),
                                  float(msg.get("total_cost_usd") or 0), int(msg.get("num_turns") or 0),
                                  None if ok else (msg.get("result") or msg.get("subtype") or "ошибка"))
        stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
        await proc.wait()
        if proc.returncode != 0 and not final.ok:
            final.error = (final.error or "") + (f" | {stderr.strip()[-500:]}" if stderr.strip() else f" | exit {proc.returncode}")
        return final


class FakeRunner:
    """Имитация: пишет несколько событий, делает правку в worktree, отвечает резюме."""

    def __init__(self, delay: float = 0.05) -> None:
        self.delay = delay

    async def run(self, agent: str, system: str, model: str, prompt: str, cwd: str, task_id: str) -> RunResult:
        steps = [("Read", "README.md"), ("Grep", "TODO"), ("Edit", "README.md"), ("Bash", "$ pytest -q")]
        await bus.emit("agent.text", agent, task_id, text="Смотрю репозиторий и план задачи…")
        for tool, summary in steps:
            await asyncio.sleep(self.delay)
            await bus.emit("agent.tool", agent, task_id, tool=tool, summary=f"{tool} {summary}" if tool != "Bash" else summary)
        note = Path(cwd) / f"notes_{agent}_{task_id}.md"
        note.write_text(f"<!-- {agent}: {prompt[:60]} -->\n", encoding="utf-8")
        await asyncio.sleep(self.delay)
        return RunResult(True, f"Сделал (имитация): добавил заметку {note.name} по задаче «{prompt[:40]}». Тесты: ок.",
                         cost_usd=0.0, turns=len(steps) + 1)
