"""Playwright-сценарии для bike_fit: запись через `playwright codegen`, хранение как
pytest-файлы в workspace/tests/bike_fit/scenarios, запуск через testlab.run (та же лента
и история прогонов, что у обычных тестов) со скриншотом падения.

bike_fit — Streamlit-приложение без .venv-специфики самого cyber_office: сценарии
работают через .venv репозитория bike_fit (там должны быть поставлены pytest-playwright
и `playwright install chromium` — руками, один раз, это не задача этого модуля)."""
from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

import httpx

from app.config import WORKSPACE
from app.core import testlab
from app.core.events import bus

BASE_URL = "http://localhost:8501"
SCENARIOS_DIR = WORKSPACE / "tests" / "bike_fit" / "scenarios"
SCREENSHOTS_DIR = SCENARIOS_DIR / "screenshots"

_CONFTEST = '''"""base_url для pytest-playwright: bike_fit крутится локально на Streamlit."""
import pytest


@pytest.fixture
def base_url():
    return "http://localhost:8501"
'''

# процесс dev-сервера streamlit — не убивается после прогона, живёт как обычный dev-сервер
_streamlit_proc: asyncio.subprocess.Process | None = None
_streamlit_lock = asyncio.Lock()


def is_bike_fit(repo: str) -> bool:
    return Path(repo).name == "bike_fit"


def _safe_name(name: str) -> str | None:
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        return None
    return name


def ensure_scenarios_dir() -> None:
    SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    conftest = SCENARIOS_DIR / "conftest.py"
    if not conftest.exists():
        conftest.write_text(_CONFTEST, encoding="utf-8")


def list_scenarios() -> list[str]:
    ensure_scenarios_dir()
    return sorted(p.name for p in SCENARIOS_DIR.glob("*.py") if p.name != "conftest.py")


def scenario_path(name: str) -> Path | None:
    """basename → путь к файлу сценария, только если он реально лежит в SCENARIOS_DIR."""
    safe = _safe_name(name)
    if not safe or not safe.endswith(".py"):
        return None
    p = SCENARIOS_DIR / safe
    try:
        p.resolve().relative_to(SCENARIOS_DIR.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def screenshot_path(run_id: str, filename: str) -> Path | None:
    """(run_id, filename) → путь к скриншоту, только basename без `..`/`/` и только
    внутри каталога именно этого прогона — иначе path traversal."""
    safe_run = _safe_name(run_id)
    safe_file = _safe_name(filename)
    if not safe_run or not safe_file:
        return None
    run_dir = SCREENSHOTS_DIR / safe_run
    p = run_dir / safe_file
    try:
        p.resolve().relative_to(run_dir.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


# ------------------------------------------------------------------ dev-сервер bike_fit
async def _alive() -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(BASE_URL)
            return r.status_code < 500
    except httpx.HTTPError:
        return False


async def ensure_streamlit_running(repo: str, timeout: float = 25.0) -> None:
    """Если на BASE_URL уже кто-то отвечает (в т.ч. поднятый вручную dev-сервер) — не трогаем.
    Иначе стартуем .venv/bin/streamlit run app.py и оставляем жить (не убиваем после теста)."""
    global _streamlit_proc
    async with _streamlit_lock:
        if await _alive():
            return
        if _streamlit_proc is None or _streamlit_proc.returncode is not None:
            streamlit = Path(repo) / ".venv" / "bin" / "streamlit"
            _streamlit_proc = await asyncio.create_subprocess_exec(
                str(streamlit), "run", "app.py", "--server.headless", "true", cwd=repo,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)

    waited = 0.0
    while waited < timeout:
        if await _alive():
            return
        await asyncio.sleep(0.5)
        waited += 0.5
    raise RuntimeError(f"streamlit не поднялся за {timeout:.0f}с на {BASE_URL}")


# ------------------------------------------------------------------ запись
async def start_recording(repo: str) -> None:
    """`playwright codegen` открывает окно браузера и пишет python-pytest файл, пока
    пользователь не закроет его сам — здесь только запускаем и ждём в фоне, HTTP-ответ
    на /api/scenarios/record не блокируется этим await."""
    try:
        await ensure_streamlit_running(repo)
    except RuntimeError as exc:
        await bus.emit("scenario.recorded", error=str(exc))
        return
    ensure_scenarios_dir()
    python = Path(repo) / ".venv" / "bin" / "python"
    tmp = SCENARIOS_DIR / f".recording-{datetime.now():%Y%m%d_%H%M%S}.py"
    proc = await asyncio.create_subprocess_exec(
        str(python), "-m", "playwright", "codegen", BASE_URL,
        "--target", "python-pytest", "-o", str(tmp),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    await proc.wait()
    if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
        name = f"test_scenario_{datetime.now():%Y%m%d_%H%M%S}.py"
        tmp.replace(SCENARIOS_DIR / name)
        await bus.emit("scenario.recorded", name=name)
    else:
        tmp.unlink(missing_ok=True)
        await bus.emit("scenario.recorded", error="запись не сохранена (codegen закрыт без сценария?)")


# ------------------------------------------------------------------ запуск
def _flatten_screenshots(run_dir: Path) -> str | None:
    """playwright кладёт скриншот падения куда-то внутрь run_dir (иногда в подпапку по
    имени теста) — поднимаем всё на верхний уровень run_dir, чтобы отдавать по чистому
    basename через /api/scenarios/screenshot/{run_id}/{filename}."""
    if not run_dir.is_dir():
        return None
    pngs = sorted(run_dir.rglob("*.png"), key=lambda p: p.stat().st_mtime)
    if not pngs:
        return None
    last = pngs[-1]
    if last.parent == run_dir:
        return last.name
    flat_name = f"{last.parent.name}-{last.name}"
    dest = run_dir / flat_name
    last.replace(dest)
    return flat_name


async def run_scenario(repo: str, target: str, run_id: str) -> None:
    """Прогон одного сценария: поднимает streamlit, добавляет к pytest флаги
    --screenshot=only-on-failure/--output=<run_dir скриншотов> и сохраняет в TestRun
    basename найденного скриншота падения, если он появился."""
    try:
        await ensure_streamlit_running(repo)
    except RuntimeError as exc:
        store = testlab.RunStore(repo)
        tr = testlab.TestRun(id=run_id, repo=repo, target=target, command="", status="error",
                              stderr=str(exc), finished_at=datetime.now().isoformat(timespec="seconds"))
        store.put(tr)
        await bus.emit("run.state", task_id=run_id, state="error")
        return

    run_dir = SCREENSHOTS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    extra = ["--screenshot=only-on-failure", f"--output={run_dir}"]
    await testlab.run(repo, target, run_id, extra_args=extra)

    store = testlab.RunStore(repo)
    tr = store.get(run_id)
    if tr is None:
        return
    screenshot = _flatten_screenshots(run_dir)
    if screenshot:
        tr.screenshot = screenshot
        store.put(tr)
