"""Сводка «Что происходит?» (app/core/digest.py): collect_facts на фикстурном
store/roster, кэш digest.json (атомарная запись, narrate) и DigestScheduler
(таймер + отпечаток фактов). spawner claude никогда не запускается по-настоящему —
narrate подменяется FakeNarrator/шпионом (см. память про зависание pytest-asyncio
на реальном subprocess claude)."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.core.events import bus
from app.core.roster import Roster
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


async def _wait(cond, timeout=3.0, step=0.02):
    for _ in range(int(timeout / step)):
        if cond():
            return True
        await asyncio.sleep(step)
    return False


class SpyNarrator:
    def __init__(self, text: str = "текст сводки") -> None:
        self.calls = 0
        self.text = text

    async def narrate(self, facts: dict) -> str:
        self.calls += 1
        return self.text


# ------------------------------------------------------------ collect_facts

async def test_collect_facts_covers_missions_review_failed_and_paused(workspace):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]

    m = store.create_mission("Навести порядок", repo)
    m.status = "active"
    mission_tasks = [store.create(f"Подзадача {i}", "p", repo, "michael", mission_id=m.id) for i in range(5)]
    for t in mission_tasks[:2]:
        t.status = "done"; store.update(t)
    store.save()

    review_task = store.create("На ревью", "p", repo, "michael")
    review_task.status = "review"; store.update(review_task)

    failed_task = store.create("Упала", "p", repo, "dwight")
    failed_task.status = "failed"; failed_task.error = "API error: 529 overloaded"
    store.update(failed_task)

    paused = {repo}

    facts = await digest.collect_facts(store, roster, paused, testhub=False)

    bucket = facts["repos"][repo]
    assert bucket["paused"] is True

    assert len(bucket["missions"]) == 1
    mission_entry = bucket["missions"][0]
    assert mission_entry["id"] == m.id and mission_entry["done"] == 2 and mission_entry["total"] == 5
    assert mission_entry["status"] == "active"

    assert [e["id"] for e in bucket["review"]] == [review_task.id]

    # 3 незавершённые подзадачи миссии остаются в статусе todo и тоже попадают в bucket
    assert len(bucket["todo"]) == 3
    assert {e["id"] for e in bucket["todo"]} == {t.id for t in mission_tasks[2:]}

    assert len(bucket["failed_24h"]) == 1
    failed_entry = bucket["failed_24h"][0]
    assert failed_entry["id"] == failed_task.id
    assert failed_entry["error"] == "API error: 529 overloaded"

    agent_names = {a["name"] for a in facts["agents"]}
    assert {"michael", "dwight", "pam", "ralph"} <= agent_names

    assert "generated_at" in facts and "since_last" in facts


async def test_collect_facts_excludes_failed_task_older_than_24h(workspace):
    from datetime import datetime, timedelta

    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]

    old = store.create("Старая", "p", repo, "michael")
    old.status = "failed"
    old.error = "давно упала"
    # store.update() позвал бы touch() и переписал updated_at на "сейчас" — правим поле
    # напрямую на уже сохранённом объекте и сохраняем без touch()
    old.updated_at = (datetime.now() - timedelta(hours=30)).isoformat(timespec="seconds")
    store.save()

    facts = await digest.collect_facts(store, roster, set(), testhub=False)
    bucket = facts["repos"].get(repo, {"failed_24h": []})
    assert bucket["failed_24h"] == []


async def test_collect_facts_skips_testhub_block_when_unreachable(workspace, monkeypatch):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    repo = workspace["repo"]
    store.create("Т", "p", repo, "michael")   # хоть одна задача — чтобы появился bucket репозитория

    class _RaisingClient:
        def __init__(self, *a, **kw) -> None: pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url):
            raise httpx.ConnectTimeout("test_hub недоступен")

    monkeypatch.setattr(digest.httpx, "AsyncClient", _RaisingClient)

    facts = await digest.collect_facts(store, roster, set(), testhub=True)   # не должно упасть
    bucket = facts["repos"][repo]
    assert "testhub" not in bucket


# ------------------------------------------------------------ кэш / narrate

async def test_fake_narrator_returns_nonempty_text():
    from app.core import digest

    narrator = digest.FakeNarrator()
    text = await narrator.narrate({"repos": {}, "since_last": {"done_tasks": 1, "failed_tasks": 0}})
    assert isinstance(text, str) and text.strip()


def test_save_cache_is_atomic_and_load_cache_roundtrips(workspace):
    from app.core import digest

    data = {"generated_at": "2026-09-25T10:00:00", "facts": {"repos": {}, "agents": []},
            "text": "Сводка готова.", "changed": True, "seen": False}
    digest.save_cache(data)

    assert digest.DIGEST_FILE.exists()
    assert not digest.DIGEST_FILE.with_suffix(".tmp").exists()   # tmp убран .replace()-ом

    loaded = digest.load_cache()
    assert loaded == data


def test_load_cache_returns_none_when_missing_or_corrupt(workspace):
    from app.core import digest

    assert digest.load_cache() is None

    digest.DIGEST_FILE.parent.mkdir(parents=True, exist_ok=True)
    digest.DIGEST_FILE.write_text("{не json", encoding="utf-8")
    assert digest.load_cache() is None


def test_mark_seen_sets_flag_and_noop_without_cache(workspace):
    from app.core import digest

    digest.mark_seen()                        # нет кэша — тихо ничего не делает
    assert digest.DIGEST_FILE.exists() is False

    digest.save_cache({"generated_at": "x", "facts": {}, "text": None, "changed": False, "seen": False})
    digest.mark_seen()
    assert digest.load_cache()["seen"] is True


def test_fingerprint_is_stable_for_same_facts_and_differs_otherwise():
    from app.core import digest

    facts = {"repos": {"a": {"todo": []}}, "agents": [], "since_last": {}}
    assert digest.fingerprint(facts) == digest.fingerprint(json.loads(json.dumps(facts)))
    other = {"repos": {"a": {"todo": ["x"]}}, "agents": [], "since_last": {}}
    assert digest.fingerprint(facts) != digest.fingerprint(other)


# ------------------------------------------------------------ DigestScheduler

async def test_scheduler_tick_without_changes_skips_narrate_and_event(workspace):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    narrator = SpyNarrator()
    sched = digest.DigestScheduler(store, roster, set(), narrator, interval_min=1000, testhub=False)

    events = []
    async def listen(ev):
        if ev.kind == "digest.ready":
            events.append(ev)
    bus.subscribe(listen)
    try:
        await sched._tick(force=False)         # первый тик — кэша ещё не было, это тоже "изменение"
        assert narrator.calls == 1 and len(events) == 1

        await sched._tick(force=False)         # факты не менялись
        assert narrator.calls == 1              # narrate не позвали повторно
        assert len(events) == 1                 # новое событие не отправлено
    finally:
        bus.unsubscribe(listen)


async def test_scheduler_tick_with_changes_calls_narrate_once_and_emits_event(workspace):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    narrator = SpyNarrator()
    sched = digest.DigestScheduler(store, roster, set(), narrator, interval_min=1000, testhub=False)

    events = []
    async def listen(ev):
        if ev.kind == "digest.ready":
            events.append(ev)
    bus.subscribe(listen)
    try:
        await sched._tick(force=False)
        assert narrator.calls == 1 and len(events) == 1

        store.create("Новая задача", "p", workspace["repo"], "michael")   # факты изменились

        await sched._tick(force=False)
        assert narrator.calls == 2              # ровно один новый вызов narrate
        assert len(events) == 2                  # ровно одно новое событие
    finally:
        bus.unsubscribe(listen)


async def test_scheduler_refresh_now_forces_narrate_even_without_changes(workspace):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    narrator = SpyNarrator()
    sched = digest.DigestScheduler(store, roster, set(), narrator, interval_min=1000, testhub=False)

    await sched._tick(force=False)
    assert narrator.calls == 1

    data = await sched.refresh_now()            # ничего не изменилось, но force=True
    assert narrator.calls == 2
    assert data["seen"] is False


async def test_scheduler_background_loop_calls_tick(workspace):
    from app import config
    from app.core import digest

    store, roster = TaskStore(config.TASKS_FILE), Roster()
    narrator = SpyNarrator()
    sched = digest.DigestScheduler(store, roster, set(), narrator, interval_min=0.0008, testhub=False)
    sched.start()
    try:
        assert await _wait(lambda: narrator.calls >= 1, timeout=3)
    finally:
        sched.stop()
