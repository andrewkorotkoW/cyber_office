"""Telegram-мост: свежая сводка Ральфа по /digest и по тексту «что происходит?»,
форматирование сообщения (время 24ч, текст Ральфа, факты, тихие репозитории, test_hub,
обрезка до 3500 символов), портрет Ральфа в сводках (send_photo, caption vs отдельное
сообщение по лимиту 1024, кэш file_id) и фоновый цикл автосводки
(AO_TG_DIGEST_MIN/AO_TG_DIGEST_QUIET).
Весь Telegram замокан — реальной сети нет (см. tests/test_telegram_infra_notify.py и соседей)."""
from __future__ import annotations

import asyncio

import pytest

from app import config, telegram as tg

pytestmark = pytest.mark.asyncio


async def _wait(cond, timeout=3.0, step=0.02):
    for _ in range(int(timeout / step)):
        if cond():
            return True
        await asyncio.sleep(step)
    return False


async def _cancel(task: asyncio.Task) -> None:
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


# ------------------------------------------------------------------ фикстуры/фейки

class FakeUser:
    def __init__(self, uid: int) -> None:
        self.id = uid


class FakeSentMessage:
    """Результат message.answer(): помнит исходный текст-плейсхолдер отдельно от
    последующих edit_text (в реальном aiogram это один и тот же объект сообщения)."""

    def __init__(self, text: str) -> None:
        self.initial_text = text
        self.text = text
        self.edits: list[tuple[str, dict]] = []
        self.deleted = False

    async def edit_text(self, text: str, **kw) -> None:
        self.edits.append((text, kw))
        self.text = text

    async def delete(self) -> None:
        self.deleted = True


class FakeMessage:
    def __init__(self, uid: int, text: str) -> None:
        self.from_user = FakeUser(uid)
        self.text = text
        self.sent: list[FakeSentMessage] = []

    async def answer(self, text: str, **kw) -> FakeSentMessage:
        m = FakeSentMessage(text)
        self.sent.append(m)
        return m


class FakePhotoSize:
    def __init__(self, file_id: str) -> None:
        self.file_id = file_id


class FakeSentPhoto:
    """Ответ bot.send_photo(): aiogram отдаёт Message с photo[-1].file_id — по нему кэшируем."""

    def __init__(self, file_id: str = "remote-file-id-123") -> None:
        self.photo = [FakePhotoSize(file_id)]


class FakeBot:
    def __init__(self) -> None:
        self.sent: list[tuple[int, str, dict]] = []
        self.photos: list[tuple[int, object, dict]] = []

    async def send_message(self, uid, text, **kw):
        self.sent.append((uid, text, kw))

    async def send_photo(self, uid, photo, **kw):
        self.photos.append((uid, photo, kw))
        return FakeSentPhoto()


class FakeRoster:
    def get(self, name):
        return None


class FakeOffice:
    def __init__(self) -> None:
        self.roster = FakeRoster()


class FakeScheduler:
    """Подменяет DigestScheduler: refresh_now() отдаёт заранее заготовленные data,
    по одному элементу за вызов (последний повторяется), считает число вызовов."""

    def __init__(self, data) -> None:
        self._items = data if isinstance(data, list) else [data]
        self.calls = 0

    async def refresh_now(self) -> dict:
        self.calls += 1
        idx = min(self.calls - 1, len(self._items) - 1)
        return self._items[idx]


def _quiet_bucket(name: str) -> dict:
    return {"name": name, "missions": [], "running": [], "review": [], "todo": [],
            "failed_24h": [], "paused": False}


def _facts(review: bool = True) -> dict:
    repos = {
        "/tmp/proj_a": {
            "name": "proj_a", "missions": [],
            "running": [{"id": "t-0", "agent": "michael", "title": "Правит баг"}],
            "review": ([{"id": "t-1", "agent": "dwight", "title": "Новая фича"}] if review else []),
            "todo": [{"id": "t-2", "agent": "michael", "title": "x"},
                     {"id": "t-3", "agent": "michael", "title": "y"}],
            "failed_24h": [], "paused": False,
            "testhub": {"id": "run1", "passed": 42, "failed": 3},
        },
        "/tmp/quiet1": _quiet_bucket("quiet1"),
        "/tmp/quiet2": _quiet_bucket("quiet2"),
    }
    return {"repos": repos, "since_last": {"done_tasks": 3, "failed_tasks": 1, "cost_usd": 1.23}}


def _data(*, changed=True, generated_at="2026-09-29T23:15:07", fingerprint="fp1",
           facts=None, text="Ральф говорит по фактам") -> dict:
    return {"generated_at": generated_at, "facts": facts if facts is not None else _facts(),
            "text": text, "error": None, "fingerprint": fingerprint, "changed": changed, "seen": False}


def _facts_huge() -> dict:
    repos = {}
    for i in range(40):
        title = f"Очень длинная задача номер {i}, подробно описывающая, что именно делает агент " * 2
        repos[f"/tmp/repo{i}"] = {
            "name": f"repo{i}", "missions": [],
            "running": [{"id": f"r{i}", "agent": "michael", "title": title}],
            "review": [], "todo": [], "failed_24h": [], "paused": False,
        }
    return {"repos": repos, "since_last": {"done_tasks": 100, "failed_tasks": 5, "cost_usd": 12.34}}


@pytest.fixture
def tg_env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TG_ADMINS", {111})
    tg._office = FakeOffice()
    tg._pending_reason.clear()
    tg._pending_newrepo.clear()
    tg._ralph_photo_file_id = None
    portraits = tmp_path / "portraits"
    portraits.mkdir()
    (portraits / "ralph.png").write_bytes(b"fake-portrait")
    monkeypatch.setattr(tg, "PORTRAITS_DIR", portraits)
    yield portraits
    tg._office = None
    tg._pending_reason.clear()
    tg._pending_newrepo.clear()
    tg._ralph_photo_file_id = None


@pytest.fixture
def broadcast_env(tg_env, monkeypatch):
    bot = FakeBot()
    tg._bot = bot
    tg._last_sent_fingerprint = None
    tg._last_sent_at = None
    yield bot
    tg._bot = None
    tg._last_sent_fingerprint = None
    tg._last_sent_at = None


# ------------------------------------------------------------------ форматирование

def test_format_digest_message_has_24h_time_ralph_text_facts_quiet_and_testhub(tg_env):
    data = _data()
    text = tg._format_digest_message(data)

    assert "23:15" in text                      # 24ч, не 11:15 PM
    assert "AM" not in text and "PM" not in text
    assert "Ральф говорит по фактам" in text

    bucket = data["facts"]["repos"]["/tmp/proj_a"]
    fact_lines = tg._repo_lines(bucket)
    assert 3 <= len(fact_lines) <= 6
    assert "proj_a" in text
    assert "Правит баг" in text
    assert "Новая фича" in text and "на ревью" in text
    assert "⏳ в очереди: 2" in text

    assert "test_hub" in text and "❌ упал" in text and "42 прошло" in text and "3 упало" in text

    assert "😴 тихо:" in text
    quiet_line = next(line for line in text.splitlines() if line.startswith("😴 тихо:"))
    assert "quiet1" in quiet_line and "quiet2" in quiet_line


def test_format_digest_message_attaches_approve_reject_keyboard_for_review_tasks(tg_env):
    data = _data()
    kb = tg._review_kb(tg._digest_review_items(data["facts"]))
    assert kb is not None
    buttons = [b for row in kb.inline_keyboard for b in row]
    approve = next(b for b in buttons if b.callback_data == "ao:approve:t-1")
    reject = next(b for b in buttons if b.callback_data == "ao:reject:t-1")
    assert "✅" in approve.text and "Новая фича" in approve.text
    assert "❌" in reject.text


def test_review_keyboard_is_none_without_review_tasks():
    data = _data(facts=_facts(review=False))
    kb = tg._review_kb(tg._digest_review_items(data["facts"]))
    assert kb is None


def test_format_digest_message_truncates_to_3500_with_marker(tg_env):
    data = _data(facts=_facts_huge(), text="Ральф очень занят сегодня")
    text = tg._format_digest_message(data)

    assert len(text) <= tg.DIGEST_MAX_LEN
    assert text.endswith("(обрезано)")


# ------------------------------------------------------------------ портрет Ральфа в сводках

async def test_deliver_digest_uses_single_photo_with_caption_when_text_fits(tg_env, monkeypatch):
    bot = FakeBot()
    tg._bot = bot
    data = _data()                                  # короткая сводка — укладывается в лимит подписи (1024)
    text = tg._format_digest_message(data)
    assert len(text) <= tg.DIGEST_CAPTION_MAX

    await tg._deliver_digest([111], data, kb=None)

    assert len(bot.photos) == 1
    assert bot.sent == []                            # отдельного текстового сообщения не было
    uid, photo, kw = bot.photos[0]
    assert uid == 111
    assert kw.get("caption") == text
    assert kw.get("parse_mode") == "HTML"


async def test_deliver_digest_sends_short_header_photo_plus_full_text_when_too_long(tg_env):
    bot = FakeBot()
    tg._bot = bot
    data = _data(facts=_facts_huge(), text="Ральф очень занят сегодня")
    text = tg._format_digest_message(data)
    assert len(text) > tg.DIGEST_CAPTION_MAX

    kb = object()
    await tg._deliver_digest([111], data, kb=kb)

    assert len(bot.photos) == 1
    _uid, _photo, photo_kw = bot.photos[0]
    caption = photo_kw.get("caption")
    assert "Ральф" in caption and "сводка" in caption and "23:15" in caption
    assert len(caption) < 100                        # короткая шапка, не вся сводка

    assert len(bot.sent) == 1                         # полный текст — отдельным сообщением
    _uid2, sent_text, sent_kw = bot.sent[0]
    assert sent_text == text
    assert sent_kw.get("reply_markup") is kb          # кнопки на текстовом сообщении, как раньше


async def test_deliver_digest_caches_file_id_and_reuses_it(tg_env):
    bot = FakeBot()
    tg._bot = bot
    assert tg._ralph_photo_file_id is None

    await tg._deliver_digest([111], _data(fingerprint="fp1"), kb=None)
    _uid, first_photo, _kw = bot.photos[0]
    from aiogram.types import FSInputFile
    assert isinstance(first_photo, FSInputFile)       # первый раз — файлом
    assert tg._ralph_photo_file_id == "remote-file-id-123"

    await tg._deliver_digest([111], _data(fingerprint="fp2"), kb=None)
    _uid2, second_photo, _kw2 = bot.photos[1]
    assert second_photo == "remote-file-id-123"        # второй раз — по кэшированному file_id, не файлом


async def test_deliver_digest_falls_back_to_plain_text_without_portrait_file(tg_env):
    import shutil
    shutil.rmtree(tg.PORTRAITS_DIR)
    bot = FakeBot()
    tg._bot = bot
    data = _data()
    text = tg._format_digest_message(data)

    await tg._deliver_digest([111], data, kb=None)

    assert bot.photos == []
    assert len(bot.sent) == 1
    uid, sent_text, kw = bot.sent[0]
    assert uid == 111 and sent_text == text and kw.get("parse_mode") == "HTML"


# ------------------------------------------------------------------ /digest и текстовый триггер

async def test_digest_command_shows_placeholder_then_photo_with_caption(tg_env):
    tg._bot = FakeBot()
    tg._digest_scheduler = FakeScheduler(_data())
    msg = FakeMessage(111, "/digest")

    await tg.digest_cmd(msg)

    assert tg._digest_scheduler.calls == 1
    assert len(msg.sent) == 1
    placeholder = msg.sent[0]
    assert placeholder.initial_text == "🐾 Ральф думает…"
    assert placeholder.edits == []
    assert placeholder.deleted is True                # плейсхолдер убран, а не превращён в фото

    assert len(tg._bot.photos) == 1
    uid, _photo, kw = tg._bot.photos[0]
    assert uid == 111
    assert kw.get("parse_mode") == "HTML"
    assert kw.get("reply_markup") is not None
    assert "23:15" in kw.get("caption")
    assert "Ральф говорит по фактам" in kw.get("caption")
    tg._bot = None


@pytest.mark.parametrize("phrase", [
    "Что происходит?",
    "ЧТО ПРОИСХОДИТ",
    "что-происходит!!!",
    "Что ПРОИСХОДИТ???",
])
async def test_chto_proishodit_text_variants_trigger_refresh(tg_env, phrase):
    tg._bot = FakeBot()
    tg._digest_scheduler = FakeScheduler(_data())
    msg = FakeMessage(111, phrase)

    await tg.new_task(msg)

    assert tg._digest_scheduler.calls == 1
    assert len(msg.sent) == 1
    assert msg.sent[0].initial_text == "🐾 Ральф думает…"
    assert msg.sent[0].deleted is True
    assert len(tg._bot.photos) == 1
    assert "23:15" in tg._bot.photos[0][2].get("caption")
    tg._bot = None


async def test_digest_command_no_changes_shows_one_line_without_full_text(tg_env):
    tg._bot = FakeBot()
    tg._digest_scheduler = FakeScheduler(_data(changed=False, generated_at="2026-09-29T10:05:00"))
    msg = FakeMessage(111, "/digest")

    await tg.digest_cmd(msg)

    assert tg._digest_scheduler.calls == 1
    sent = msg.sent[0]
    assert len(sent.edits) == 1
    final_text, kw = sent.edits[0]
    assert final_text == "Без изменений с 10:05"
    assert kw == {}                             # без parse_mode/клавиатуры — это не полная сводка
    assert "proj_a" not in final_text
    assert sent.deleted is False                # «без изменений» правит плейсхолдер, не удаляет
    assert tg._bot.photos == []                 # и без фото, чтобы не спамить картинками
    tg._bot = None


# ------------------------------------------------------------------ фоновый цикл автосводки

async def test_broadcast_loop_disabled_when_interval_is_zero(broadcast_env, monkeypatch):
    monkeypatch.setattr(config, "AO_TG_DIGEST_MIN", 0)
    tg._digest_scheduler = FakeScheduler(_data())

    await tg._digest_broadcast_loop()             # возвращается сразу, цикл не запускается

    assert tg._digest_scheduler.calls == 0
    assert broadcast_env.sent == []
    assert broadcast_env.photos == []


async def test_broadcast_loop_sends_after_interval_not_immediately(broadcast_env, monkeypatch):
    monkeypatch.setattr(config, "AO_TG_DIGEST_MIN", 0.0008)   # ~0.05с, см. tests/test_digest.py:263
    tg._digest_scheduler = FakeScheduler(_data())

    task = asyncio.create_task(tg._digest_broadcast_loop())
    try:
        await asyncio.sleep(0)                      # первая же итерация ещё спит — отправки быть не должно
        assert broadcast_env.photos == []
        assert await _wait(lambda: len(broadcast_env.photos) >= 1, timeout=3)
        assert tg._digest_scheduler.calls == 1
    finally:
        await _cancel(task)


# ------------------------------------------------------------------ тихий режим

async def test_tick_broadcast_quiet_mode_silent_on_same_fingerprint_until_hour_passes(broadcast_env, monkeypatch):
    monkeypatch.setattr(config, "AO_TG_DIGEST_QUIET", True)
    tg._digest_scheduler = FakeScheduler(_data(fingerprint="fp1"))

    await tg._tick_broadcast()                      # первый тик — fingerprint новый, шлём полную сводку (фото)
    assert len(broadcast_env.photos) == 1
    assert "proj_a" in broadcast_env.photos[0][2].get("caption")

    await tg._tick_broadcast()                      # тот же fingerprint, час не прошёл — молчим
    assert len(broadcast_env.photos) == 1
    assert broadcast_env.sent == []

    from datetime import datetime, timedelta
    tg._last_sent_at = datetime.now() - timedelta(hours=1, minutes=1)
    await tg._tick_broadcast()                      # тот же fingerprint, час прошёл — короткая строка, без фото
    assert len(broadcast_env.photos) == 1            # фото не добавилось
    assert len(broadcast_env.sent) == 1
    last_text = broadcast_env.sent[-1][1]
    assert "час" in last_text.lower()
    assert "proj_a" not in last_text                # не полная сводка, а именно короткая строка


async def test_tick_broadcast_quiet_mode_false_sends_full_digest_every_tick(broadcast_env, monkeypatch):
    monkeypatch.setattr(config, "AO_TG_DIGEST_QUIET", False)
    tg._digest_scheduler = FakeScheduler(_data(fingerprint="fp1"))   # одинаковый fingerprint на каждый тик

    await tg._tick_broadcast()
    await tg._tick_broadcast()
    await tg._tick_broadcast()

    assert len(broadcast_env.photos) == 3
    for _uid, _photo, kw in broadcast_env.photos:
        assert "proj_a" in kw.get("caption")          # каждый раз полная сводка, а не короткая строка

    from aiogram.types import FSInputFile
    assert isinstance(broadcast_env.photos[0][1], FSInputFile)   # первый раз файлом
    assert broadcast_env.photos[1][1] == "remote-file-id-123"    # дальше — по кэшированному file_id
    assert broadcast_env.photos[2][1] == "remote-file-id-123"


async def test_tick_broadcast_sends_full_digest_when_fingerprint_changes(broadcast_env, monkeypatch):
    monkeypatch.setattr(config, "AO_TG_DIGEST_QUIET", True)
    tg._digest_scheduler = FakeScheduler([_data(fingerprint="fp1"), _data(fingerprint="fp2")])

    await tg._tick_broadcast()
    await tg._tick_broadcast()

    assert len(broadcast_env.photos) == 2               # разный fingerprint — тихий режим не глушит
    for _uid, _photo, kw in broadcast_env.photos:
        assert "proj_a" in kw.get("caption")
