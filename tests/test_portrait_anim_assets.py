"""Живые портреты (ui/portrait_anim.js) читают кадры из ui/assets/portraits/anim/<base>_*.png,
где <base> — имя файла avatar из ростера без расширения. Проверяем, что кадры нарисованы для
каждого именного агента, а не только на глаз."""
from pathlib import Path

from app.core.roster import AVATAR_BY_NAME

ANIM_DIR = Path(__file__).resolve().parent.parent / "ui" / "assets" / "portraits" / "anim"
FRAME_SUFFIXES = ("neutral", "blink", "talk1", "talk2", "sheet")


def test_anim_dir_exists():
    assert ANIM_DIR.is_dir(), f"нет каталога с кадрами живых портретов: {ANIM_DIR}"


def test_every_roster_avatar_has_all_animation_frames():
    missing = []
    for name, avatar in AVATAR_BY_NAME.items():
        if not avatar:      # персонаж без портрета (например, Ральф до того, как владелец его нарисует)
            continue
        base = avatar.rsplit(".", 1)[0]
        for suffix in FRAME_SUFFIXES:
            f = ANIM_DIR / f"{base}_{suffix}.png"
            if not f.is_file():
                missing.append(str(f))
    assert not missing, f"не хватает кадров живых портретов: {missing}"


def test_sheet_is_1024x256_with_four_256px_frames():
    from PIL import Image

    for avatar in AVATAR_BY_NAME.values():
        if not avatar:
            continue
        base = avatar.rsplit(".", 1)[0]
        with Image.open(ANIM_DIR / f"{base}_sheet.png") as im:
            assert im.size == (1024, 256), f"{base}_sheet.png: ожидался размер 1024x256, получено {im.size}"
