from app.core.office import looks_unfinished


def test_detects_waiting_for_background_run():
    assert looks_unfinished("I'll pause here and wait for the background test run to finish before continuing.")
    assert looks_unfinished("I'll wait for this final run to complete rather than poll.")
    assert looks_unfinished("I'll stop checking now and wait for the background task notification to arrive.")
    assert looks_unfinished("Ожидаю уведомления о завершении фонового прогона теста статьи, дальше продолжу по его результату.")
    assert looks_unfinished("Жду результата прогона.")
    assert looks_unfinished("The pytest run auto-moved to background after exceeding 180s. I'll wait for its completion notification rather than poll.")


def test_real_summary_is_not_unfinished():
    text = "## Резюме\n\nКоммит abc. Прогнал `pytest -m groups` — 4 passed, 2 xfailed (дефект стенда). Осталось: ничего."
    assert not looks_unfinished(text)
    assert not looks_unfinished("")
