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
