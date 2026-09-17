"""Telegram-мост: /newproject и кнопка «➕ Новый проект» в выборе репозитория — создание
нового проекта прямо из чата, без реального бота (см. README «Новый проект из офиса»)."""
from __future__ import annotations

import pytest

from app import config, telegram as tg
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


class FakeUser:
    def __init__(self, uid: int) -> None:
        self.id = uid


class FakeMessage:
    def __init__(self, uid: int, text: str) -> None:
        self.from_user = FakeUser(uid)
        self.text = text
        self.answers: list[str] = []

    async def answer(self, text: str, **kw):
        self.answers.append(text)
        return self


class FakeRoster:
    def get(self, name):
        return None


class FakeOffice:
    def __init__(self, store: TaskStore) -> None:
        self.store = store
        self.roster = FakeRoster()

    async def create_task(self, title, prompt, repo, agent):
        return self.store.create(title, prompt, repo, agent)


@pytest.fixture
def tg_env(workspace, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "TG_ADMINS", {111})
    projects_dir = tmp_path / "projects"
    monkeypatch.setattr(config, "PROJECTS_DIR", projects_dir)
    # .venv реально не ставим — repo_init.create() (git init/README/commit) тестируется
    # по-настоящему в tests/test_repo_init.py, а тут мокаем только фоновый setup_venv
    from app.core import repo_init

    async def fake_setup_venv(path):
        pass

    monkeypatch.setattr(repo_init, "setup_venv", fake_setup_venv)
    store = TaskStore(config.TASKS_FILE)
    registered: list[str] = []
    tg._office = FakeOffice(store)
    tg._repos_fn = lambda: [workspace["repo"]] + registered
    tg._after_merge_cmd_fn = lambda repo: None
    tg._register_repo_fn = lambda path: registered.append(path)
    tg._current_repo.clear()
    tg._pending_task.clear()
    tg._pending_newrepo.clear()
    yield store, projects_dir, registered
    tg._office = None
    tg._current_repo.clear()
    tg._pending_task.clear()
    tg._pending_newrepo.clear()


async def test_newproject_command_creates_and_registers_repo(tg_env):
    store, projects_dir, registered = tg_env
    msg = FakeMessage(111, "/newproject demo Тестовый проект")
    await tg.newproject(msg)

    assert (projects_dir / "demo").is_dir()
    assert registered == [str(projects_dir / "demo")]
    assert tg._current_repo[111] == str(projects_dir / "demo")     # стал текущим для этого чата
    assert any("demo" in a for a in msg.answers)


async def test_newproject_without_args_shows_usage_and_creates_nothing(tg_env):
    store, projects_dir, registered = tg_env
    msg = FakeMessage(111, "/newproject")
    await tg.newproject(msg)

    assert registered == []
    assert any("newproject" in a.lower() for a in msg.answers)


async def test_newproject_resumes_pending_task_in_new_repo(tg_env):
    """Задача ждала выбора репозитория (см. new_task) — после создания проекта уходит в него."""
    store, projects_dir, registered = tg_env
    tg._pending_task[111] = ("michael", "сделать нечто")
    msg = FakeMessage(111, "/newproject demo2")
    await tg.newproject(msg)

    tasks = list(store.tasks.values())
    assert len(tasks) == 1
    assert tasks[0].repo == str(projects_dir / "demo2")
    assert 111 not in tg._pending_task


async def test_newproject_invalid_name_reports_error_without_registering(tg_env):
    store, projects_dir, registered = tg_env
    msg = FakeMessage(111, "/newproject bad$name")
    await tg.newproject(msg)

    assert registered == []
    assert any("не вышло" in a.lower() for a in msg.answers)


async def test_newrepo_button_flow_via_pending_text(tg_env):
    """Клик «➕ Новый проект» переводит чат в режим ожидания имени — следующий обычный
    текст (не команда) уходит в _create_repo, а не создаёт задачу."""
    store, projects_dir, registered = tg_env
    tg._pending_newrepo.add(111)
    msg = FakeMessage(111, "webapp Небольшой сайт-визитка")
    await tg.new_task(msg)

    assert (projects_dir / "webapp").is_dir()
    assert registered == [str(projects_dir / "webapp")]
    assert 111 not in tg._pending_newrepo
    assert len(store.tasks) == 0            # это было имя проекта, а не задача


def test_repo_kb_offers_new_project_button(tg_env):
    kb = tg._repo_kb()
    texts = [b.text for row in kb.inline_keyboard for b in row]
    assert "➕ Новый проект" in texts
