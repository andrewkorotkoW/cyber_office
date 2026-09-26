"""Смоук-тесты чистых хелперов модалки «Что происходит?» (ui/app.js) — по образцу
tests/test_new_repo_ui.py/tests/test_ws_history_js.py: вытаскиваем реальные исходники нужных
функций через regex (тело не переписываем руками) и гоняем в node без DOM.

Два пункта из замечаний владельца после демо 26.09:
1) время сводки — 24-часовой формат («13:30», не «01:30 PM»);
2) репозитории без миссий/задач/падений/пауз сворачиваются в одну строку «тихо»."""
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


def _run_node(snippets: list[str], expr: str):
    script = "\n".join(snippets) + f"\nconsole.log(JSON.stringify({expr}));"
    proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


# ------------------------------------------------------------ пункт 1: 24-часовой формат времени

FMT_TIME_SNIPPETS = [_extract_line("const fmtTime =")]


@pytest.mark.parametrize("iso, expected", [
    ("2026-09-26T13:30:00", "13:30"),
    ("2026-09-26T01:05:00", "01:05"),
    ("2026-09-26T00:00:00", "00:00"),
    ("2026-09-26T23:59:00", "23:59"),
])
def test_fmt_time_is_24_hour_and_never_has_am_pm(iso, expected):
    out = _run_node(FMT_TIME_SNIPPETS, f"fmtTime({json.dumps(iso)})")
    assert out == expected
    assert "AM" not in out and "PM" not in out


# ------------------------------------------------------------ пункт 3: сворачивание тихих репозиториев

QUIET_SNIPPETS = [
    _extract_function("isDigestRepoQuiet"),
    _extract_function("splitDigestRepos"),
]


def _repo(name, **kw):
    base = {"name": name, "missions": [], "running": [], "review": [], "todo": [], "failed_24h": [], "paused": False}
    base.update(kw)
    return base


def test_repo_with_no_activity_and_no_pause_is_quiet():
    out = _run_node(QUIET_SNIPPETS, f"isDigestRepoQuiet({json.dumps(_repo('sandbox'))})")
    assert out is True


@pytest.mark.parametrize("field, value", [
    ("missions", [{"id": "m1", "goal": "g", "done": 0, "total": 1}]),
    ("running", [{"id": "t1", "title": "t", "agent": "michael"}]),
    ("review", [{"id": "t1", "title": "t", "agent": "michael"}]),
    ("todo", [{"id": "t1", "title": "t", "agent": "michael"}]),
    ("failed_24h", [{"id": "t1", "title": "t", "agent": "michael"}]),
    ("paused", True),
])
def test_repo_with_any_activity_or_pause_is_not_quiet(field, value):
    out = _run_node(QUIET_SNIPPETS, f"isDigestRepoQuiet({json.dumps(_repo('r', **{field: value}))})")
    assert out is False


def test_split_puts_active_repos_first_and_groups_quiet_ones():
    repos = [
        _repo("sandbox"),
        _repo("bike_fit", running=[{"id": "t1", "title": "t", "agent": "michael"}]),
        _repo("Velo_bot"),
        _repo("net_doctor", paused=True),
    ]
    out = _run_node(QUIET_SNIPPETS, f"splitDigestRepos({json.dumps(repos)})")
    assert [r["name"] for r in out["active"]] == ["bike_fit", "net_doctor"]
    assert [r["name"] for r in out["quiet"]] == ["sandbox", "Velo_bot"]


def test_split_with_no_repos_gives_empty_groups():
    out = _run_node(QUIET_SNIPPETS, "splitDigestRepos([])")
    assert out == {"active": [], "quiet": []}
