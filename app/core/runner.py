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
    "Bash(ls*)", "Bash(cat*)", "Bash(python*)", "Bash(python3*)", "Bash(pytest*)",
    "Bash(./.venv/bin/*)", "Bash(.venv/bin/*)", "Bash(*/.venv/bin/*)",
    "Bash(.venv/Scripts/*)", "Bash(./.venv/Scripts/*)", "Bash(*/.venv/Scripts/*)",   # тот же .venv на Windows
    "Bash(npm test*)", "Bash(npm run*)", "Bash(node*)", "Bash(make*)",
])


@dataclass(slots=True)
class RunResult:
    ok: bool
    text: str
    cost_usd: float = 0.0
    turns: int = 0
    error: str | None = None
    exit_code: int | None = None        # код возврата процесса claude (ClaudeRunner)
    is_error_result: bool = False       # claude сам прислал result с is_error=true (а не просто упал)


class Runner(Protocol):
    async def run(self, agent: str, system: str, model: str, prompt: str, cwd: str, task_id: str) -> RunResult: ...


# Признаки временного сбоя инфраструктуры Claude (не вина промпта/агента) — при них
# есть смысл повторить попытку самим, а не сразу будить владельца.
INFRA_MARKERS = (
    "api error", "failed to authenticate", "rate limit", "overloaded",
    "529", "503", "econnreset",
)


def infra_failure_reason(res: RunResult) -> str | None:
    """Понятная причина, если провал похож на сбой API/сети, иначе None.

    Кроме характерных фраз в тексте/ошибке, отдельно ловим случай, из-за которого
    задача d0e75247 упала без error и без summary: claude завершился с ненулевым
    кодом, так и не прислав финальный result (is_error) — процесс просто умер
    посреди авторизации.
    """
    if res.ok:
        return None
    haystack = f"{res.error or ''}\n{res.text or ''}".lower()
    if "max_turns" in haystack:          # лимит ходов — задача велика, а не сбой сети: автоповтор не нужен
        return None
    matched = next((m for m in INFRA_MARKERS if m in haystack), None)
    snippet = " ".join((res.text or res.error or "").split())[:300]
    if matched:
        return f"сбой API Claude ({matched}): {snippet}" if snippet else f"сбой API Claude ({matched})"
    if res.exit_code not in (None, 0) and not res.is_error_result:
        base = f"claude завершился с кодом {res.exit_code} без финального ответа — похоже на сбой инфраструктуры"
        return f"{base}: {snippet}" if snippet else base
    return None


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
            # limit: одна строка stream-json может нести содержимое большого файла (Read на 100 КБ+);
            # дефолтные 64 КБ StreamReader рвут поток ошибкой «chunk exceed the limit»
            proc = await asyncio.create_subprocess_exec(
                *args, cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=32 * 1024 * 1024)
        except FileNotFoundError:
            return RunResult(False, "", error=f"claude не найден: {self.binary}")

        final: RunResult | None = None
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
                is_error = bool(msg.get("is_error"))
                ok = not is_error and msg.get("subtype") == "success"
                final = RunResult(ok, msg.get("result") or "\n".join(text_parts[-3:]),
                                  float(msg.get("total_cost_usd") or 0), int(msg.get("num_turns") or 0),
                                  None if ok else (msg.get("result") or msg.get("subtype") or "ошибка"),
                                  is_error_result=is_error)
        stderr = (await proc.stderr.read()).decode("utf-8", errors="replace") if proc.stderr else ""
        await proc.wait()
        if final is None:
            # процесс завершился, ни разу не прислав result-событие (например, упал на
            # авторизации раньше, чем модель успела дать финальный ответ) — не терять
            # текст, который агент всё же вывел, иначе задача падает без error и без summary
            final = RunResult(False, "\n".join(text_parts[-3:]), error="агент завершился без result-события")
        final.exit_code = proc.returncode
        if proc.returncode != 0 and not final.ok:
            final.error = (final.error or "") + (f" | {stderr.strip()[-500:]}" if stderr.strip() else f" | exit {proc.returncode}")
        return final


class FakeRunner:
    """Имитация: пишет несколько событий, делает правку в worktree, отвечает резюме.

    fail_times > 0 — для тестов автоповтора: первые N запусков на каждую задачу
    имитируют сбой API (текст fail_text попадает и в agent.text, и в RunResult),
    следующий запуск той же задачи — обычный успех.
    """

    def __init__(self, delay: float = 0.05, fail_times: int = 0,
                 fail_text: str = "Failed to authenticate. API Error: 403 Request not allowed") -> None:
        self.delay, self.fail_times, self.fail_text = delay, fail_times, fail_text
        self._fails_left: dict[str, int] = {}

    async def run(self, agent: str, system: str, model: str, prompt: str, cwd: str, task_id: str) -> RunResult:
        left = self._fails_left.get(task_id, self.fail_times)
        if left > 0:
            self._fails_left[task_id] = left - 1
            await bus.emit("agent.text", agent, task_id, text=self.fail_text)
            await asyncio.sleep(self.delay)
            return RunResult(False, self.fail_text, error=self.fail_text)
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
