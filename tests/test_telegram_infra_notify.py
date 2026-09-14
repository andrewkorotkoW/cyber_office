"""Telegram-мост: уведомление про сбой API — только на первом падении и на
исчерпании попыток, без реального бота и без реального Claude."""
import pytest

from app import config, telegram as tg
from app.core.events import Event
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


class FakeBot:
    def __init__(self):
        self.sent: list[tuple[int, str]] = []

    async def send_message(self, uid, text, **kw):
        self.sent.append((uid, text))


class FakeRoster:
    def get(self, name):
        return None


class FakeOffice:
    def __init__(self, store):
        self.store = store
        self.roster = FakeRoster()


@pytest.fixture
def tg_env(workspace, monkeypatch):
    monkeypatch.setattr(config, "TG_ADMINS", {111})
    store = TaskStore(config.TASKS_FILE)
    t = store.create("Задача", "промпт", workspace["repo"])
    bot = FakeBot()
    tg._bot, tg._office = bot, FakeOffice(store)
    yield bot, store, t
    tg._bot, tg._office = None, None


async def test_first_failure_and_exhausted_send_two_messages(tg_env):
    bot, store, t = tg_env
    first = Event(kind="task.infra_failure", agent="michael", task_id=t.id, data={
        "task": {"id": t.id, "title": t.title}, "reason": "API Error: 403", "exhausted": False,
        "attempt": 1, "max_retries": 3, "delay": 120,
    })
    await tg._on_event(first)
    assert len(bot.sent) == 1
    assert "повторю через 2 мин" in bot.sent[0][1]

    exhausted = Event(kind="task.infra_failure", agent="michael", task_id=t.id, data={
        "task": {"id": t.id, "title": t.title}, "reason": "API Error: 403", "exhausted": True,
        "attempt": 3, "max_retries": 3,
    })
    await tg._on_event(exhausted)
    assert len(bot.sent) == 2
    assert "автоповтор" in bot.sent[1][1].lower()


async def test_generic_failed_card_suppressed_while_auto_retry_pending(tg_env):
    bot, store, t = tg_env
    t.status = "failed"; t.auto_retry_at = "2026-01-01T00:00:00"; store.update(t)
    ev = Event(kind="task.updated", agent="michael", task_id=t.id, data={"task": {"status": "failed"}})

    await tg._on_event(ev)
    assert bot.sent == []                  # ждём отдельного уведомления от task.infra_failure

    t.auto_retry_at = None; store.update(t)
    await tg._on_event(ev)
    assert len(bot.sent) == 1              # обычное падение (без автоповтора) — карточка как раньше
