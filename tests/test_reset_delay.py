from datetime import datetime

from app.core.office import reset_delay_seconds


def test_parses_pm_reset_time_and_waits_until_it():
    now = datetime(2026, 9, 22, 18, 0, 0)
    d = reset_delay_seconds("You've hit your session limit · resets 7:10pm (Europe/Moscow)", now=now)
    assert d == 70 * 60 + 120          # до 19:10 плюс 2 минуты запаса


def test_reset_time_already_passed_rolls_to_tomorrow():
    now = datetime(2026, 9, 22, 21, 0, 0)
    d = reset_delay_seconds("resets 2:10pm", now=now)
    assert d == (17 * 60 + 10) * 60 + 120


def test_no_reset_time_returns_none():
    assert reset_delay_seconds("API Error: 403 Request not allowed") is None
    assert reset_delay_seconds(None) is None
