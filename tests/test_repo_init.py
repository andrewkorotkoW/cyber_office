"""POST /api/repos/new — создание нового проекта прямо из офиса (окно миссии/задачи, кнопка
«Репозиторий»), чтобы миссии/задачи под новую идею не приземлялись в чужой репозиторий по
ошибке. См. README «Новый проект из офиса»."""
from __future__ import annotations

import importlib
import json
import subprocess

import pytest

from app.core import repo_init

pytestmark = pytest.mark.asyncio   # часть тестов ниже (HTTP через TestClient) синхронные — ожидаемо
                                    # даёт PytestWarning про asyncio-марку на sync-тестах, как и в соседних файлах


# ------------------------------------------------------------------ app.core.repo_init напрямую
async def test_create_python_project_git_init_readme_and_smoke_test(tmp_path):
    path = await repo_init.create(tmp_path, "demo_app", "Тестовый проект", "python")
    assert path == str(tmp_path / "demo_app")
    p = tmp_path / "demo_app"
    assert (p / ".git").is_dir()
    readme = (p / "README.md").read_text(encoding="utf-8")
    assert "demo_app" in readme and "Тестовый проект" in readme
    assert (p / ".gitignore").exists()
    assert (p / "requirements.txt").read_text(encoding="utf-8") == ""
    assert (p / "tests" / "test_smoke.py").exists()
    branch = subprocess.run(["git", "-C", str(p), "branch", "--show-current"],
                             capture_output=True, text=True, check=True).stdout.strip()
    assert branch == "main"
    log = subprocess.run(["git", "-C", str(p), "log", "--oneline"], capture_output=True, text=True, check=True).stdout
    assert log.strip()   # есть первый коммит


async def test_create_empty_project_has_no_python_files(tmp_path):
    path = await repo_init.create(tmp_path, "just_empty", "", "empty")
    p = tmp_path / "just_empty"
    assert not (p / "requirements.txt").exists()
    assert not (p / "tests").exists()
    assert (p / ".gitignore").read_text(encoding="utf-8") == ""
    # без описания — README только с заголовком
    assert (p / "README.md").read_text(encoding="utf-8") == "# just_empty\n"
    assert path == str(p)


async def test_duplicate_name_raises(tmp_path):
    await repo_init.create(tmp_path, "dup", "", "empty")
    with pytest.raises(ValueError):
        await repo_init.create(tmp_path, "dup", "", "empty")


@pytest.mark.parametrize("bad_name", ["../evil", "with space", "im/path", "", "  "])
async def test_bad_name_raises(tmp_path, bad_name):
    with pytest.raises(ValueError):
        await repo_init.create(tmp_path, bad_name, "", "empty")


async def test_unknown_template_raises(tmp_path):
    with pytest.raises(ValueError):
        await repo_init.create(tmp_path, "ok_name", "", "rust")


# ------------------------------------------------------------------ HTTP: POST /api/repos/new
@pytest.fixture
def repo_client(workspace, monkeypatch, tmp_path):
    projects_dir = tmp_path / "projects"
    monkeypatch.setenv("AO_PROJECTS_DIR", str(projects_dir))
    monkeypatch.setenv("AO_FAKE", "1")
    from app import config
    importlib.reload(config)
    import app.main as main_module
    importlib.reload(main_module)
    from fastapi.testclient import TestClient
    with TestClient(main_module.app) as client:
        yield client, projects_dir


def test_api_creates_and_registers_repo(repo_client):
    client, projects_dir = repo_client
    resp = client.post("/api/repos/new", json={"name": "webapp", "description": "сайт", "template": "web", "venv": False})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    path = str(projects_dir / "webapp")
    assert data["path"] == path
    assert path in data["repos"]
    from app import config
    entries = json.loads((config.WORKSPACE / "repos.json").read_text(encoding="utf-8"))
    assert any(e["path"] == path for e in entries)


def test_api_duplicate_name_400(repo_client):
    client, _ = repo_client
    assert client.post("/api/repos/new", json={"name": "dup", "template": "empty"}).status_code == 200
    resp = client.post("/api/repos/new", json={"name": "dup", "template": "empty"})
    assert resp.status_code == 400
    assert "detail" in resp.json()


def test_api_bad_name_400(repo_client):
    client, _ = repo_client
    assert client.post("/api/repos/new", json={"name": "../evil", "template": "empty"}).status_code == 400
    assert client.post("/api/repos/new", json={"name": "with space", "template": "empty"}).status_code == 400


def test_api_python_template_schedules_venv_setup_in_background(repo_client, monkeypatch):
    """venv:true и шаблон python — .venv ставится в фоне (asyncio.create_task), не блокируя
    ответ; venv:false или другой шаблон — фоновой задачи быть не должно."""
    client, projects_dir = repo_client
    import app.main as main_module
    scheduled = []

    def fake_create_task(coro):
        scheduled.append(coro)
        coro.close()   # не выполняем реально — только фиксируем, что запланировали
        return None

    monkeypatch.setattr(main_module.asyncio, "create_task", fake_create_task)

    resp = client.post("/api/repos/new", json={"name": "pyproj", "template": "python"})
    assert resp.status_code == 200
    assert len(scheduled) == 1

    scheduled.clear()
    resp2 = client.post("/api/repos/new", json={"name": "pyproj_novenv", "template": "python", "venv": False})
    assert resp2.status_code == 200
    assert scheduled == []

    scheduled.clear()
    resp3 = client.post("/api/repos/new", json={"name": "emptyproj", "template": "empty"})
    assert resp3.status_code == 200
    assert scheduled == []
