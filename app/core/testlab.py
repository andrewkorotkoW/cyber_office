"""Тесты чужих репозиториев: обнаружение (pytest --collect-only) и запуск (pytest -q)
прямо в корне репозитория — правки там не делаются, поэтому worktree не нужен.

Хранение прогонов — по образцу app.core.tasks: атомарная запись в workspace/tests/<repo>/runs.json
(tmp-файл + .replace()), история ограничена последними ~200 прогонами на репозиторий."""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from app.config import WORKSPACE
from app.core.events import bus

TESTS_DIR = WORKSPACE / "tests"
MAX_RUNS = 200

_COLLECT_RE = re.compile(r"^(?P<file>[\w./-]+\.py)::(?P<test>\S+)$")
_FAILED_RE = re.compile(r"^FAILED (?P<nodeid>\S+)")

_locks: dict[str, asyncio.Lock] = {}


def _lock(repo: str) -> asyncio.Lock:
    return _locks.setdefault(repo, asyncio.Lock())


def _venv_python(repo: str) -> Path:
    return Path(repo) / ".venv" / "bin" / "python"


def _run_dir(repo: str) -> Path:
    return TESTS_DIR / Path(repo).name


def _runs_file(repo: str) -> Path:
    return _run_dir(repo) / "runs.json"


def allure_results_dir(repo: str, run_id: str) -> Path:
    return _run_dir(repo) / "allure-results" / run_id


def allure_report_dir(repo: str, run_id: str) -> Path:
    return _run_dir(repo) / "allure-report" / run_id


def _allure_pytest_installed(repo: str) -> bool:
    """Смотрим в site-packages репозитория, а не запускаем его python: у сценариев в
    тестах .venv/bin/python — поддельный shell-скрипт, который отвечает на любые
    аргументы, так что `python -c "import allure"` там ничего не значит."""
    venv = Path(repo) / ".venv"
    if not venv.is_dir():
        return False
    for site in venv.glob("lib/python*/site-packages"):
        if any(site.glob("allure_pytest*")):
            return True
    return False


# ------------------------------------------------------------------ обнаружение
async def discover(repo: str) -> dict:
    """Дерево тестов через `pytest --collect-only -q`: {"tests/test_x.py": ["test_foo", ...]}.
    .venv не найден — возвращаем понятную ошибку, а не падаем."""
    python = _venv_python(repo)
    if not python.exists():
        return {"error": f"не найден .venv/bin/python в {repo}", "tree": {}}
    proc = await asyncio.create_subprocess_exec(
        str(python), "-m", "pytest", "--collect-only", "-q", cwd=repo,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    text = out.decode("utf-8", errors="replace")
    tree: dict[str, list[str]] = {}
    for line in text.splitlines():
        line = line.strip()
        m = _COLLECT_RE.match(line)
        if not m:
            continue
        tree.setdefault(m.group("file"), []).append(m.group("test"))
    if not tree and proc.returncode != 0:
        return {"error": text.strip()[-2000:] or f"pytest завершился с кодом {proc.returncode}", "tree": {}}
    return {"tree": tree}


# ------------------------------------------------------------------ прогоны
@dataclass(slots=True)
class TestRun:
    id: str
    repo: str
    target: str | None            # None = весь набор, иначе "path::test" или "path"
    command: str
    status: str = "running"       # running/passed/failed/error
    started_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    finished_at: str | None = None
    duration: float = 0.0
    stdout: str = ""
    stderr: str = ""
    failed: list[str] = field(default_factory=list)
    returncode: int | None = None
    screenshot: str | None = None  # basename скриншота провала (сценарии bike_fit, см. app.core.scenarios)
    allure: bool = False           # собраны ли allure-results для этого прогона (см. app.core.allure)
    allure_error: str | None = None  # почему не собраны/чем отчёт будет беднее (не полная ошибка прогона)


class RunStore:
    def __init__(self, repo: str) -> None:
        self.repo = repo
        self.path = _runs_file(repo)
        self.runs: dict[str, TestRun] = {}
        self.load()

    def load(self) -> None:
        if self.path.exists():
            raw = json.loads(self.path.read_text(encoding="utf-8") or "[]")
            self.runs = {r["id"]: TestRun(**r) for r in raw}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        ordered = sorted(self.runs.values(), key=lambda r: r.started_at)[-MAX_RUNS:]
        self.runs = {r.id: r for r in ordered}
        tmp.write_text(json.dumps([asdict(r) for r in ordered], ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def put(self, run: TestRun) -> None:
        self.runs[run.id] = run
        self.save()

    def get(self, run_id: str) -> TestRun | None:
        return self.runs.get(run_id)

    def list(self) -> list[TestRun]:
        return sorted(self.runs.values(), key=lambda r: r.started_at, reverse=True)


def find_run(run_id: str) -> TestRun | None:
    """Ищет прогон по всем репозиториям, у которых уже есть каталог workspace/tests/<repo>."""
    if not TESTS_DIR.exists():
        return None
    for d in TESTS_DIR.iterdir():
        f = d / "runs.json"
        if not f.exists():
            continue
        raw = json.loads(f.read_text(encoding="utf-8") or "[]")
        for r in raw:
            if r.get("id") == run_id:
                return TestRun(**r)
    return None


def new_run_id() -> str:
    """Генерируется до запуска фонового asyncio.create_task(run(...)), чтобы REST-обработчик
    мог сразу же ответить {run_id}, не дожидаясь завершения pytest."""
    return uuid.uuid4().hex[:8]


async def run(repo: str, target: str | None, run_id: str, extra_args: list[str] | None = None) -> None:
    """Запускает pytest в repo (без git worktree — правки там не делаются) и стримит
    вывод через bus. run_id получен заранее через new_run_id(), поэтому вызывающий код
    может отдать его клиенту сразу, а сам await-ить run() в фоновой asyncio.create_task.
    extra_args — дополнительные флаги pytest перед target (сценарии bike_fit добавляют
    сюда --screenshot/--output, см. app.core.scenarios)."""
    store = RunStore(repo)
    python = _venv_python(repo)
    extra = list(extra_args or [])
    allure_used = False
    allure_note = None
    if _allure_pytest_installed(repo):
        adir = allure_results_dir(repo, run_id)
        adir.mkdir(parents=True, exist_ok=True)
        extra = [f"--alluredir={adir}"] + extra
        allure_used = True
    else:
        allure_note = "allure-pytest не найден в .venv репозитория — отчёт будет собран без шагов и вложений"
    args = [str(python), "-m", "pytest", "-q"] + extra + ([target] if target else [])
    command = " ".join(args)
    tr = TestRun(id=run_id, repo=repo, target=target, command=command, allure=allure_used, allure_error=allure_note)

    if not python.exists():
        tr.status = "error"
        tr.stderr = f"не найден .venv/bin/python в {repo}"
        tr.finished_at = datetime.now().isoformat(timespec="seconds")
        store.put(tr)
        await bus.emit("run.state", task_id=run_id, state="error")
        return

    store.put(tr)
    await bus.emit("run.state", task_id=run_id, state="running")

    async with _lock(repo):
        started = datetime.now()
        try:
            proc = await asyncio.create_subprocess_exec(
                *args, cwd=repo, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except FileNotFoundError as exc:
            tr.status = "error"
            tr.stderr = str(exc)
            tr.finished_at = datetime.now().isoformat(timespec="seconds")
            store.put(tr)
            await bus.emit("run.state", task_id=run_id, state="error")
            return

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []

        async def _pump(stream: asyncio.StreamReader, sink: list[str]) -> None:
            async for raw in stream:
                line = raw.decode("utf-8", errors="replace").rstrip("\n")
                sink.append(line)
                await bus.emit("run.output", task_id=run_id, line=line)

        assert proc.stdout is not None and proc.stderr is not None
        await asyncio.gather(_pump(proc.stdout, stdout_lines), _pump(proc.stderr, stderr_lines))
        await proc.wait()

        tr.returncode = proc.returncode
        tr.stdout = "\n".join(stdout_lines)
        tr.stderr = "\n".join(stderr_lines)
        tr.failed = [m.group("nodeid") for line in stdout_lines if (m := _FAILED_RE.match(line.strip()))]
        tr.duration = (datetime.now() - started).total_seconds()
        tr.finished_at = datetime.now().isoformat(timespec="seconds")
        if proc.returncode == 0:
            tr.status = "passed"
        elif tr.failed or proc.returncode == 1:
            tr.status = "failed"
        else:
            tr.status = "error"
        store.put(tr)
        await bus.emit("run.state", task_id=run_id, state=tr.status)
