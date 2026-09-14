"""Смоук-тест чистых функций ui/floor.js через node (без DOM) — тот же module.exports, что
экспортирует floor.js для тестов dwight'а. Требует node на PATH (есть в окружении разработки)."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

FLOOR_JS = Path(__file__).resolve().parent.parent / "ui" / "floor.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node недоступен")


def _run_node(js: str):
    proc = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_desk_positions_still_work():
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        console.log(JSON.stringify({{
          desk: F.deskX(0, 3),
          positions: F.computeDeskPositions(3, []).length,
        }}));
    """)
    assert out["desk"] > 0
    assert out["positions"] == 3


@pytest.mark.parametrize("n", range(1, 7))
def test_cyberpunk_desk_positions_clear_obstacles_and_each_other(n):
    """computeDeskPositions(n, sceneObstacleRects()) не должен давать столам, чей реальный
    bounding box (footprint DESK, экспортированный как DESK_FOOT) пересекается с препятствиями
    сцены или друг с другом — раньше стол на краю полосы CYBER_DESK_BANDS мог повиснуть над креслом."""
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        const rects = F.sceneObstacleRects();
        const positions = F.computeDeskPositions({n}, rects);
        console.log(JSON.stringify({{ positions, rects, foot: F.DESK_FOOT, minGap: F.DESK_MIN_GAP }}));
    """)
    positions, rects, foot, min_gap = out["positions"], out["rects"], out["foot"], out["minGap"]
    assert len(positions) == n

    def bbox(p):
        return {"x": p["x"] - foot["halfW"], "y": p["y"] - foot["top"], "w": foot["halfW"] * 2, "h": foot["top"] + foot["bottom"]}

    def overlap(a, b):
        return a["x"] < b["x"] + b["w"] and a["x"] + a["w"] > b["x"] and a["y"] < b["y"] + b["h"] and a["y"] + a["h"] > b["y"]

    for pos in positions:
        box = bbox(pos)
        hits = [r for r in rects if overlap(box, r)]
        assert not hits, f"n={n} стол {pos} пересекает препятствия {hits}"

    by_row = {}
    for p in positions:
        by_row.setdefault(p["y"], []).append(p["x"])
    for y, xs in by_row.items():
        xs.sort()
        for i in range(1, len(xs)):
            assert xs[i] - xs[i - 1] >= min_gap, f"n={n} ряд y={y}: столы слишком близко {xs}"


def test_named_agents_get_their_own_character():
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        console.log(JSON.stringify({{
          michael: F.characterFor('michael'),
          dwight: F.characterFor('dwight'),
          pam: F.characterFor('pam'),
          unknown: F.characterFor('someone_else'),
        }}));
    """)
    assert out == {"michael": "michael", "dwight": "dwight", "pam": "pam", "unknown": None}


def test_char_heads_are_distinct_and_well_formed():
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        const heads = {{}};
        for (const name of ['michael', 'dwight', 'pam']) {{
          const rows = F.CHAR_HEADS[name];
          heads[name] = {{ rowCount: rows.length, widths: [...new Set(rows.map(r => r.length))], joined: rows.join('|') }};
        }}
        console.log(JSON.stringify(heads));
    """)
    for name in ("michael", "dwight", "pam"):
        assert out[name]["rowCount"] == 8
        assert out[name]["widths"] == [16]     # каждая строка спрайта ровно 16 «пикселей» — без этого рисунок рассыпается
    # три силуэта не совпадают (иначе разные образы выглядели бы одинаково)
    assert len({out[n]["joined"] for n in ("michael", "dwight", "pam")}) == 3


def test_named_agent_poses_match_generic_layout_size():
    """Ходьбы больше нет (люди всегда сидят/стоят на a.home) — но сидячие позы по состояниям
    (working: type1/type2, review: lean, failed, done) должны давать тот же размер спрайта, что
    и раньше у walk1/walk2, иначе рисунок человечка рассыпется."""
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        const sizes = {{}};
        for (const name of ['michael', 'dwight', 'pam']) {{
          sizes[name] = {{}};
          for (const pose of ['stand', 'type1', 'type2', 'lean', 'failed', 'done']) {{
            sizes[name][pose] = F.humanRows(pose, F.CHAR_HEADS[name]).length;
          }}
        }}
        console.log(JSON.stringify(sizes));
    """)
    for name in ("michael", "dwight", "pam"):
        for pose in ("stand", "type1", "type2", "lean", "failed", "done"):
            assert out[name][pose] == 26   # 8 (голова) + 8 (торс) + 10 (ноги) — как у прежнего генератора людей
