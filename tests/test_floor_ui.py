"""Smoke-тесты для ui/floor.js после мержа cyberpunk-сцены (768x432).

Не трогаем ui/floor.js — только проверяем его через node (синтаксис,
headless require без DOM, чистые функции расстановки столов/препятствий,
которые файл экспортирует в конце через module.exports).
"""
import json
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
FLOOR_JS = REPO_ROOT / "ui" / "floor.js"
PROBE_JS = REPO_ROOT / "tests" / "fixtures" / "floor_probe.js"

DESK_HALF_W = 42   # DESK-спрайт (scale2 из 28x5) при HS=1.5: ширина после округления round(56*1.5)=84 → половина 42
DESK_TOP_OFF = 12  # sprite(DESK, home.x - S(28), home.y - S(8), ...): верх стола выше home.y на S(8)=12
DESK_BOTTOM_OFF = 3  # высота стола round(10*1.5)=15, значит низ = home.y - 12 + 15 = home.y + 3


def desk_bbox(pos):
    """Приближённый bounding box стола вокруг точки home, как его рисует drawActors()."""
    return {
        "x": pos["x"] - DESK_HALF_W,
        "y": pos["y"] - DESK_TOP_OFF,
        "w": 2 * DESK_HALF_W,
        "h": DESK_TOP_OFF + DESK_BOTTOM_OFF,
    }


def rects_overlap(a, b):
    return a["x"] < b["x"] + b["w"] and a["x"] + a["w"] > b["x"] and a["y"] < b["y"] + b["h"] and a["y"] + a["h"] > b["y"]


@pytest.fixture(scope="module")
def probe_data():
    assert FLOOR_JS.exists(), f"ui/floor.js не найден по пути {FLOOR_JS}"
    proc = subprocess.run(
        ["node", str(PROBE_JS)], capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"floor_probe.js упал: stdout={proc.stdout!r} stderr={proc.stderr!r}"
    return json.loads(proc.stdout)


# ---------------------------------------------------------------- 1) синтаксис файла

def test_floor_js_syntax_is_valid():
    proc = subprocess.run(
        ["node", "--check", str(FLOOR_JS)], capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"node --check нашёл синтаксическую ошибку: {proc.stderr}"


# ---------------------------------------------------------------- 2) headless-прогон без DOM

def test_floor_js_loads_headless_without_dom(probe_data):
    # floor_probe.js сам падает (ненулевой exit) через assert, если document/window
    # определены до или после require — значит нулевой returncode уже подтверждает
    # безопасный headless-require; здесь дополнительно проверяем флаг из вывода.
    assert probe_data["domGlobalsAbsent"] is True


def test_floor_js_exports_expected_pure_functions(probe_data):
    exported = set(probe_data["exportedKeys"])
    expected = {
        "LW", "LH", "deskX", "computeDeskPositions",
        "isInsideObstacle", "pointOutsideObstacles",
        "sceneObstacleRects", "CYBER_DESK_BANDS",
    }
    assert expected <= exported, f"ожидались экспорты {expected}, реально экспортировано {exported}"


# ---------------------------------------------------------------- 5) размеры канвы

def test_canvas_dimensions_are_768x432(probe_data):
    assert probe_data["LW"] == 768
    assert probe_data["LH"] == 432


# ---------------------------------------------------------------- 4) isInsideObstacle

def test_is_inside_obstacle_true_for_point_inside_known_rect(probe_data):
    # {x:40,y:200} лежит внутри первого препятствия {x:0,y:160,w:86,h:100} (стеллаж у левой стены)
    rect = probe_data["obstacleRects"][0]
    assert rect == {"x": 0, "y": 160, "w": 86, "h": 100}
    assert probe_data["insideKnownRect"] is True


def test_is_inside_obstacle_false_for_point_far_outside(probe_data):
    # {x:400,y:50} выше всех препятствий (все начинаются с y>=160)
    assert probe_data["outsideAllRects"] is False


# ---------------------------------------------------------------- 3) расстановка столов: рисованный этаж (deskX)

@pytest.mark.parametrize("n", range(1, 7))
def test_legacy_desk_x_within_canvas(probe_data, n):
    xs = probe_data["legacyDeskX"][str(n)]
    assert len(xs) == n
    for x in xs:
        assert 0 <= x <= probe_data["LW"]


# ---------------------------------------------------------------- 3) расстановка столов: cyberpunk-сцена

@pytest.mark.parametrize("n", range(1, 7))
def test_cyberpunk_desk_positions_within_canvas(probe_data, n):
    positions = probe_data["cyberDesks"][str(n)]
    assert len(positions) == n
    lw, lh = probe_data["LW"], probe_data["LH"]
    for pos in positions:
        box = desk_bbox(pos)
        assert 0 <= box["x"], f"n={n} стол {pos} выходит за левый край канвы"
        assert box["x"] + box["w"] <= lw, f"n={n} стол {pos} выходит за правый край канвы"
        assert 0 <= box["y"], f"n={n} стол {pos} выходит за верхний край канвы"
        assert box["y"] + box["h"] <= lh, f"n={n} стол {pos} выходит за нижний край канвы"


# Раньше здесь была регрессионная фиксация известного бага: полосы CYBER_DESK_BANDS.single/row1
# (x0=230/x1=538, y=372/350) сталкивались с креслами-препятствиями (x:[110,210]/[558,658], y:[300,390]) —
# pointOutsideObstacles() отталкивал только точку home, а не весь bounding box стола (±42 по x, -12/+3 по y),
# из-за чего стол на краю полосы мог «повиснуть» над креслом. computeDeskPositions() теперь проверяет
# препятствия по раздутому (Минковским) прямоугольнику — под сам bounding box стола, а не только его центр —
# так что пересечений с sceneObstacleRects() для n=1..6 больше нет ни для одного стола.


@pytest.mark.parametrize("n", range(1, 7))
def test_cyberpunk_desk_positions_avoid_obstacles(probe_data, n):
    positions = probe_data["cyberDesks"][str(n)]
    rects = probe_data["obstacleRects"]
    for idx, pos in enumerate(positions):
        box = desk_bbox(pos)
        hits = [r for r in rects if rects_overlap(box, r)]
        assert not hits, (
            f"n={n} стол #{idx} ({pos}, bbox={box}) пересекает препятствие(-я) {hits}"
        )


@pytest.mark.parametrize("n", range(1, 7))
def test_cyberpunk_desk_positions_dont_overlap_each_other(probe_data, n):
    """Соседние столы одного ряда (близкий y) должны стоять не ближе ширины DESK после масштабирования HS."""
    positions = probe_data["cyberDesks"][str(n)]
    min_gap = 2 * DESK_HALF_W
    by_row = sorted(positions, key=lambda p: (p["y"], p["x"]))
    rows = {}
    for p in by_row:
        rows.setdefault(p["y"], []).append(p["x"])
    for y, xs in rows.items():
        for i in range(1, len(xs)):
            gap = xs[i] - xs[i - 1]
            assert gap >= min_gap, f"n={n} столы в ряду y={y} стоят слишком близко: {xs}, gap={gap} < {min_gap}"
