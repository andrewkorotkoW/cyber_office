"""Пункт 5 «Надёжность»: WS-переподключение шлёт последние 200 событий одним `{kind:'history'}`
сообщением, и app.js прогоняет их через renderHistoryEvent (ui/app.js) — упрощённый рендер ленты
БЕЗ побочных эффектов (см. комментарий над функцией в app.js: без pushNotification, Floor.*,
loadState()/loadPlanerkaSummary()), в отличие от «живого» пути в ws.onmessage чуть ниже, который
на те же ev.kind вызывает и то, и другое. Раньше (до этого разделения) история приходила как
«живые» события и порождала до сотен дублирующихся уведомлений/анимаций при каждом переподключении.

Т.к. app.js не модуль (нет module.exports, работает поверх глобального document/$, как и весь
остальной файл) — по образцу tests/test_speech_js.py/tests/test_floor_js.py (подмена глобалов
перед запуском в node), но здесь вытаскиваем реальные исходники нужных функций/констант из
ui/app.js через regex (а не переписываем их логику руками) и гоняем в node с фейковым DOM."""
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
    """Вытаскивает `function NAME(...) { ... }` целиком по балансу фигурных скобок —
    без этого пришлось бы переписывать тело функции вручную и рисковать тестировать
    не тот код, что реально исполняется в браузере."""
    m = re.search(rf"function {re.escape(name)}\([^)]*\)\s*\{{", APP_JS)
    assert m, f"{name} не найдена в ui/app.js"
    depth, i = 0, m.end() - 1
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


HARNESS_SNIPPETS = [
    _extract_line("const $ ="),
    # esc() в app.js использует `??`, которого нет в node 12 (единственный node в этом
    # окружении, см. tests/test_floor_js.py/test_speech_js.py — тот же skipif на node);
    # эквивалент по поведению для строк, которые сюда попадают, без `??`.
    "const esc = (s) => String(s === null || s === undefined ? '' : s)"
    ".replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]));",
    _extract_line("const fmtTime ="),
    _extract_line("const summary ="),
    _extract_line("const agentTitle ="),
    _extract_line("const avatarImg ="),
    _extract_line("const STATUS_RU ="),
    _extract_line("const MISSION_RU ="),
    _extract_line("const term ="),
    _extract_function("termLine"),
    _extract_function("renderPlanerkaEvents"),
    _extract_function("renderHistoryEvent"),
]


def _run_node(events: list[dict]) -> dict:
    fake_dom = """
    const CALLS = { pushNotification: 0, envelope: 0, setState: 0, loadState: 0, loadPlanerkaSummary: 0 };
    function pushNotification() { CALLS.pushNotification++; }
    const Floor = { envelope: () => CALLS.envelope++, setState: () => CALLS.setState++ };
    function loadState() { CALLS.loadState++; }
    function loadPlanerkaSummary() { CALLS.loadPlanerkaSummary++; }

    function makeEl() {
      return { className: '', innerHTML: '', style: {}, children: [],
               appendChild(el) { this.children.push(el); },
               get firstChild() { return this.children[0]; },
               removeChild(el) { this.children.splice(this.children.indexOf(el), 1); },
               scrollTop: 0, scrollHeight: 0 };
    }
    const TERM_EL = makeEl();
    const document = { createElement: () => makeEl(), querySelector: (s) => (s === '#term' ? TERM_EL : null) };
    let STATE = { agents: [] };
    let REPO_FILTER = '';
    let EVENTS_BUFFER = [];
    """
    driver = f"""
    const events = {json.dumps(events, ensure_ascii=False)};
    events.forEach(renderHistoryEvent);
    console.log(JSON.stringify({{ calls: CALLS, termLines: TERM_EL.children.length,
                                   bufferLen: EVENTS_BUFFER.length }}));
    """
    script = fake_dom + "\n".join(HARNESS_SNIPPETS) + driver
    proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


# ------------------------------------------------------------ события, которые в «живом»
# обработчике ws.onmessage (ниже renderHistoryEvent в том же файле) вызывают pushNotification
# и/или Floor.envelope/Floor.setState — здесь это те же ev.kind, но по «историческому» пути.
HISTORY_EVENTS = [
    {"kind": "agent.tool", "agent": "michael", "data": {"summary": "Read x.py"}},
    {"kind": "agent.text", "agent": "michael", "data": {"text": "смотрю репозиторий"}},
    {"kind": "agent.state", "agent": "dwight", "data": {"state": "working"}},
    {"kind": "mission.created", "data": {"mission": {"status": "planning", "goal": "цель миссии", "repo": "/r"}}},
    {"kind": "mission.updated", "data": {"mission": {"status": "done", "goal": "цель миссии", "repo": "/r"}}},
    {"kind": "task.created", "agent": "michael", "data": {"task": {"title": "Т", "repo": "/r"}}},
    {"kind": "task.updated", "agent": "michael",
     "data": {"task": {"status": "review", "title": "Т", "repo": "/r", "result": "готово, всё ок"}}},
    {"kind": "task.updated", "agent": "michael",
     "data": {"task": {"status": "failed", "title": "Т", "repo": "/r", "result": "упало"}}},
    {"kind": "task.updated", "agent": "michael", "data": {"task": {"status": "done", "title": "Т", "repo": "/r"}}},
    {"kind": "task.infra_failure", "agent": "michael", "data": {"task": {"title": "Т"}, "reason": "рейт лимит"}},
    {"kind": "repo.after_merge", "data": {"repo": "/r", "ok": True, "output": ""}},
    {"kind": "scenario.recorded", "data": {"name": "demo", "error": None}},
]


def test_history_replay_never_calls_notifications_or_floor():
    out = _run_node(HISTORY_EVENTS)
    assert out["calls"] == {"pushNotification": 0, "envelope": 0, "setState": 0,
                             "loadState": 0, "loadPlanerkaSummary": 0}


def test_history_replay_still_renders_lines_for_recognised_kinds():
    """Проверяет, что тест не проходит вхолостую из-за сломанного стенда: renderHistoryEvent
    должен реально отрисовать строки для распознанных kind (task.updated с result даёт две
    строки — статус и резюме), а необрабатываемые kind (infra_failure/after_merge) — ни одной."""
    out = _run_node(HISTORY_EVENTS)
    assert out["termLines"] > 0
    assert out["bufferLen"] == min(out["termLines"], 10)

    only_ignored = [e for e in HISTORY_EVENTS if e["kind"] in ("task.infra_failure", "repo.after_merge")]
    out_ignored = _run_node(only_ignored)
    assert out_ignored["termLines"] == 0
    assert out_ignored["calls"] == {"pushNotification": 0, "envelope": 0, "setState": 0,
                                     "loadState": 0, "loadPlanerkaSummary": 0}
