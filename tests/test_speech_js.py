"""Смоук-тест ui/speech.js через node (без DOM) — тот же принцип, что и tests/test_portrait_anim_js.py:
seeded random даёт детерминированный выбор реплики, а typeMessage гоняем на фейковом el-объекте
с ручными addEventListener/removeEventListener (без глобального EventTarget — не во всех node
он есть) вместо настоящего DOM-элемента."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

SPEECH_JS = Path(__file__).resolve().parent.parent / "ui" / "speech.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node недоступен")

FAKE_EL = """
class FakeEl {
  constructor() { this.textContent = ''; this._listeners = {}; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { const l = this._listeners[type]; if (l) this._listeners[type] = l.filter((f) => f !== fn); }
  click() { (this._listeners.click || []).slice().forEach((f) => f()); }
}
"""


def _run_node(js: str):
    proc = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_module_exports_expected_api():
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        console.log(JSON.stringify(Object.keys(S).sort()));
    """)
    assert out == sorted(["DWIGHT_LINES", "MICHAEL_LINES", "pickLine", "typeMessage"])


def test_line_sets_have_four_to_six_short_variants():
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        console.log(JSON.stringify({{ dwight: S.DWIGHT_LINES, michael: S.MICHAEL_LINES }}));
    """)
    for lines in (out["dwight"], out["michael"]):
        assert 4 <= len(lines) <= 6
        assert len(set(lines)) == len(lines)  # без повторов
        for line in lines:
            assert 0 < len(line) <= 90


def test_pick_line_is_deterministic_for_same_seed():
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        const seededPick = (seed) => {{
            let a = seed >>> 0;
            const rnd = () => {{ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }};
            return S.pickLine(S.DWIGHT_LINES, rnd);
        }};
        console.log(JSON.stringify({{ a: seededPick(42), b: seededPick(42), c: seededPick(7) }}));
    """)
    assert out["a"] == out["b"]
    assert out["a"] in _run_node(f"const S = require({json.dumps(str(SPEECH_JS))}); console.log(JSON.stringify(S.DWIGHT_LINES));")


def test_pick_line_covers_the_whole_set_over_many_draws():
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        let a = 1;
        const rnd = () => {{ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }};
        const seen = new Set();
        for (let i = 0; i < 500; i++) seen.add(S.pickLine(S.MICHAEL_LINES, rnd));
        console.log(JSON.stringify({{ seen: [...seen].sort(), all: [...S.MICHAEL_LINES].sort() }}));
    """)
    assert out["seen"] == out["all"]


def test_type_message_fills_element_letter_by_letter_then_resolves():
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        {FAKE_EL}
        const el = new FakeEl();
        const snapshots = [];
        (async () => {{
            const p = S.typeMessage(el, 'привет', 1);
            const iv = setInterval(() => snapshots.push(el.textContent), 1);
            await p;
            clearInterval(iv);
            console.log(JSON.stringify({{ final: el.textContent, grew: snapshots.some(s => s.length > 0 && s.length < 6) }}));
        }})();
    """)
    assert out["final"] == "привет"
    assert out["grew"], "текст должен появляться по буквам, а не сразу целиком"


def test_type_message_skips_to_full_text_on_click():
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        {FAKE_EL}
        const el = new FakeEl();
        (async () => {{
            const p = S.typeMessage(el, 'длинный текст для проверки пропуска печати кликом', 50);
            setTimeout(() => el.click(), 5);
            await p;
            console.log(JSON.stringify({{ final: el.textContent }}));
        }})();
    """)
    assert out["final"] == "длинный текст для проверки пропуска печати кликом"


def test_type_message_cancel_stops_further_typing_and_resolves():
    """При закрытии диалога печать останавливается — cancel() ведёт себя как клик-пропуск."""
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        {FAKE_EL}
        const el = new FakeEl();
        (async () => {{
            const p = S.typeMessage(el, 'эта печать будет отменена на середине', 50);
            let resolved = false;
            p.then(() => {{ resolved = true; }});
            setTimeout(() => {{
                p.cancel();
                const afterCancel = el.textContent;
                setTimeout(() => {{
                    console.log(JSON.stringify({{ resolved, afterCancel, unchanged: el.textContent === afterCancel }}));
                }}, 150);
            }}, 20);
        }})();
    """)
    assert out["afterCancel"] == "эта печать будет отменена на середине"
    assert out["unchanged"], "после cancel() не должно быть новых setTimeout, дописывающих текст"


def test_type_message_empty_text_resolves_immediately_and_cancel_is_noop():
    out = _run_node(f"""
        const S = require({json.dumps(str(SPEECH_JS))});
        {FAKE_EL}
        const el = new FakeEl();
        (async () => {{
            const p = S.typeMessage(el, '', 50);
            await p;
            p.cancel();
            console.log(JSON.stringify({{ final: el.textContent }}));
        }})();
    """)
    assert out["final"] == ""
