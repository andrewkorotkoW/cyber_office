"""Тесты app.core.testlab: парсинг вывода pytest, RunStore (runs.json), запуск через
поддельный `.venv/bin/python`-скрипт (без реального pytest/venv — по аналогии с FakeRunner
в app.core.runner), плюс REST /api/tests* через FastAPI TestClient."""
from __future__ import annotations

import importlib
import json
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio


def _write_fake_python(repo: str, *, collect_out: str = "", collect_code: int = 0,
                        run_out: str = "", run_code: int = 0) -> None:
    """Пишет .venv/bin/python как shell-скрипт-заглушку: по наличию --collect-only в
    аргументах отдаёт вывод "обнаружения" или вывод "прогона" с нужным exit-кодом."""
    bin_dir = Path(repo) / ".venv" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / "python"
    script.write_text(
        "#!/bin/sh\n"
        "case \" $* \" in\n"
        "  *' --collect-only '*)\n"
        f"    cat <<'AO_EOF'\n{collect_out}\nAO_EOF\n"
        f"    exit {collect_code}\n"
        "    ;;\n"
        "  *)\n"
        f"    cat <<'AO_EOF'\n{run_out}\nAO_EOF\n"
        f"    exit {run_code}\n"
        "    ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    script.chmod(0o755)


@pytest.fixture
def tl(workspace):
    """testlab, перезагруженный после смены AO_WORKSPACE (у него своя закешированная
    TESTS_DIR = WORKSPACE / "tests", посчитанная при импорте)."""
    from app.core import testlab
    importlib.reload(testlab)
    return testlab


@pytest.fixture
def api(workspace, monkeypatch):
    """FastAPI TestClient поверх app.main, перезагруженного под свежий workspace (у него
    свой REPOS_FILE и модуль-уровневый `office`, посчитанные при импорте). Репозиторий из
    workspace уже зарегистрирован через POST /api/repos, как это делает реальный клиент."""
    monkeypatch.setenv("AO_FAKE", "1")
    from app.core import testlab
    import app.main as main_module
    importlib.reload(testlab)
    importlib.reload(main_module)

    from fastapi.testclient import TestClient
    with TestClient(main_module.app) as client:
        resolved = str(Path(workspace["repo"]).expanduser().resolve())
        resp = client.post("/api/repos", json={"path": workspace["repo"]})
        assert resp.status_code == 200 and resolved in resp.json()
        yield client, resolved


def _poll(client, run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = client.get(f"/api/tests/runs/{run_id}")
        if r.status_code == 200:
            last = r.json()
            if last["status"] != "running":
                return last
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} не завершился за {timeout}s, последний статус: {last}")


# ------------------------------------------------------------------ парсинг: регексы
def test_collect_regex_parses_file_and_test():
    from app.core.testlab import _COLLECT_RE
    m = _COLLECT_RE.match("tests/test_sample.py::test_ok")
    assert m and m.group("file") == "tests/test_sample.py" and m.group("test") == "test_ok"


def test_collect_regex_handles_class_nodeid():
    from app.core.testlab import _COLLECT_RE
    m = _COLLECT_RE.match("tests/test_other.py::TestClass::test_three")
    assert m and m.group("file") == "tests/test_other.py" and m.group("test") == "TestClass::test_three"


def test_collect_regex_ignores_non_test_lines():
    from app.core.testlab import _COLLECT_RE
    for line in ("", "3 tests collected in 0.02s", "no tests ran in 0.00s",
                 "==== warnings summary ====", "ERROR tests/test_broken.py - collection error"):
        assert _COLLECT_RE.match(line) is None


def test_failed_regex_parses_nodeid():
    from app.core.testlab import _FAILED_RE
    m = _FAILED_RE.match("FAILED tests/test_sample.py::test_fail - AssertionError: boom")
    assert m and m.group("nodeid") == "tests/test_sample.py::test_fail"


def test_failed_regex_ignores_non_failed_lines():
    from app.core.testlab import _FAILED_RE
    for line in ("", "3 passed in 0.01s", "PASSED tests/test_sample.py::test_ok",
                 "1 failed, 2 passed in 0.02s"):
        assert _FAILED_RE.match(line) is None


# ------------------------------------------------------------------ discover()
async def test_discover_builds_tree_from_collect_output(tl, workspace):
    repo = workspace["repo"]
    _write_fake_python(repo, collect_out=(
        "tests/test_sample.py::test_ok\n"
        "tests/test_sample.py::test_fail\n"
        "tests/test_other.py::TestClass::test_three\n"
        "\n"
        "3 tests collected in 0.02s"
    ), collect_code=0)
    result = await tl.discover(repo)
    assert result == {"tree": {
        "tests/test_sample.py": ["test_ok", "test_fail"],
        "tests/test_other.py": ["TestClass::test_three"],
    }}


async def test_discover_no_venv_returns_error_not_exception(tl, workspace):
    repo = workspace["repo"]                          # .venv не создан
    result = await tl.discover(repo)
    assert result["tree"] == {} and "error" in result and repo in result["error"]


async def test_discover_repo_without_tests_no_error_when_exit_zero(tl, workspace):
    repo = workspace["repo"]
    _write_fake_python(repo, collect_out="no tests ran in 0.00s", collect_code=0)
    result = await tl.discover(repo)
    assert result == {"tree": {}}                     # без "error": пустой набор — не сбой


async def test_discover_collection_failure_returns_error(tl, workspace):
    repo = workspace["repo"]
    _write_fake_python(repo, collect_out="ImportError while importing test module.\ncollected 0 items / 1 error",
                        collect_code=2)
    result = await tl.discover(repo)
    assert result["tree"] == {} and "error" in result and "ImportError" in result["error"]


# ------------------------------------------------------------------ RunStore
def _mk_run(tl, **kw):
    defaults = dict(id="r1", repo="/x", target=None, command="pytest -q")
    defaults.update(kw)
    return tl.TestRun(**defaults)


def test_runstore_put_get_list_roundtrip(tl, workspace):
    repo = workspace["repo"]
    store = tl.RunStore(repo)
    r1 = _mk_run(tl, id="r1", repo=repo, started_at="2026-01-01T00:00:00")
    r2 = _mk_run(tl, id="r2", repo=repo, started_at="2026-01-01T00:00:01", status="passed")
    store.put(r1)
    store.put(r2)

    assert tl._runs_file(repo).exists()
    fresh = tl.RunStore(repo)                          # перечитывает с диска
    assert fresh.get("r1").id == "r1" and fresh.get("r2").status == "passed"
    assert [r.id for r in fresh.list()] == ["r2", "r1"]  # list() — по убыванию started_at
    assert fresh.get("nope") is None


def test_runstore_save_is_atomic_tmp_then_replace(tl, workspace):
    repo = workspace["repo"]
    store = tl.RunStore(repo)
    store.put(_mk_run(tl, id="r1", repo=repo))

    path = tl._runs_file(repo)
    tmp = path.with_suffix(".tmp")
    assert path.exists() and not tmp.exists()          # tmp не остаётся после .replace()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert len(data) == 1 and data[0]["id"] == "r1"


def test_runstore_trims_history_to_max_runs(tl, workspace, monkeypatch):
    monkeypatch.setattr(tl, "MAX_RUNS", 3)
    repo = workspace["repo"]
    store = tl.RunStore(repo)
    for i in range(6):
        store.put(_mk_run(tl, id=f"r{i}", repo=repo, started_at=f"2026-01-01T00:00:0{i}"))

    assert len(store.runs) == 3
    fresh = tl.RunStore(repo)
    assert sorted(fresh.runs.keys()) == ["r3", "r4", "r5"]   # оставлены последние по started_at


def test_find_run_across_repos(tl, workspace, tmp_path):
    import subprocess
    repo_a = workspace["repo"]
    repo_b = tmp_path / "repo_b"
    repo_b.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo_b, check=True)

    tl.RunStore(repo_a).put(_mk_run(tl, id="only-in-a", repo=repo_a))
    tl.RunStore(str(repo_b)).put(_mk_run(tl, id="only-in-b", repo=str(repo_b)))

    assert tl.find_run("only-in-a").repo == repo_a
    assert tl.find_run("only-in-b").repo == str(repo_b)
    assert tl.find_run("does-not-exist") is None


def test_find_run_no_tests_dir_returns_none(tl, workspace):
    assert not tl.TESTS_DIR.exists()
    assert tl.find_run("anything") is None


# ------------------------------------------------------------------ run()
async def test_run_passed(tl, workspace):
    repo = workspace["repo"]
    _write_fake_python(repo, run_out="...                                                    [100%]\n3 passed in 0.02s",
                        run_code=0)
    run_id = tl.new_run_id()
    await tl.run(repo, None, run_id)

    tr = tl.RunStore(repo).get(run_id)
    assert tr.status == "passed" and tr.returncode == 0 and tr.failed == [] and tr.finished_at


async def test_run_failed_collects_failed_nodeids(tl, workspace):
    repo = workspace["repo"]
    _write_fake_python(repo, run_out=(
        "F.F                                                              [100%]\n"
        "FAILED tests/test_sample.py::test_fail - AssertionError\n"
        "FAILED tests/test_other.py::TestClass::test_three - AssertionError\n"
        "2 failed, 1 passed in 0.05s"
    ), run_code=1)
    run_id = tl.new_run_id()
    await tl.run(repo, None, run_id)

    tr = tl.RunStore(repo).get(run_id)
    assert tr.status == "failed" and tr.returncode == 1
    assert tr.failed == ["tests/test_sample.py::test_fail", "tests/test_other.py::TestClass::test_three"]


async def test_run_no_venv_sets_error_status_not_exception(tl, workspace):
    repo = workspace["repo"]                          # .venv не создан
    run_id = tl.new_run_id()
    await tl.run(repo, None, run_id)                  # не должно бросить исключение

    tr = tl.RunStore(repo).get(run_id)
    assert tr.status == "error" and repo in tr.stderr and tr.returncode is None


async def test_run_emits_bus_events(tl, workspace):
    from app.core.events import bus
    repo = workspace["repo"]
    _write_fake_python(repo, run_out="hello from fake pytest\n1 passed in 0.01s", run_code=0)
    run_id = tl.new_run_id()

    seen = []
    async def listen(ev):
        if ev.task_id == run_id:
            seen.append(ev)
    bus.subscribe(listen)
    try:
        await tl.run(repo, None, run_id)
    finally:
        bus.unsubscribe(listen)

    kinds = [ev.kind for ev in seen]
    assert kinds[0] == "run.state" and seen[0].data["state"] == "running"
    assert kinds[-1] == "run.state" and seen[-1].data["state"] == "passed"
    output_lines = [ev.data["line"] for ev in seen if ev.kind == "run.output"]
    assert "hello from fake pytest" in output_lines


async def test_run_target_file_and_test_recorded_in_command(tl, workspace):
    repo = workspace["repo"]
    _write_fake_python(repo, run_out="1 passed in 0.01s", run_code=0)

    run_id = tl.new_run_id()
    await tl.run(repo, "tests/test_sample.py::test_ok", run_id)
    tr = tl.RunStore(repo).get(run_id)
    assert tr.target == "tests/test_sample.py::test_ok"
    assert tr.command.endswith("-q tests/test_sample.py::test_ok")

    run_id2 = tl.new_run_id()
    await tl.run(repo, "tests/test_sample.py", run_id2)
    tr2 = tl.RunStore(repo).get(run_id2)
    assert tr2.target == "tests/test_sample.py" and tr2.command.endswith("-q tests/test_sample.py")


# ------------------------------------------------------------------ REST /api/tests
def test_get_tests_unknown_repo_400(api):
    client, _repo = api
    resp = client.get("/api/tests", params={"repo": "/nowhere/at/all"})
    assert resp.status_code == 400


def test_get_tests_discover_via_rest(api, workspace):
    client, repo = api
    _write_fake_python(repo, collect_out="tests/test_sample.py::test_ok\n1 tests collected in 0.01s", collect_code=0)
    resp = client.get("/api/tests", params={"repo": repo})
    assert resp.status_code == 200
    assert resp.json() == {"tree": {"tests/test_sample.py": ["test_ok"]}}


def test_post_run_unknown_repo_400(api):
    client, _repo = api
    resp = client.post("/api/tests/run", json={"repo": "/nowhere/at/all"})
    assert resp.status_code == 400


def test_post_run_and_poll_passed(api, workspace):
    client, repo = api
    _write_fake_python(repo, run_out="3 passed in 0.02s", run_code=0)

    resp = client.post("/api/tests/run", json={"repo": repo})
    assert resp.status_code == 200
    run_id = resp.json()["run_id"]

    detail = _poll(client, run_id)
    assert detail["status"] == "passed" and detail["returncode"] == 0

    runs_list = client.get("/api/tests/runs", params={"repo": repo}).json()
    assert any(r["id"] == run_id for r in runs_list)
    summary = next(r for r in runs_list if r["id"] == run_id)
    assert "stdout" not in summary and "stderr" not in summary and "command" not in summary


def test_post_run_failed_and_events(api, workspace):
    client, repo = api
    _write_fake_python(repo, run_out=(
        "FAILED tests/test_sample.py::test_fail - AssertionError\n1 failed in 0.02s"
    ), run_code=1)

    run_id = client.post("/api/tests/run", json={"repo": repo}).json()["run_id"]
    detail = _poll(client, run_id)
    assert detail["status"] == "failed"
    assert detail["failed"] == ["tests/test_sample.py::test_fail"]

    events = client.get(f"/api/tests/runs/{run_id}/events").json()
    kinds = {e["kind"] for e in events}
    assert "run.output" in kinds and "run.state" in kinds
    states = [e["data"]["state"] for e in events if e["kind"] == "run.state"]
    assert states[0] == "running" and states[-1] == "failed"


def test_post_run_no_venv_reports_error_via_rest(api, workspace):
    client, repo = api                                 # .venv не создан
    run_id = client.post("/api/tests/run", json={"repo": repo}).json()["run_id"]
    detail = _poll(client, run_id)
    assert detail["status"] == "error"


def test_post_run_target_file_and_test_via_rest(api, workspace):
    client, repo = api
    _write_fake_python(repo, run_out="1 passed in 0.01s", run_code=0)

    for target in ("tests/test_sample.py", "tests/test_sample.py::test_ok"):
        run_id = client.post("/api/tests/run", json={"repo": repo, "target": target}).json()["run_id"]
        detail = _poll(client, run_id)
        assert detail["target"] == target and detail["command"].endswith(target)
