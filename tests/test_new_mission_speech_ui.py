"""Структурная проверка «говорящих» реплик Дуайта/Майкла в шапках dlg-new/dlg-mission —
по образцу tests/test_planerka_ui.py: просто читает ui/index.html и ui/app.js как текст и
ищет реальные id/подключения скриптов, без парсинга DOM (поведение печати покрыто
tests/test_speech_js.py на node)."""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = (REPO_ROOT / "ui" / "index.html").read_text(encoding="utf-8")
APP_JS = (REPO_ROOT / "ui" / "app.js").read_text(encoding="utf-8")


def test_speech_js_is_loaded_before_app_js():
    speech_pos = INDEX_HTML.index('src="/ui/speech.js"')
    app_pos = INDEX_HTML.index('src="/ui/app.js"')
    assert speech_pos < app_pos


def test_new_and_mission_dialogs_have_speech_blocks():
    assert 'id="new-speech"' in INDEX_HTML
    assert 'class="speech"' in INDEX_HTML
    assert 'id="mission-speech"' in INDEX_HTML
    # три блока реплик: «Задача», «Миссия» и сводка «Что происходит?» (digest-speech, 25.09.2026)
    assert 'id="digest-speech"' in INDEX_HTML
    assert INDEX_HTML.count('class="speech"') == 3


def test_speech_blocks_sit_under_the_character_name_in_head_person():
    for speech_id, avatar_id in (("new-speech", "new-avatar"), ("mission-speech", "mission-avatar")):
        avatar_pos = INDEX_HTML.index(f'id="{avatar_id}"')
        who_pos = INDEX_HTML.index('class="who"', avatar_pos)
        speech_pos = INDEX_HTML.index(f'id="{speech_id}"', who_pos)
        assert avatar_pos < who_pos < speech_pos


def test_app_js_reuses_shared_typewriter_for_dwight_and_michael():
    assert "Speech.typeMessage" in APP_JS
    assert "Speech.DWIGHT_LINES" in APP_JS
    assert "Speech.MICHAEL_LINES" in APP_JS
    assert "function typeSpeech(" in APP_JS
    assert "speakSpeech = " in APP_JS


def test_dialog_close_cancels_pending_typing():
    assert "SPEECH_TYPING.dwight?.cancel" in APP_JS
    assert "SPEECH_TYPING.michael?.cancel" in APP_JS
    assert "SPEECH_TYPING.pam?.cancel" in APP_JS


def test_success_and_error_replies_are_wired_up():
    assert "Принял, отдаю в работу." in APP_JS
    assert "Понял. Иду планировать." in APP_JS
    assert "{ error: true }" in APP_JS
