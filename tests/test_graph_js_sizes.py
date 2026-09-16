"""Дополнительное покрытие ui/graph.js поверх tests/test_graph_js.py (который уже пришёл
вместе с реализацией графа миссии, коммит e9d5329): та же схема через node -e/require, но
закрывает пункты чек-листа задачи, которых в исходном файле не было — размеры графов миссий
2..6 задач (как реально бывают у FakePlanner/parse_plan) со ссылкой на несуществующий id среди
depends_on, и что раскладка не роняет узлы друг на друга по координатам."""
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


def _chain_with_ghost_ref(n: int):
    """Линейная цепочка a0->a1->...->a(n-1), плюс у последней задачи в depends_on
    добавлена ссылка на id, которого нет среди задач — как если бы план сослался
    на задачу, отфильтрованную parse_plan (см. test_missions.py::test_parse_plan_validates)."""
    tasks = [{"id": f"a{i}", "depends_on": ([f"a{i - 1}"] if i else [])} for i in range(n)]
    tasks[-1]["depends_on"].append("ghost-does-not-exist")
    return tasks


@pytest.mark.parametrize("n", range(2, 7))
def test_mission_sized_chain_with_ghost_ref_does_not_crash_or_loop(n):
    tasks = _chain_with_ghost_ref(n)
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout({json.dumps(tasks)});
        console.log(JSON.stringify(nodes));
    """)
    assert len(out) == n
    by_id = {node["id"]: node for node in out}
    for i, t in enumerate(tasks):
        assert by_id[t["id"]]["layer"] == i   # ссылка-призрак не мешает нормальному счёту слоёв
    assert all(isinstance(node["layer"], int) and node["layer"] >= 0 for node in out)


@pytest.mark.parametrize("n", range(2, 7))
def test_disconnected_mission_sized_set_all_layer_zero_no_overlap(n):
    """Набор задач без единого depends_on (несвязный) — как параллельный план без зависимостей:
    все в слое 0, и раскладка не даёт двум узлам одинаковые координаты (иначе они наложатся в SVG)."""
    tasks = [{"id": f"t{i}", "depends_on": []} for i in range(n)]
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout({json.dumps(tasks)});
        console.log(JSON.stringify(nodes));
    """)
    assert all(node["layer"] == 0 for node in out)
    coords = [(node["x"], node["y"]) for node in out]
    assert len(set(coords)) == n, f"наложение координат при n={n}: {coords}"


def test_mixed_diamond_and_ghost_refs_for_a_six_task_mission_is_stable():
    """Смешанный граф из 6 задач: ромб (реальные зависимости) + отдельная пара с cyclic-подобной
    /несуществующей ссылкой — весь набор размеров, которые реально отдаёт FakePlanner/parse_plan."""
    tasks = [
        {"id": "a", "depends_on": []},
        {"id": "b", "depends_on": ["a"]},
        {"id": "c", "depends_on": ["a", "missing-dep"]},
        {"id": "d", "depends_on": ["b", "c"]},
        {"id": "e", "depends_on": []},
        {"id": "f", "depends_on": ["e", "e"]},   # задача дважды указала одну и ту же зависимость
    ]
    out = _run_node(f"""
        const G = require({json.dumps(str(GRAPH_JS))});
        const nodes = G.computeGraphLayout({json.dumps(tasks)});
        console.log(JSON.stringify(nodes));
    """)
    by_id = {node["id"]: node for node in out}
    assert by_id["a"]["layer"] == 0 and by_id["e"]["layer"] == 0
    assert by_id["b"]["layer"] == 1 and by_id["c"]["layer"] == 1
    assert by_id["d"]["layer"] == 2
    assert by_id["f"]["layer"] == 1
    coords = [(node["x"], node["y"]) for node in out]
    assert len(set(coords)) == len(tasks)
