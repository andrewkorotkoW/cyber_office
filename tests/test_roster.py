"""Ростер: поле avatar (портреты именных агентов) — дефолты и совместимость со старым roster.json."""
import json

from app.core.roster import AVATAR_BY_NAME, DEFAULT_ROSTER, Roster
from app import config


def test_default_roster_has_avatar_per_named_agent(workspace):
    roster = Roster()
    for name, avatar in AVATAR_BY_NAME.items():
        assert roster.get(name).avatar == avatar


def test_default_roster_entries_carry_avatar_field():
    for entry in DEFAULT_ROSTER:
        assert entry["avatar"] == AVATAR_BY_NAME[entry["name"]]


def test_old_roster_json_without_avatar_field_still_loads(workspace):
    old = [
        {"name": "michael", "title": "Майкл", "model": "sonnet", "desk": 0, "color": "#f05a46",
         "system": "Ты опытный разработчик-универсал."},
        {"name": "someone", "title": "Кто-то новый", "model": "sonnet", "desk": 1, "color": "#123456",
         "system": "Тест."},
    ]
    config.ROSTER_FILE.write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")
    roster = Roster()
    assert roster.get("michael").avatar == "beard.png"   # известное имя — подставлен дефолтный портрет
    assert roster.get("someone").avatar == ""             # незнакомое имя — пусто, фронтенд рисует без портрета


def test_roster_json_with_explicit_avatar_is_preserved(workspace):
    custom = [{"name": "michael", "title": "Майкл", "model": "sonnet", "desk": 0, "color": "#f05a46",
               "avatar": "custom.png", "system": "Тест."}]
    config.ROSTER_FILE.write_text(json.dumps(custom, ensure_ascii=False), encoding="utf-8")
    roster = Roster()
    assert roster.get("michael").avatar == "custom.png"


# ------------------------------------------------------------ миграция Оскара

def test_roster_json_without_oscar_gets_migrated_on_load(workspace):
    old = [
        {"name": "michael", "title": "Майкл", "model": "sonnet", "desk": 0, "color": "#f05a46",
         "avatar": "beard.png", "system": "Тест."},
        {"name": "dwight", "title": "Дуайт", "model": "sonnet", "desk": 1, "color": "#ff9a3c",
         "avatar": "cyborg.png", "system": "Тест."},
    ]
    config.ROSTER_FILE.write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")

    roster = Roster()
    oscar = roster.get("oscar")
    assert oscar is not None
    assert oscar.desk == 3
    assert oscar.color == "#39ff88"

    on_disk = json.loads(config.ROSTER_FILE.read_text(encoding="utf-8"))
    assert any(r.get("name") == "oscar" for r in on_disk)   # миграция дописана на диск


def test_roster_migration_is_idempotent_on_repeated_load(workspace):
    old = [{"name": "michael", "title": "Майкл", "model": "sonnet", "desk": 0, "color": "#f05a46",
            "avatar": "beard.png", "system": "Тест."}]
    config.ROSTER_FILE.write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")

    Roster()
    Roster()
    Roster()

    on_disk = json.loads(config.ROSTER_FILE.read_text(encoding="utf-8"))
    assert sum(1 for r in on_disk if r.get("name") == "oscar") == 1


def test_default_roster_already_has_oscar_no_migration_write(workspace):
    """roster.json, созданный «с нуля» (без файла) уже содержит Оскара из DEFAULT_ROSTER —
    миграционная ветка (дозапись) не должна срабатывать повторно."""
    roster = Roster()
    assert roster.get("oscar") is not None
    mtime_before = config.ROSTER_FILE.stat().st_mtime_ns

    Roster()
    on_disk = json.loads(config.ROSTER_FILE.read_text(encoding="utf-8"))
    assert sum(1 for r in on_disk if r.get("name") == "oscar") == 1
    assert config.ROSTER_FILE.stat().st_mtime_ns == mtime_before   # файл не переписывался
