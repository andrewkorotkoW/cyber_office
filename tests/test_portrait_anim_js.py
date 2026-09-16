"""Смоук-тест чистых функций ui/portrait_anim.js через node (без DOM) — тот же принцип, что и
tests/test_floor_js.py: детерминированное расписание морганий и последовательность кадров речи
проверяем на seeded random, а не на реальных таймерах."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

PORTRAIT_JS = Path(__file__).resolve().parent.parent / "ui" / "portrait_anim.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node недоступен")


def _run_node(js: str):
    proc = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_module_exports_expected_pure_functions():
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        console.log(JSON.stringify(Object.keys(P).sort()));
    """)
    expected = sorted([
        "FRAMES", "mulberry32", "hashStr", "nextBlinkDelay", "isDoubleBlink", "talkFrameSequence",
        "frameBgPosition", "fileBase", "BLINK_MIN_MS", "BLINK_MAX_MS", "DOUBLE_BLINK_CHANCE",
        "TALK_FRAME_MIN_MS", "TALK_FRAME_MAX_MS",
    ])
    assert out == expected


def test_mulberry32_is_deterministic_for_same_seed():
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        const a = P.mulberry32(42), b = P.mulberry32(42);
        const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
        console.log(JSON.stringify({{ seqA, seqB }}));
    """)
    assert out["seqA"] == out["seqB"]
    assert len(set(out["seqA"])) == 3   # не залипает на одном значении


def test_file_base_strips_extension():
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        console.log(JSON.stringify({{
          beard: P.fileBase('beard.png'),
          cyborg: P.fileBase('cyborg.png'),
          noext: P.fileBase('pink'),
          empty: P.fileBase(''),
        }}));
    """)
    assert out == {"beard": "beard", "cyborg": "cyborg", "noext": "pink", "empty": ""}


def test_frame_bg_position_spans_full_sheet_in_order():
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        console.log(JSON.stringify(P.FRAMES.map(P.frameBgPosition)));
    """)
    assert out[0] == "0%" and out[-1] == "100%"
    percents = [float(p.rstrip('%')) for p in out]
    assert percents == sorted(percents)   # neutral|blink|talk1|talk2 идут по возрастанию слева направо
    for i in range(1, len(percents)):
        assert abs((percents[i] - percents[i - 1]) - 100 / 3) < 1e-6


def test_blink_delay_is_within_documented_range_and_worried_halves_it():
    """Моргание — каждые 2.5-6с (ТЗ п.2); worried моргает чаще — вдвое быстрее."""
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        const rnd = P.mulberry32(7);
        const calm = [], worried = [];
        for (let i = 0; i < 500; i++) {{ calm.push(P.nextBlinkDelay(rnd, false)); worried.push(P.nextBlinkDelay(rnd, true)); }}
        console.log(JSON.stringify({{ calm, worried, min: P.BLINK_MIN_MS, max: P.BLINK_MAX_MS }}));
    """)
    for d in out["calm"]:
        assert out["min"] <= d <= out["max"]
    for d in out["worried"]:
        assert out["min"] / 2 <= d <= out["max"] / 2


def test_double_blink_chance_matches_documented_constant():
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        const rnd = P.mulberry32(3);
        let doubles = 0;
        const n = 20000;
        for (let i = 0; i < n; i++) if (P.isDoubleBlink(rnd)) doubles++;
        console.log(JSON.stringify({{ rate: doubles / n, expected: P.DOUBLE_BLINK_CHANCE }}));
    """)
    assert abs(out["rate"] - out["expected"]) < 0.02


def test_talk_frame_sequence_is_deterministic_and_ends_neutral():
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        const seqA = P.talkFrameSequence(2000, P.mulberry32(99));
        const seqB = P.talkFrameSequence(2000, P.mulberry32(99));
        console.log(JSON.stringify({{ seqA, seqB }}));
    """)
    assert out["seqA"] == out["seqB"]
    seq = out["seqA"]
    assert seq, "последовательность речи не должна быть пустой"
    assert seq[-1] == {"frame": "neutral", "delay": 0}
    for step in seq[:-1]:
        assert step["frame"] in ("talk1", "talk2", "neutral")
        assert 90 <= step["delay"] <= 140.0001


def test_talk_frame_sequence_alternates_mouth_frames_not_just_one_repeated():
    out = _run_node(f"""
        const P = require({json.dumps(str(PORTRAIT_JS))});
        const seq = P.talkFrameSequence(2500, P.mulberry32(5));
        console.log(JSON.stringify(seq.map(s => s.frame)));
    """)
    mouth_frames = {f for f in out if f in ("talk1", "talk2")}
    assert mouth_frames == {"talk1", "talk2"}, f"ожидались оба кадра рта, получено {mouth_frames}"
