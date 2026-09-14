"""Telegram-мост: портрет агента прикладывается фото только на первом уведомлении по задаче."""
import pytest

from app import config, telegram as tg
from app.core.events import Event
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


class FakeBot:
    def __init__(self):
        self.messages: list[tuple[int, str]] = []
        self.photos: list[tuple[int, str, str]] = []

    async def send_message(self, uid, text, **kw):
        self.messages.append((uid, text))

    async def send_photo(self, uid, photo, caption=None, **kw):
        self.photos.append((uid, photo.filename, caption))


class FakeAgent:
    def __init__(self, avatar):
        self.avatar = avatar
        self.title = "Майкл · генералист"


class FakeRoster:
    def __init__(self, avatar="beard.png"):
        self._avatar = avatar

    def get(self, name):
        return FakeAgent(self._avatar)


class FakeOffice:
    def __init__(self, store, roster):
        self.store = store
        self.roster = roster


@pytest.fixture
def tg_env(workspace, monkeypatch):
    monkeypatch.setattr(config, "TG_ADMINS", {111})
    tg._portrait_sent.clear()
    store = TaskStore(config.TASKS_FILE)
    t = store.create("Задача", "промпт", workspace["repo"])
    bot = FakeBot()
    tg._bot, tg._office = bot, FakeOffice(store, FakeRoster())
    yield bot, store, t
    tg._bot, tg._office = None, None
    tg._portrait_sent.clear()


async def test_portrait_sent_once_per_task(tg_env):
    bot, store, t = tg_env
    ev = Event(kind="task.updated", agent="michael", task_id=t.id, data={"task": {"status": "review"}})

    await tg._on_event(ev)
    assert len(bot.photos) == 1
    assert bot.photos[0][1] == "beard.png"
    assert len(bot.messages) == 1     # обычная карточка идёт как раньше, следом за фото

    t.status = "failed"; store.update(t)
    ev2 = Event(kind="task.updated", agent="michael", task_id=t.id, data={"task": {"status": "failed"}})
    await tg._on_event(ev2)
    assert len(bot.photos) == 1        # повторно фото по той же задаче не шлём
    assert len(bot.messages) == 2


async def test_no_avatar_skips_photo_but_keeps_card(tg_env, monkeypatch):
    bot, store, t = tg_env
    tg._office.roster = FakeRoster(avatar="")
    ev = Event(kind="task.updated", agent="michael", task_id=t.id, data={"task": {"status": "review"}})

    await tg._on_event(ev)
    assert bot.photos == []
    assert len(bot.messages) == 1
