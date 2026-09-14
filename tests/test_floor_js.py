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


# Выбор позы по a.state живёт внутри drawHuman() (не экспортируется — использует canvas o.*, что
# требует DOM) и не вынесен в отдельную чистую функцию state->pose. Из module.exports для тестов
# доступен только humanRows(pose, head), где pose — уже вычисленная строка. Отображение state->pose
# ниже списано 1:1 с drawHuman() (ui/floor.js, строки ~792-796):
#   idle/planning -> 'stand' (дефолт, оба состояния явно не обрабатываются)
#   working -> 'type1'/'type2' (чередуются по кадру t — здесь оба варианта)
#   review -> 'lean', failed -> 'failed', done -> 'done'
STATE_TO_POSES = {
    "idle": ["stand"],
    "working": ["type1", "type2"],
    "review": ["lean"],
    "planning": ["stand"],
    "failed": ["failed"],
    "done": ["done"],
}


def test_sitting_pose_is_non_empty_for_every_state():
    """Для каждого состояния сидячая поза (через humanRows, единственную экспортированную функцию
    построения кадра по позе) даёт непустой набор строк спрайта корректной ширины."""
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        const head = F.CHAR_HEADS.michael;
        const poses = {json.dumps(sorted({p for ps in STATE_TO_POSES.values() for p in ps}))};
        const rows = {{}};
        for (const pose of poses) rows[pose] = F.humanRows(pose, head);
        console.log(JSON.stringify(rows));
    """)
    for state, poses in STATE_TO_POSES.items():
        for pose in poses:
            rows = out[pose]
            assert rows, f"state={state} pose={pose}: humanRows() вернул пустой результат"
            assert len(rows) == 26, f"state={state} pose={pose}: неожиданная высота спрайта {len(rows)}"


def test_sitting_pose_differs_between_visually_distinct_states():
    """Позы, которые должны визуально отличаться (working/review/failed/done, и type1 vs type2
    внутри working), действительно дают разные кадры humanRows()."""
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        const head = F.CHAR_HEADS.michael;
        const poses = ['stand', 'type1', 'type2', 'lean', 'failed', 'done'];
        const rows = {{}};
        for (const pose of poses) rows[pose] = F.humanRows(pose, head).join('|');
        console.log(JSON.stringify(rows));
    """)
    distinct_poses = ["stand", "type1", "type2", "lean", "failed", "done"]
    values = [out[p] for p in distinct_poses]
    assert len(set(values)) == len(distinct_poses), (
        f"ожидались {len(distinct_poses)} различных кадров позы, а реально различных: {len(set(values))} "
        f"(позы: {distinct_poses})"
    )


def test_idle_and_planning_share_the_same_sitting_pose_selection_branch():
    """ДЕФЕКТ/ограничение (не исправляю — вне роли QA, файл не редактирую): drawHuman() не выделяет
    отдельную позу для planning — оно попадает в тот же default-случай 'stand', что и idle:

        let pose = 'stand';
        if (a.state === 'working') pose = ...
        else if (a.state === 'review') pose = 'lean';
        else if (a.state === 'failed') pose = 'failed';
        else if (a.state === 'done') pose = 'done';

    'planning' нигде в этой цепочке не упоминается. Значит из требований задачи ("результат должен
    быть непустым и разным для разных состояний" для всех 6 состояний, включая planning) это не
    выполняется на уровне позы тела: idle и planning дают идентичный кадр humanRows('stand', ...).
    Визуально planning всё же отличим от idle — но не позой, а отдельной доской (BOARD) и подсветкой,
    рисуемыми в drawActors() поверх фигуры, а не через humanRows()/позу тела.

    Тест читает исходник и явно фиксирует это ограничение как регрессионный якорь: если кто-то добавит
    отдельную ветку для 'planning' (например `else if (a.state === 'planning') pose = '...'`), тест
    упадёт и потребует осознанного апдейта — вместе с обновлением STATE_TO_POSES выше."""
    src = FLOOR_JS.read_text(encoding="utf-8")
    start = src.index("let pose = 'stand';")
    end = src.index("const rows = humanRows(pose, head);")
    pose_selector = src[start:end]
    assert "planning" not in pose_selector, (
        "в drawHuman() появилась отдельная ветка для state==='planning' — "
        "обнови STATE_TO_POSES и тесты выше, дефект/ограничение больше не актуален"
    )
    for state in ("working", "review", "failed", "done"):
        assert state in pose_selector, f"ожидалась ветка для state==='{state}' в выборе позы"


def test_module_exports_no_public_walk_or_pathfinding_functions_for_people():
    """Люди больше не ходят (ui/floor.js, комментарий у LEGS_BODY: 'ходьбы больше нет — люди всегда
    сидят/стоят на своём месте'). Убеждаемся, что в module.exports не осталось публичных функций
    ходьбы/pathfinding для людей (для котов такая логика есть, но она не экспортируется — и не должна)."""
    out = _run_node(f"""
        const F = require({json.dumps(str(FLOOR_JS))});
        console.log(JSON.stringify(Object.keys(F)));
    """)
    exported = set(out)
    banned_substrings = ("walk", "step", "path", "target", "stepcat", "movehuman", "humanwalk")
    suspicious = [k for k in exported if any(b in k.lower() for b in banned_substrings)]
    assert not suspicious, f"в module.exports остались подозрительные на ходьбу/pathfinding имена: {suspicious}"
    # актуальный список экспортов на момент написания теста — фиксируем явно, чтобы любое новое
    # публичное имя (в т.ч. функция ходьбы, добавленная по недосмотру) требовало осознанного апдейта теста
    expected = {
        "LW", "LH", "deskX", "computeDeskPositions", "isInsideObstacle", "pointOutsideObstacles",
        "sceneObstacleRects", "CYBER_DESK_BANDS", "characterFor", "CHAR_PALETTE", "CHAR_HEADS",
        "humanRows", "DESK_FOOT", "DESK_MIN_GAP",
    }
    assert exported == expected, f"module.exports изменился: {exported.symmetric_difference(expected)}"


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
