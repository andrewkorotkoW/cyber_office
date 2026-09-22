"""cyber_office — локальный «офис» агентов Claude Code.

    python -m app.main            # реальные агенты (нужен залогиненный claude)
    AO_FAKE=1 python -m app.main  # имитация агентов, чтобы смотреть интерфейс
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import config
from app.core import allure, lock, procs, repo_init, scenarios, testlab, worktree
from app.core.events import bus
from app.core.office import Office, build_summary
from app.core.planner import ClaudePlanner, FakePlanner
from app.core.roster import Roster
from app.core.runner import ClaudeRunner, FakeRunner
from app.core.tasks import TaskStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("cyber_office")

FAKE = os.getenv("AO_FAKE") == "1"
UI_DIR = config.ROOT / "ui"
REPOS_FILE = config.WORKSPACE / "repos.json"

config.ensure_dirs()


_lock_fh = None


def acquire_lock() -> None:
    """Второй сервер на том же workspace затирал бы tasks.json — не даём ему стартовать.
    Вызывается при реальном старте сервера, а не при импорте: окно .app импортирует
    этот модуль, чтобы подключиться к уже работающему серверу."""
    global _lock_fh
    try:
        _lock_fh = lock.acquire(config.WORKSPACE / ".server.lock")
    except lock.LockHeld:
        raise SystemExit(f"cyber_office уже запущен на этом workspace ({config.WORKSPACE}). "
                         f"Открой http://{config.HOST}:{config.PORT} или останови тот процесс.")
    _lock_fh.seek(0); _lock_fh.truncate()
    _lock_fh.write(str(os.getpid())); _lock_fh.flush()
    (config.WORKSPACE / "server.pid").write_text(str(os.getpid()))   # его читает подсказка after_merge

# office создаётся в lifespan (после acquire_lock(), которую вызывает только реальный старт
# сервера — main()/desktop._serve() — а не сам факт импорта модуля), не на импорте: раньше
# создание office на импорте означало, что окно .app или тестовый импорт уже писали tasks.json.
office: Office | None = None
sockets: set[WebSocket] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global office
    office = Office(TaskStore(config.TASKS_FILE), Roster(), FakeRunner(delay=0.6) if FAKE else ClaudeRunner(),
                    FakePlanner() if FAKE else ClaudePlanner(), base_for=_repo_base)
    office.resume_pending_auto_retries()
    if config.TG_TOKEN and config.TG_ADMINS:
        from app import telegram
        asyncio.create_task(telegram.run(office, _repos, _after_merge_cmd, _register_repo))
    elif config.TG_TOKEN:
        log.warning("AO_TG_TOKEN задан, но AO_TG_ADMINS пуст — мост выключен: некому доверять")
    try:
        yield
    finally:
        # сервер останавливается — не оставлять сиротами claude/pytest/after_merge,
        # запущенные (start_new_session=True) за время его жизни
        procs.killall()


app = FastAPI(title="cyber_office", lifespan=lifespan)


async def _broadcast(ev) -> None:
    dead = []
    for ws in list(sockets):
        try:
            await ws.send_text(ev.to_json())
        except Exception:
            dead.append(ws)
    for ws in dead:
        sockets.discard(ws)

bus.subscribe(_broadcast)


# ------------------------------------------------------------------ репозитории
def _repo_entries() -> list[dict]:
    """repos.json: список строк-путей или объектов {"path": ..., "after_merge": "cmd"}."""
    out = []
    if REPOS_FILE.exists():
        for r in json.loads(REPOS_FILE.read_text(encoding="utf-8")):
            out.append({"path": r} if isinstance(r, str) else r)
    return out


def _repos() -> list[str]:
    repos = [str(config.ROOT / "sandbox")]
    repos += [e["path"] for e in _repo_entries() if e["path"] not in repos]
    return repos


def _after_merge_cmd(repo: str) -> str | None:
    for e in _repo_entries():
        if e["path"] == repo:
            return e.get("after_merge")
    return None


def _repo_base(repo: str) -> str | None:
    """repos.json: "base" — ветка для merge/diff, если её нельзя надёжно определить
    через origin/HEAD (например, репозиторий без origin)."""
    for e in _repo_entries():
        if e["path"] == repo:
            return e.get("base")
    return None


async def _run_after_merge(repo: str, task_id: str) -> None:
    """Тонкая обёртка над Office.run_after_merge — удобно для asyncio.create_task,
    т.к. Office не знает про repos.json и команду для конкретного repo."""
    await office.run_after_merge(repo, task_id, _after_merge_cmd(repo))


def _register_repo(path: str) -> None:
    entries = _repo_entries()
    if path not in [e["path"] for e in entries]:
        entries.append({"path": path})
        REPOS_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


class RepoIn(BaseModel):
    path: str


@app.get("/api/repos")
async def repos() -> list[str]:
    return _repos()


@app.post("/api/repos")
async def add_repo(body: RepoIn) -> list[str]:
    p = str(Path(body.path).expanduser().resolve())
    if not await worktree.is_repo(p):
        raise HTTPException(400, f"{p} — не git-репозиторий")
    _register_repo(p)
    return _repos()


class RepoNewIn(BaseModel):
    name: str
    description: str = ""
    template: str = "empty"
    venv: bool = True


@app.post("/api/repos/new")
async def new_repo(body: RepoNewIn) -> dict:
    """Создаёт новый проект в AO_PROJECTS_DIR и сразу регистрирует его как репозиторий
    офиса — чтобы под новую идею не пришлось руками искать/подключать папку. Для шаблона
    "python" .venv ставится в фоне (см. repo_init.setup_venv), если не снят чекбокс venv."""
    try:
        path = await repo_init.create(config.PROJECTS_DIR, body.name, body.description, body.template)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _register_repo(path)
    await bus.emit("repo.created", None, None, path=path, name=body.name)
    if body.template == "python" and body.venv:
        asyncio.create_task(repo_init.setup_venv(path))
    return {"path": path, "repos": _repos()}


# ------------------------------------------------------------------ состояние и задачи
@app.get("/api/state")
async def state() -> dict:
    snap = office.snapshot()
    snap["repos"] = _repos()
    snap["mode"] = "fake" if FAKE else "claude"
    snap["claude_bin"] = config.CLAUDE_BIN if Path(config.CLAUDE_BIN).exists() else None
    return snap


@app.get("/api/summary")
async def summary(since: str) -> dict:
    return build_summary(office.store, since)


class TaskIn(BaseModel):
    title: str
    prompt: str
    repo: str
    agent: str = "michael"


@app.post("/api/tasks")
async def create_task(body: TaskIn) -> dict:
    if not body.title.strip() or not body.prompt.strip():
        raise HTTPException(400, "нужны название и описание")
    try:
        t = await office.create_task(body.title, body.prompt, body.repo, body.agent)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"id": t.id}


@app.get("/api/tasks/{task_id}/events")
async def task_events(task_id: str) -> list[dict]:
    """История ленты по одной задаче — для живого терминала в карточке."""
    from dataclasses import asdict
    return [asdict(e) for e in bus.history if e.task_id == task_id][-300:]


@app.get("/api/tasks/{task_id}/diff")
async def task_diff(task_id: str) -> dict:
    return {"diff": await office.diff(task_id)}


class Reason(BaseModel):
    text: str = ""


@app.post("/api/tasks/{task_id}/approve")
async def approve(task_id: str, force: bool = False) -> dict:
    """force=true — принять задачу даже с пустым диффом (по умолчанию такая отклоняется с 409)."""
    ok, out = await office.approve(task_id, force=force)
    if not ok:
        raise HTTPException(409 if out == office.EMPTY_DIFF_MSG else 400, out or "не удалось")
    t = office.store.get(task_id)
    if t:
        asyncio.create_task(_run_after_merge(t.repo, task_id))
    return {"ok": True}


@app.post("/api/tasks/{task_id}/reject")
async def reject(task_id: str, body: Reason) -> dict:
    if not await office.reject(task_id, body.text):
        raise HTTPException(400, "задача не на ревью")
    return {"ok": True}


@app.post("/api/tasks/{task_id}/retry")
async def retry(task_id: str, body: Reason) -> dict:
    if not await office.retry(task_id, body.text):
        raise HTTPException(400, "повторить можно только отклонённую или упавшую")
    return {"ok": True}


@app.post("/api/tasks/{task_id}/stop")
async def stop_task(task_id: str) -> dict:
    if not await office.stop(task_id):
        raise HTTPException(400, "задача не выполняется")
    return {"ok": True}


class Note(BaseModel):
    text: str


@app.post("/api/tasks/{task_id}/note")
async def note(task_id: str, body: Note) -> dict:
    if not await office.add_note(task_id, body.text):
        raise HTTPException(400, "дописать можно только работающей задаче")
    return {"ok": True}


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str) -> dict:
    return {"ok": await office.delete_task(task_id)}


# ------------------------------------------------------------------ миссии
class MissionIn(BaseModel):
    goal: str
    repo: str


@app.post("/api/missions")
async def create_mission(body: MissionIn) -> dict:
    try:
        m = await office.create_mission(body.goal, body.repo)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"id": m.id}


@app.delete("/api/missions/{mission_id}")
async def delete_mission(mission_id: str) -> dict:
    m = office.store.missions.get(mission_id)
    if not m:
        raise HTTPException(404, "нет такой миссии")
    for t in office.store.mission_tasks(mission_id):
        if t.status == "running":
            raise HTTPException(400, "в миссии есть работающая задача")
    planning = office._planning.get(mission_id)
    if planning is not None:                       # планирование ещё идёт — отменяем, чтобы не создало задачи
        planning.cancel()
    for t in office.store.mission_tasks(mission_id):
        await worktree.remove(t.repo, t.branch, t.worktree, delete_branch=True)
        office.store.delete(t.id)
    del office.store.missions[mission_id]; office.store.save()
    return {"ok": True}


# ------------------------------------------------------------------ тесты
@app.get("/api/tests")
async def tests_discover(repo: str) -> dict:
    if repo not in _repos():
        raise HTTPException(400, f"неизвестный repo: {repo}")
    return await testlab.discover(repo)


class RunIn(BaseModel):
    repo: str
    target: str | None = None


@app.post("/api/tests/run")
async def tests_run(body: RunIn) -> dict:
    if body.repo not in _repos():
        raise HTTPException(400, f"неизвестный repo: {body.repo}")
    run_id = testlab.new_run_id()
    asyncio.create_task(testlab.run(body.repo, body.target, run_id))
    return {"run_id": run_id}


@app.get("/api/tests/runs")
async def tests_runs(repo: str) -> list[dict]:
    if repo not in _repos():
        raise HTTPException(400, f"неизвестный repo: {repo}")
    from dataclasses import asdict
    return [
        {k: v for k, v in asdict(r).items() if k not in ("stdout", "stderr", "command")}
        for r in testlab.RunStore(repo).list()
    ]


@app.get("/api/tests/runs/{run_id}")
async def tests_run_detail(run_id: str) -> dict:
    from dataclasses import asdict
    tr = testlab.find_run(run_id)
    if not tr:
        raise HTTPException(404, "нет такого прогона")
    return asdict(tr)


@app.get("/api/tests/runs/{run_id}/events")
async def tests_run_events(run_id: str) -> list[dict]:
    from dataclasses import asdict
    return [asdict(e) for e in bus.history if e.task_id == run_id][-300:]


# ------------------------------------------------------------------ отчёт (Allure-style)
@app.get("/api/tests/report")
async def tests_report(repo: str, run_id: str) -> dict:
    if repo not in _repos():
        raise HTTPException(400, f"неизвестный repo: {repo}")
    try:
        return allure.build_report(repo, run_id)
    except LookupError:
        raise HTTPException(404, "нет такого прогона")


@app.get("/api/tests/trend")
async def tests_trend(repo: str, limit: int = 20) -> list[dict]:
    if repo not in _repos():
        raise HTTPException(400, f"неизвестный repo: {repo}")
    return allure.build_trend(repo, limit)


@app.get("/api/tests/attachments/{run_id}/{source}")
async def tests_attachment(run_id: str, source: str) -> FileResponse:
    tr = testlab.find_run(run_id)
    if not tr:
        raise HTTPException(404, "нет такого прогона")
    path = allure.attachment_path(tr.repo, run_id, source)
    if path is None:
        raise HTTPException(404, "нет такого вложения")
    return FileResponse(path)


@app.get("/api/tests/allure-available")
async def tests_allure_available(repo: str, run_id: str) -> dict:
    return {"available": allure.can_open(repo, run_id)}


class AllureOpenIn(BaseModel):
    repo: str
    run_id: str


@app.post("/api/tests/allure-open")
async def tests_allure_open(body: AllureOpenIn) -> dict:
    if body.repo not in _repos():
        raise HTTPException(400, f"неизвестный repo: {body.repo}")
    try:
        await allure.generate_and_open(body.repo, body.run_id)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True}


# ------------------------------------------------------------------ сценарии (bike_fit)
def _bike_fit_repo(repo: str) -> str:
    if repo not in _repos() or not scenarios.is_bike_fit(repo):
        raise HTTPException(400, "сценарии доступны только для bike_fit")
    return repo


class ScenarioRepoIn(BaseModel):
    repo: str


@app.get("/api/scenarios")
async def scenarios_list(repo: str) -> dict:
    _bike_fit_repo(repo)
    return {"scenarios": scenarios.list_scenarios()}


@app.post("/api/scenarios/record")
async def scenarios_record(body: ScenarioRepoIn) -> dict:
    repo = _bike_fit_repo(body.repo)
    asyncio.create_task(scenarios.start_recording(repo))
    return {"ok": True, "status": "recording"}


class ScenarioRunIn(BaseModel):
    repo: str
    name: str


@app.post("/api/scenarios/run")
async def scenarios_run(body: ScenarioRunIn) -> dict:
    repo = _bike_fit_repo(body.repo)
    path = scenarios.scenario_path(body.name)
    if path is None:
        raise HTTPException(404, "нет такого сценария")
    run_id = testlab.new_run_id()
    asyncio.create_task(scenarios.run_scenario(repo, str(path), run_id))
    return {"run_id": run_id}


@app.get("/api/scenarios/screenshot/{run_id}/{filename}")
async def scenarios_screenshot(run_id: str, filename: str) -> FileResponse:
    path = scenarios.screenshot_path(run_id, filename)
    if path is None:
        raise HTTPException(404, "нет такого скриншота")
    return FileResponse(path)


# ------------------------------------------------------------------ живые события
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    sockets.add(ws)
    try:
        history = [dataclasses.asdict(ev) for ev in bus.history[-200:]]
        await ws.send_text(json.dumps({"kind": "history", "events": history}, ensure_ascii=False))
        while True:
            await ws.receive_text()      # клиент ничего не шлёт; держим соединение
    except WebSocketDisconnect:
        pass
    finally:
        sockets.discard(ws)


# ------------------------------------------------------------------ интерфейс
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(UI_DIR / "index.html")

app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")


def main() -> None:
    acquire_lock()
    if not FAKE and not Path(config.CLAUDE_BIN).exists():
        raise SystemExit(
            f"claude CLI не найден ({config.CLAUDE_BIN}). Поставь Claude Code "
            f"(https://claude.com/claude-code) и войди в аккаунт (`claude` → /login), "
            f"либо укажи путь в переменной окружения AO_CLAUDE_BIN. Для запуска без "
            f"агентов, только чтобы посмотреть интерфейс: AO_FAKE=1 python -m app.main")
    log.info("cyber_office: режим %s, claude=%s", "имитация" if FAKE else "claude", config.CLAUDE_BIN)
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
