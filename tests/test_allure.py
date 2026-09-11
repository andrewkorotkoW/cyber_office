"""Тесты app.core.allure: сбор allure-results в testlab.run(), разбор result.json в
отчёт (passed/failed/broken/skipped + шаги/вложения), fallback без allure-pytest,
тренд по прогонам, поиск/запуск Allure CLI и REST /api/tests/report|trend|attachments|allure-*."""
from __future__ import annotations

import importlib
import json
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.asyncio


def _write_fake_python(repo: str, *, collect_out: str = "", collect_code: int = 0,
                        run_out: str = "", run_code: int = 0) -> None:
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


def _mark_allure_installed(repo: str) -> None:
    """Имитирует наличие пакета allure-pytest в site-packages репозитория — этого
    достаточно, т.к. app.core.testlab._allure_pytest_installed смотрит на диск, а не
    запускает python репозитория (там в тестах — поддельный shell-скрипт)."""
    site = Path(repo) / ".venv" / "lib" / "python3.11" / "site-packages"
    (site / "allure_pytest").mkdir(parents=True, exist_ok=True)


def _write_allure_result(results_dir: Path, **kw) -> None:
    results_dir.mkdir(parents=True, exist_ok=True)
    defaults = dict(
        uuid="u1", name="test_ok", fullName="tests/test_sample.py::test_ok",
        status="passed", start=1000, stop=1500,
        labels=[{"name": "suite", "value": "tests/test_sample.py"}],
        steps=[], attachments=[], statusDetails={},
    )
    defaults.update(kw)
    (results_dir / f"{defaults['uuid']}-result.json").write_text(json.dumps(defaults), encoding="utf-8")


@pytest.fixture
def tl(workspace):
    from app.core import testlab
    importlib.reload(testlab)
    return testlab


@pytest.fixture
def al(workspace, tl):
    from app.core import allure
    return allure


@pytest.fixture
def api(workspace, monkeypatch):
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


# ------------------------------------------------------------------ сбор allure-results в run()
async def test_run_without_allure_pytest_leaves_allure_false(tl, workspace):
    repo = workspace["repo"]
    _write_fake_python(repo, run_out="1 passed in 0.01s", run_code=0)
    run_id = tl.new_run_id()
    await tl.run(repo, None, run_id)

    tr = tl.RunStore(repo).get(run_id)
    assert tr.allure is False
    assert tr.allure_error and "allure-pytest" in tr.allure_error
    assert "--alluredir" not in tr.command


async def test_run_with_allure_pytest_adds_alluredir_flag(tl, workspace):
    repo = workspace["repo"]
    _mark_allure_installed(repo)
    _write_fake_python(repo, run_out="1 passed in 0.01s", run_code=0)
    run_id = tl.new_run_id()
    await tl.run(repo, None, run_id)

    tr = tl.RunStore(repo).get(run_id)
    assert tr.allure is True and tr.allure_error is None
    assert f"--alluredir={tl.allure_results_dir(repo, run_id)}" in tr.command
    assert tl.allure_results_dir(repo, run_id).is_dir()


async def test_run_target_command_unaffected_when_no_allure(tl, workspace):
    """Регрессия: без allure-pytest формат команды не должен был поменяться."""
    repo = workspace["repo"]
    _write_fake_python(repo, run_out="1 passed in 0.01s", run_code=0)
    run_id = tl.new_run_id()
    await tl.run(repo, "tests/test_sample.py::test_ok", run_id)
    tr = tl.RunStore(repo).get(run_id)
    assert tr.command.endswith("-q tests/test_sample.py::test_ok")


# ------------------------------------------------------------------ build_report: allure-results
def test_build_report_parses_allure_results(al, tl, workspace):
    repo = workspace["repo"]
    run_id = "r1"
    tl.RunStore(repo).put(tl.TestRun(id=run_id, repo=repo, target=None, command="pytest -q",
                                      status="failed", allure=True))
    results_dir = tl.allure_results_dir(repo, run_id)
    _write_allure_result(results_dir, uuid="u1", name="test_ok", fullName="tests/test_sample.py::test_ok",
                          status="passed")
    _write_allure_result(results_dir, uuid="u2", name="test_fail", fullName="tests/test_sample.py::test_fail",
                          status="failed", statusDetails={"message": "boom", "trace": "Traceback..."},
                          steps=[{"name": "step one", "status": "failed", "steps": []}],
                          attachments=[{"name": "screenshot", "source": "u2-attachment.png", "type": "image/png"}])
    _write_allure_result(results_dir, uuid="u3", name="test_broken", fullName="tests/test_other.py::test_broken",
                          status="broken")
    _write_allure_result(results_dir, uuid="u4", name="test_skip", fullName="tests/test_other.py::test_skip",
                          status="skipped")

    report = al.build_report(repo, run_id)
    assert report["source"] == "allure"
    assert report["counts"] == {"passed": 1, "failed": 1, "broken": 1, "skipped": 1, "unknown": 0}
    by_name = {t["name"]: t for t in report["tests"]}
    assert by_name["test_ok"]["file"] == "tests/test_sample.py"
    assert by_name["test_fail"]["message"] == "boom"
    assert by_name["test_fail"]["steps"][0]["name"] == "step one"
    assert by_name["test_fail"]["attachments"][0]["source"] == "u2-attachment.png"


def test_build_report_unknown_run_raises_lookup_error(al, workspace):
    with pytest.raises(LookupError):
        al.build_report(workspace["repo"], "nope")


# ------------------------------------------------------------------ build_report: fallback
def test_build_report_fallback_without_allure(al, tl, workspace):
    repo = workspace["repo"]
    run_id = "r2"
    tl.RunStore(repo).put(tl.TestRun(
        id=run_id, repo=repo, target=None, command="pytest -q", status="failed", allure=False,
        allure_error="allure-pytest не найден в .venv репозитория",
        stdout="FAILED tests/test_sample.py::test_fail - AssertionError\n1 failed, 2 passed in 0.02s",
        failed=["tests/test_sample.py::test_fail"],
    ))

    report = al.build_report(repo, run_id)
    assert report["source"] == "fallback"
    assert report["counts"]["passed"] == 2 and report["counts"]["failed"] == 1
    assert report["tests"][0]["uid"] == "tests/test_sample.py::test_fail"
    assert report["tests"][0]["status"] == "failed"
    assert report["allure_error"] == "allure-pytest не найден в .venv репозитория"


# ------------------------------------------------------------------ тренд
def test_build_trend_orders_ascending_and_computes_pass_rate(al, tl, workspace):
    repo = workspace["repo"]
    tl.RunStore(repo).put(tl.TestRun(id="r1", repo=repo, target=None, command="x", status="passed",
                                      started_at="2026-01-01T00:00:00", stdout="3 passed in 0.1s"))
    tl.RunStore(repo).put(tl.TestRun(id="r2", repo=repo, target=None, command="x", status="failed",
                                      started_at="2026-01-01T00:00:01", stdout="1 failed, 2 passed in 0.2s",
                                      failed=["a::b"]))

    trend = al.build_trend(repo, limit=20)
    assert [t["run_id"] for t in trend] == ["r1", "r2"]
    assert trend[0]["pass_rate"] == 1.0
    assert round(trend[1]["pass_rate"], 3) == round(2 / 3, 3)


def test_build_trend_respects_limit(al, tl, workspace):
    repo = workspace["repo"]
    for i in range(5):
        tl.RunStore(repo).put(tl.TestRun(id=f"r{i}", repo=repo, target=None, command="x", status="passed",
                                          started_at=f"2026-01-01T00:00:0{i}"))
    trend = al.build_trend(repo, limit=2)
    assert [t["run_id"] for t in trend] == ["r3", "r4"]


# ------------------------------------------------------------------ вложения: защита от path traversal
def test_attachment_path_rejects_traversal(al, tl, workspace):
    repo = workspace["repo"]
    d = tl.allure_results_dir(repo, "r1")
    d.mkdir(parents=True, exist_ok=True)
    (d / "shot.png").write_bytes(b"png")

    assert al.attachment_path(repo, "r1", "shot.png") == d / "shot.png"
    assert al.attachment_path(repo, "r1", "../secret") is None
    assert al.attachment_path(repo, "r1", "sub/other") is None
    assert al.attachment_path(repo, "r1", "nope.png") is None


# ------------------------------------------------------------------ Allure CLI
def test_find_allure_bin_prefers_configured_path(al, monkeypatch, tmp_path):
    fake_bin = tmp_path / "allure"
    fake_bin.write_text("#!/bin/sh\n")
    fake_bin.chmod(0o755)
    monkeypatch.setattr(al.config, "ALLURE_BIN", str(fake_bin))
    assert al.find_allure_bin() == str(fake_bin)


def test_find_allure_bin_falls_back_to_path(al, monkeypatch):
    monkeypatch.setattr(al.config, "ALLURE_BIN", "")
    monkeypatch.setattr(al.shutil, "which", lambda name: "/usr/local/bin/allure" if name == "allure" else None)
    assert al.find_allure_bin() == "/usr/local/bin/allure"


def test_find_allure_bin_none_when_unavailable(al, monkeypatch):
    monkeypatch.setattr(al.config, "ALLURE_BIN", "")
    monkeypatch.setattr(al.shutil, "which", lambda name: None)
    assert al.find_allure_bin() is None


def test_can_open_requires_bin_and_results(al, tl, monkeypatch, workspace):
    repo = workspace["repo"]
    monkeypatch.setattr(al, "find_allure_bin", lambda: None)
    assert al.can_open(repo, "r1") is False

    monkeypatch.setattr(al, "find_allure_bin", lambda: "/usr/local/bin/allure")
    assert al.can_open(repo, "r1") is False   # каталога результатов ещё нет

    d = tl.allure_results_dir(repo, "r1")
    d.mkdir(parents=True, exist_ok=True)
    (d / "u1-result.json").write_text("{}", encoding="utf-8")
    assert al.can_open(repo, "r1") is True


async def test_generate_and_open_raises_without_bin(al, monkeypatch, workspace):
    monkeypatch.setattr(al, "find_allure_bin", lambda: None)
    with pytest.raises(RuntimeError, match="не найден"):
        await al.generate_and_open(workspace["repo"], "r1")


async def test_generate_and_open_raises_without_results(al, monkeypatch, workspace):
    monkeypatch.setattr(al, "find_allure_bin", lambda: "/usr/local/bin/allure")
    with pytest.raises(RuntimeError, match="allure-results"):
        await al.generate_and_open(workspace["repo"], "r1")


# ------------------------------------------------------------------ REST
def test_get_report_unknown_repo_400(api):
    client, _repo = api
    resp = client.get("/api/tests/report", params={"repo": "/nowhere", "run_id": "x"})
    assert resp.status_code == 400


def test_get_report_unknown_run_404(api):
    client, repo = api
    resp = client.get("/api/tests/report", params={"repo": repo, "run_id": "nope"})
    assert resp.status_code == 404


def test_get_report_and_trend_via_rest(api, workspace):
    client, repo = api
    _write_fake_python(repo, run_out="1 passed in 0.01s", run_code=0)
    run_id = client.post("/api/tests/run", json={"repo": repo}).json()["run_id"]
    _poll(client, run_id)

    report = client.get("/api/tests/report", params={"repo": repo, "run_id": run_id}).json()
    assert report["run_id"] == run_id and report["source"] == "fallback"

    trend = client.get("/api/tests/trend", params={"repo": repo, "limit": 5}).json()
    assert any(t["run_id"] == run_id for t in trend)


def test_attachment_rest_serves_file_and_404s(api, workspace):
    client, repo = api
    from app.core import testlab
    testlab.RunStore(repo).put(testlab.TestRun(id="r1", repo=repo, target=None, command="x", status="passed"))
    d = testlab.allure_results_dir(repo, "r1")
    d.mkdir(parents=True, exist_ok=True)
    (d / "shot.png").write_bytes(b"\x89PNG")

    ok = client.get("/api/tests/attachments/r1/shot.png")
    assert ok.status_code == 200 and ok.content == b"\x89PNG"

    assert client.get("/api/tests/attachments/r1/missing.png").status_code == 404
    assert client.get("/api/tests/attachments/nope/shot.png").status_code == 404


def test_allure_available_rest_reflects_can_open(api, monkeypatch):
    client, repo = api
    import app.main as main_module
    monkeypatch.setattr(main_module.allure, "can_open", lambda repo, run_id: True)
    assert client.get("/api/tests/allure-available", params={"repo": repo, "run_id": "r1"}).json() == {"available": True}
    monkeypatch.setattr(main_module.allure, "can_open", lambda repo, run_id: False)
    assert client.get("/api/tests/allure-available", params={"repo": repo, "run_id": "r1"}).json() == {"available": False}


def test_allure_open_rest_ok_and_error(api, monkeypatch):
    client, repo = api
    import app.main as main_module

    async def ok(repo, run_id):
        return None
    monkeypatch.setattr(main_module.allure, "generate_and_open", ok)
    assert client.post("/api/tests/allure-open", json={"repo": repo, "run_id": "r1"}).json() == {"ok": True}

    async def fail(repo, run_id):
        raise RuntimeError("allure недоступен")
    monkeypatch.setattr(main_module.allure, "generate_and_open", fail)
    resp = client.post("/api/tests/allure-open", json={"repo": repo, "run_id": "r1"})
    assert resp.status_code == 400 and "allure недоступен" in resp.json()["detail"]


def test_allure_open_rest_unknown_repo_400(api):
    client, _repo = api
    resp = client.post("/api/tests/allure-open", json={"repo": "/nowhere", "run_id": "r1"})
    assert resp.status_code == 400
