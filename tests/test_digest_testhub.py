"""Логин в test_hub служебной учёткой (app/core/digest.py:_fetch_testhub_run и
клиент вокруг него), кэш cookie-сессии и карта AO_TESTHUB_PROJECTS. Без реального
test_hub/сети — свой фейковый httpx-клиент с маршрутизацией по (метод, url), по
образцу _RaisingClient из tests/test_digest.py, но с раздельными ответами на
POST /api/login и GET /api/projects/{project}/runs (respx и другие пакеты
опроса http не используются — их нет в requirements.txt)."""
from __future__ import annotations

import httpx
import pytest

from app.core.roster import Roster
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


class FakeResponse:
    def __init__(self, status_code=200, json_data=None, json_error=False):
        self.status_code = status_code
        self._json_data = json_data
        self._json_error = json_error

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("bad status", request=None, response=self)

    def json(self):
        if self._json_error:
            raise ValueError("битый json")
        return self._json_data


class FakeTestHubClient:
    """Одна и та же «сессия» на всё время жизни модуля digest (как настоящий
    httpx.AsyncClient-синглтон в _testhub_get_client). login_statuses/run_responses —
    последовательности ответов; последний элемент повторяется, если вызовов больше."""

    def __init__(self, login_statuses=(200,), run_responses=(FakeResponse(200, []),)):
        self.login_statuses = list(login_statuses)
        self.run_responses = list(run_responses)
        self.login_calls = 0
        self.get_urls: list[str] = []

    async def post(self, url, json=None):
        assert url == "/api/login"
        idx = min(self.login_calls, len(self.login_statuses) - 1)
        self.login_calls += 1
        return FakeResponse(self.login_statuses[idx])

    async def get(self, url):
        self.get_urls.append(url)
        idx = min(len(self.get_urls) - 1, len(self.run_responses) - 1)
        return self.run_responses[idx]


def _install(monkeypatch, digest, client: FakeTestHubClient) -> None:
    monkeypatch.setattr(digest.httpx, "AsyncClient", lambda *a, **kw: client)


def _run_payload(**overrides) -> dict:
    run = {
        "id": 42, "project": "demo", "stand": "local", "target": "smoke", "marker": "",
        "repeat": 1, "status": "passed", "started": "2026-09-29T10:00:00",
        "finished": "2026-09-29T10:05:00", "duration": 300, "requested_by": "tg_bot",
        "counts": {"passed": 10, "failed": 2, "broken": 1, "skipped": 0},
    }
    run.update(overrides)
    return run


async def test_fetch_testhub_run_maps_counts_from_latest_run(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(run_responses=(FakeResponse(200, [_run_payload()]),))
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)
    bucket = facts["repos"][repo]

    assert bucket["testhub"] == {
        "id": 42, "stand": "local", "status": "passed",
        "passed": 10, "failed": 2, "started": "2026-09-29T10:00:00",
    }
    assert client.login_calls == 1
    assert client.get_urls == [f"/api/projects/{bucket['name']}/runs"]


async def test_repo_to_project_map_is_used_when_present(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]  # папка называется "repo", не auto_tests_vshgu
    store.create("Т", "p", repo, "michael")

    monkeypatch.setattr(config, "AO_TESTHUB_PROJECTS", {"repo": "VSHGU"})
    client = FakeTestHubClient(run_responses=(FakeResponse(200, [_run_payload()]),))
    _install(monkeypatch, digest, client)

    await digest.collect_facts(store, roster, set(), testhub=True)

    assert client.get_urls == ["/api/projects/VSHGU/runs"]


async def test_repo_without_map_entry_uses_folder_name_as_is(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    monkeypatch.setattr(config, "AO_TESTHUB_PROJECTS", {"auto_tests_vshgu": "VSHGU"})
    client = FakeTestHubClient(run_responses=(FakeResponse(200, [_run_payload()]),))
    _install(monkeypatch, digest, client)

    await digest.collect_facts(store, roster, set(), testhub=True)

    assert client.get_urls == ["/api/projects/repo/runs"]


async def test_cookie_session_is_reused_across_collect_facts_calls(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(run_responses=(FakeResponse(200, [_run_payload()]),))
    _install(monkeypatch, digest, client)

    await digest.collect_facts(store, roster, set(), testhub=True)
    await digest.collect_facts(store, roster, set(), testhub=True)

    assert client.login_calls == 1
    assert len(client.get_urls) == 2


async def test_expired_session_triggers_single_relogin_and_retry(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(run_responses=(FakeResponse(401), FakeResponse(200, [_run_payload()])))
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)
    bucket = facts["repos"][repo]

    assert bucket["testhub"]["status"] == "passed"
    assert client.login_calls == 2
    assert len(client.get_urls) == 2


async def test_persistent_401_after_relogin_skips_testhub_block(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(run_responses=(FakeResponse(401), FakeResponse(401)))
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)   # не должно упасть
    bucket = facts["repos"][repo]

    assert "testhub" not in bucket
    assert client.login_calls == 2
    assert len(client.get_urls) == 2   # ровно одна повторная попытка, не бесконечный цикл


async def test_login_failure_skips_testhub_block_without_raising(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(login_statuses=(500,))
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)
    bucket = facts["repos"][repo]

    assert "testhub" not in bucket
    assert client.get_urls == []   # без сессии GET даже не пытались звать


async def test_non_200_runs_response_skips_testhub_block(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(run_responses=(FakeResponse(500),))
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)
    bucket = facts["repos"][repo]

    assert "testhub" not in bucket


async def test_broken_json_skips_testhub_block(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(run_responses=(FakeResponse(200, json_error=True),))
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)
    bucket = facts["repos"][repo]

    assert "testhub" not in bucket


async def test_network_error_on_runs_skips_testhub_block(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    class _NetworkFailClient(FakeTestHubClient):
        async def get(self, url):
            self.get_urls.append(url)
            raise httpx.ConnectTimeout("test_hub недоступен")

    client = _NetworkFailClient()
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)   # не должно упасть
    bucket = facts["repos"][repo]

    assert "testhub" not in bucket


async def test_empty_runs_list_skips_testhub_block(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")

    client = FakeTestHubClient(run_responses=(FakeResponse(200, []),))
    _install(monkeypatch, digest, client)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)
    bucket = facts["repos"][repo]

    assert "testhub" not in bucket
