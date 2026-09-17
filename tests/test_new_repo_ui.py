"""Смоук-тест чистой логики выбора «➕ Новый проект…» в селекте репозитория (ui/app.js) —
isNewRepoOption/mixingWarning не трогают DOM, поэтому гоняем их в node без фейкового
document (см. tests/test_graph_js.py). Вытаскиваем реальные исходники через regex, как
в tests/test_ws_history_js.py — тело функций не переписываем руками."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

APP_JS_PATH = Path(__file__).resolve().parent.parent / "ui" / "app.js"
APP_JS = APP_JS_PATH.read_text(encoding="utf-8")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node недоступен")


def _extract_function(name: str) -> str:
    m = re.search(rf"function {re.escape(name)}\([^)]*\)\s*\{{", APP_JS)
    assert m, f"{name} не найдена в ui/app.js"
    depth = 0
    for i in range(m.end() - 1, len(APP_JS)):
        if APP_JS[i] == "{":
            depth += 1
        elif APP_JS[i] == "}":
            depth -= 1
            if depth == 0:
                return APP_JS[m.start():i + 1]
    raise AssertionError(f"не нашёл конец функции {name}")


def _extract_line(prefix: str) -> str:
    m = re.search(rf"^{re.escape(prefix)}.*;$", APP_JS, re.MULTILINE)
    assert m, f"строка {prefix!r} не найдена в ui/app.js"
    return m.group(0)


SNIPPETS = "\n".join([
    _extract_function("isNewRepoOption"),
    _extract_line("const MIX_WORDS_RE ="),
    _extract_function("mixingWarning"),
])


def _run_node(expr: str):
    script = SNIPPETS + f"\nconsole.log(JSON.stringify({expr}));"
    proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_new_project_option_value_is_recognised():
    assert _run_node("isNewRepoOption('__new__')") is True
    assert _run_node("isNewRepoOption('/Users/x/projects/demo')") is False
    assert _run_node("isNewRepoOption('')") is False


def test_no_warning_when_new_project_option_selected():
    assert _run_node("mixingWarning('давай новый проект: сайт', '__new__')") is None


def test_no_warning_for_sandbox_even_with_trigger_words():
    assert _run_node("mixingWarning('сделай новый сайт', '/Users/x/projects/sandbox')") is None


def test_no_warning_without_trigger_words():
    assert _run_node("mixingWarning('поправь опечатку в README', '/Users/x/projects/bike_fit')") is None


def test_warning_shown_for_non_sandbox_repo_with_trigger_word():
    out = _run_node("mixingWarning('нужен новый сайт с лендингом', '/Users/x/projects/bike_fit')")
    assert out is not None
    assert "bike_fit" in out


@pytest.mark.parametrize("word", ["новый проект", "сайт", "приложение", "бот"])
def test_warning_triggers_on_each_keyword(word):
    out = _run_node(f"mixingWarning({json.dumps('нужен ' + word)}, '/Users/x/projects/bike_fit')")
    assert out is not None
