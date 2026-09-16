"""Структурные проверки UI «Планёрки», проектов, уведомлений, вкладок карточки задачи и
графа миссии — по образцу tests/test_mobile_layout.py: просто читает ui/index.html, ui/app.js
и ui/graph.js как текст и ищет реальные id/классы/строки, а не парсит DOM."""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = (REPO_ROOT / "ui" / "index.html").read_text(encoding="utf-8")
APP_JS = (REPO_ROOT / "ui" / "app.js").read_text(encoding="utf-8")
GRAPH_JS = (REPO_ROOT / "ui" / "graph.js").read_text(encoding="utf-8")


# ------------------------------------------------------------ вкладка/секция Планёрки

def test_planerka_view_switch_button_exists():
    assert 'data-view="planerka"' in INDEX_HTML
    assert "Планёрка" in INDEX_HTML


def test_planerka_view_is_a_separate_section_with_its_own_blocks():
    assert 'id="view-planerka"' in INDEX_HTML
    assert 'class="planerka-grid"' in INDEX_HTML
    for block_id in ("plk-waiting-body", "plk-running-body", "plk-today-body", "plk-events-body"):
        assert f'id="{block_id}"' in INDEX_HTML


def test_app_js_renders_planerka():
    assert "renderPlanerka" in APP_JS


# ------------------------------------------------------------ проекты слева

def test_projects_panel_has_list_and_add_button():
    assert 'id="projects"' in INDEX_HTML
    assert 'id="projects-list"' in INDEX_HTML
    assert 'id="projects-select"' in INDEX_HTML
    assert 'id="btn-projects-add"' in INDEX_HTML


def test_projects_get_per_project_counts_in_app_js():
    assert "function projectCounts(" in APP_JS
    assert "project-counts" in APP_JS
    assert "c-review" in APP_JS and "c-running" in APP_JS and "c-total" in APP_JS


# ------------------------------------------------------------ уведомления (колокольчик)

def test_notification_bell_and_center_exist():
    assert 'id="btn-notify"' in INDEX_HTML
    assert 'id="notify-badge"' in INDEX_HTML
    assert 'id="dlg-notify"' in INDEX_HTML
    assert 'id="notify-list"' in INDEX_HTML
    assert 'id="btn-notify-read-all"' in INDEX_HTML


def test_notification_center_logic_in_app_js():
    assert "NOTIFY_KEY" in APP_JS
    assert "renderNotifyList" in APP_JS


# ------------------------------------------------------------ вкладки карточки задачи

def test_task_card_has_summary_diff_log_prompt_tabs():
    for tab, label in (("summary", "Резюме"), ("diff", "Дифф"), ("log", "Лог"), ("prompt", "Промпт")):
        assert f'data-tab="{tab}"' in APP_JS
        assert label in APP_JS
        assert f'id="tp-{tab}"' in APP_JS


def test_task_card_has_note_field_for_the_running_agent():
    assert 'id="t-note-input"' in APP_JS
    assert "Уточнение для повтора" in APP_JS
    assert "Увидит на следующем шаге" in APP_JS


# ------------------------------------------------------------ граф миссии

def test_graph_js_is_wired_into_index_html():
    assert '<script src="/ui/graph.js">' in INDEX_HTML


def test_mission_graph_rendering_uses_graph_js_layout():
    assert "renderMissionGraph" in APP_JS
    assert "Graph.computeGraphLayout" in APP_JS
    assert "computeGraphLayout" in GRAPH_JS


def test_mission_graph_shows_time_and_critical_path():
    assert "function taskDurationMinutes(" in APP_JS
    assert "graphTimeLabel" in APP_JS and "⏱" in APP_JS
    assert "Graph.criticalPath" in APP_JS
    assert "criticalPath" in GRAPH_JS
    assert "Критический путь" in APP_JS
    assert "critical" in APP_JS and ".graph-node.critical" in (REPO_ROOT / "ui" / "style.css").read_text(encoding="utf-8")


def test_mission_graph_node_tooltip_exists():
    assert "showGraphTip" in APP_JS and "graph-tip" in APP_JS
    assert "GRAPH_TOUCH" in APP_JS   # тап на тач-устройствах вместо hover
