"""Сводка «Что происходит?»: факты считает код (детерминированно, без claude),
персонаж Оскар (точный сухой бухгалтер) поверх них пишет 3-5 предложений одним
вызовом `claude -p`. Кэш — workspace/digest.json (tmp-файл + .replace(), по
образцу app.core.tasks/app.core.testlab).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
from datetime import datetime, timedelta
from pathlib import Path
from typing import Protocol

import httpx

from app import config
from app.config import CLAUDE_BIN
from app.core import procs
from app.core.events import bus
from app.core.office import build_summary
from app.core.roster import Roster
from app.core.tasks import TaskStore

DIGEST_FILE = config.WORKSPACE / "digest.json"
DIGEST_TIMEOUT = 60          # секунд на вызов claude -p Оскаром
TESTHUB_URL = "http://127.0.0.1:8700/api/projects/{name}/runs"
TESTHUB_TIMEOUT = 2.0

NARRATE_PROMPT = """Ты — Оскар, бухгалтер офиса разработки: точный, сухой, любишь цифры и не любишь воду.
По данным ниже (JSON — факты о репозиториях, задачах и агентах офиса) напиши сводку "что сейчас
происходит" для владельца офиса. 3-5 предложений на русском, только по существу: что в работе,
что на ревью, что упало и почему, что изменилось с прошлой сводки. Без предположений сверх данных,
без похвалы и извинений — просто цифры и факты.

Данные:
{facts_json}
"""


# ------------------------------------------------------------------ факты
async def _fetch_testhub_run(repo_name: str) -> dict | None:
    """Последний прогон test_hub для репозитория. Любая недоступность/ошибка/не-200 —
    просто нет блока, наружу ничего не летит (test_hub — необязательный сосед)."""
    try:
        async with httpx.AsyncClient(timeout=TESTHUB_TIMEOUT) as client:
            resp = await client.get(TESTHUB_URL.format(name=repo_name))
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception:
        return None
    runs = data if isinstance(data, list) else (data.get("runs") if isinstance(data, dict) else None)
    if not runs or not isinstance(runs[0], dict):
        return None
    run = runs[0]
    return {"id": run.get("id") or run.get("run_id"), "stand": run.get("stand"),
            "passed": run.get("passed"), "failed": run.get("failed"),
            "started_at": run.get("started_at") or run.get("created_at") or run.get("finished_at")}


def _task_entry(t) -> dict:
    return {"id": t.id, "title": t.title, "agent": t.agent}


def _repo_bucket(repos: dict, path: str) -> dict:
    return repos.setdefault(path, {"name": Path(path).name, "missions": [], "running": [], "review": [],
                                    "todo": [], "failed_24h": [], "paused": False})


async def collect_facts(store: TaskStore, roster: Roster, paused: set[str], testhub: bool = True) -> dict:
    """Всё детерминированно из store/roster/paused (плюс, если testhub=True, необязательный
    последний прогон test_hub на репозиторий). Никаких вызовов claude здесь."""
    now = datetime.now()
    cutoff = (now - timedelta(hours=24)).isoformat(timespec="seconds")
    repos: dict[str, dict] = {}

    for t in store.tasks.values():
        bucket = _repo_bucket(repos, t.repo)
        if t.status == "running":
            bucket["running"].append(_task_entry(t))
        elif t.status == "review":
            bucket["review"].append(_task_entry(t))
        elif t.status == "todo":
            bucket["todo"].append(_task_entry(t))
        elif t.status == "failed" and t.updated_at >= cutoff:
            bucket["failed_24h"].append({**_task_entry(t), "error": (t.error or "")[:200]})

    for m in store.missions.values():
        if m.status not in ("planning", "active"):
            continue
        bucket = _repo_bucket(repos, m.repo)
        mission_tasks = store.mission_tasks(m.id)
        done = sum(1 for x in mission_tasks if x.status == "done")
        bucket["missions"].append({"id": m.id, "goal": m.goal[:200], "status": m.status,
                                   "done": done, "total": len(mission_tasks)})

    for path in paused:
        _repo_bucket(repos, path)["paused"] = True

    if testhub:
        for bucket in repos.values():
            run = await _fetch_testhub_run(bucket["name"])
            if run is not None:
                bucket["testhub"] = run

    agents = [{"name": a.name, "title": a.title, "state": a.state, "current_task": a.current_task}
              for a in roster.agents.values()]

    cache = load_cache()
    since = (cache["generated_at"][:10] if cache and cache.get("generated_at") else now.strftime("%Y-%m-%d"))
    summary = build_summary(store, since)
    failed_since = sum(1 for t in store.tasks.values() if t.updated_at[:10] >= since and t.status == "failed")
    since_last = {**summary, "failed_tasks": failed_since}

    return {"generated_at": now.isoformat(timespec="seconds"), "repos": repos, "agents": agents,
            "since_last": since_last}


def _public_facts(facts: dict) -> dict:
    """То, что видит Оскар в промпте: имена репозиториев, а не абсолютные пути с домашней
    директорией пользователя. Остальные поля фактов уже публичные (title/status/agent/error[:200])."""
    repos = [{k: v for k, v in bucket.items()} for bucket in (facts.get("repos") or {}).values()]
    return {"generated_at": facts.get("generated_at"), "repos": repos, "agents": facts.get("agents", []),
            "since_last": facts.get("since_last", {})}


# ------------------------------------------------------------------ Оскар пишет текст
class Narrator(Protocol):
    async def narrate(self, facts: dict) -> str: ...


class ClaudeNarrator:
    def __init__(self, binary: str = CLAUDE_BIN, model: str | None = None) -> None:
        self.binary, self.model = binary, model or config.AO_DIGEST_MODEL

    async def narrate(self, facts: dict) -> str:
        prompt = NARRATE_PROMPT.format(facts_json=json.dumps(_public_facts(facts), ensure_ascii=False))
        args = [self.binary, "-p", prompt, "--output-format", "json", "--model", self.model]
        env = {**os.environ, "PATH": f"{Path(self.binary).parent}:{os.environ.get('PATH', '')}"}
        proc = await asyncio.create_subprocess_exec(*args, env=env, stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.PIPE, limit=32 * 1024 * 1024,
                                                     start_new_session=True)
        procs.track(proc.pid)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=DIGEST_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise RuntimeError(f"Оскар не ответил за {DIGEST_TIMEOUT}с — таймаут")
        except asyncio.CancelledError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            raise
        finally:
            procs.untrack(proc.pid)
        try:
            msg = json.loads(out.decode("utf-8", errors="replace"), strict=False)
        except json.JSONDecodeError:
            raise RuntimeError(f"Оскар не ответил JSON: {err.decode(errors='replace')[-300:]}")
        if msg.get("is_error"):
            raise RuntimeError(f"Оскар: {msg.get('result')}")
        return str(msg.get("result") or "").strip()


class FakeNarrator:
    async def narrate(self, facts: dict) -> str:
        await asyncio.sleep(0.05)
        n_repos = len(facts.get("repos") or {})
        since = facts.get("since_last") or {}
        return (f"Оскар (имитация): под наблюдением {n_repos} репозиториев, "
                f"с прошлой сводки сделано {since.get('done_tasks', 0)}, упало {since.get('failed_tasks', 0)}.")


# ------------------------------------------------------------------ кэш
def load_cache() -> dict | None:
    try:
        return json.loads(DIGEST_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def save_cache(data: dict) -> None:
    DIGEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DIGEST_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DIGEST_FILE)


def mark_seen() -> None:
    cache = load_cache()
    if cache is None:
        return
    cache["seen"] = True
    save_cache(cache)


def fingerprint(facts: dict) -> str:
    return hashlib.sha256(json.dumps(facts, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ планировщик
class DigestScheduler:
    """Каждые interval_min минут пересобирает факты; если отпечаток не изменился —
    ничего не делает (Оскара не дёргаем, событие не шлём). refresh_now() — для кнопки
    «Обновить»: форсирует пересбор и вызов narrate независимо от таймера/отпечатка."""

    def __init__(self, store: TaskStore, roster: Roster, paused: set[str], narrator: Narrator,
                 interval_min: int = 15, testhub: bool = True) -> None:
        self.store, self.roster, self.paused, self.narrator = store, roster, paused, narrator
        self.interval_min, self.testhub = interval_min, testhub
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.interval_min * 60)
                await self._tick(force=False)
        except asyncio.CancelledError:
            pass

    async def refresh_now(self) -> dict:
        return await self._tick(force=True)

    async def _tick(self, force: bool) -> dict:
        facts = await collect_facts(self.store, self.roster, self.paused, testhub=self.testhub)
        fp = fingerprint(facts)
        prev = load_cache() or {}
        if not force and prev.get("fingerprint") == fp:
            return prev
        text, error = None, None
        try:
            text = await self.narrator.narrate(facts)
        except Exception as exc:
            error = str(exc)
        data = {"generated_at": facts["generated_at"], "facts": facts, "text": text, "error": error,
                "fingerprint": fp, "changed": prev.get("fingerprint") != fp, "seen": False}
        save_cache(data)
        await bus.emit("digest.ready", None, None, generated_at=data["generated_at"], fresh=True)
        return data
