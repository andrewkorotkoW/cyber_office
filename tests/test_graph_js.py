"""Смоук-тест чистой раскладки ui/graph.js через node (без DOM) — тот же module.exports,
что использует floor.js для тестов dwight'а (см. test_floor_js.py)."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

GRAPH_JS = Path(__file__).resolve().parent.parent / "ui" / "graph.js"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node недоступен")


def _run_node(js: str):
    proc = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_no_deps_all_layer_zero():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: [] }},
          {{ id: 'b', depends_on: [] }},
        ]);
        console.log(JSON.stringify(nodes));
    """)
    assert [n["layer"] for n in out] == [0, 0]


def test_linear_chain_layers_increase():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: [] }},
          {{ id: 'b', depends_on: ['a'] }},
          {{ id: 'c', depends_on: ['b'] }},
        ]);
        console.log(JSON.stringify(nodes));
    """)
    by_id = {n["id"]: n for n in out}
    assert by_id["a"]["layer"] == 0
    assert by_id["b"]["layer"] == 1
    assert by_id["c"]["layer"] == 2


def test_diamond_takes_max_of_both_parents():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: [] }},
          {{ id: 'b', depends_on: ['a'] }},
          {{ id: 'c', depends_on: ['a'] }},
          {{ id: 'd', depends_on: ['b', 'c'] }},
        ]);
        console.log(JSON.stringify(nodes));
    """)
    by_id = {n["id"]: n for n in out}
    assert by_id["d"]["layer"] == 2


def test_dependency_outside_set_is_ignored():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: ['ghost-not-in-set'] }},
        ]);
        console.log(JSON.stringify(nodes));
    """)
    assert out[0]["layer"] == 0


def test_cycle_does_not_hang_or_throw():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: ['b'] }},
          {{ id: 'b', depends_on: ['a'] }},
        ]);
        console.log(JSON.stringify(nodes));
    """)
    assert len(out) == 2
    assert all(isinstance(n["layer"], int) for n in out)


def test_self_dependency_ignored():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: ['a'] }},
        ]);
        console.log(JSON.stringify(nodes));
    """)
    assert out[0]["layer"] == 0


def test_rows_within_layer_dont_overlap_and_use_fixed_step():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: [] }},
          {{ id: 'b', depends_on: [] }},
          {{ id: 'c', depends_on: [] }},
        ]);
        console.log(JSON.stringify({{ nodes, STEP_X: G.STEP_X, STEP_Y: G.STEP_Y }}));
    """)
    nodes, step_x, step_y = out["nodes"], out["STEP_X"], out["STEP_Y"]
    ys = sorted(n["y"] for n in nodes)
    assert ys == [0, step_y, 2 * step_y]
    assert all(n["x"] == 0 for n in nodes)
    assert step_x > 0 and step_y > 0


def test_x_positions_match_layer_times_step():
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout([
          {{ id: 'a', depends_on: [] }},
          {{ id: 'b', depends_on: ['a'] }},
        ]);
        console.log(JSON.stringify({{ nodes, STEP_X: G.STEP_X }}));
    """)
    by_id = {n["id"]: n for n in out["nodes"]}
    assert by_id["a"]["x"] == 0
    assert by_id["b"]["x"] == out["STEP_X"]
