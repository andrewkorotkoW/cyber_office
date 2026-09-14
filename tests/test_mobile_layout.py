"""Простые проверки мобильной раскладки (<=768px): viewport и наличие media-запросов
в ui/style.css. Не парсит CSS/HTML по-настоящему — просто читает файлы и ищет
ожидаемые строки/селекторы, чтобы не потерять адаптив при будущих правках.
"""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = (REPO_ROOT / "ui" / "index.html").read_text(encoding="utf-8")
STYLE_CSS = (REPO_ROOT / "ui" / "style.css").read_text(encoding="utf-8")


def test_viewport_meta_has_device_width_and_safe_area():
    assert "width=device-width" in INDEX_HTML
    assert "initial-scale=1" in INDEX_HTML
    assert "viewport-fit=cover" in INDEX_HTML


def test_style_has_mobile_media_query():
    assert "@media (max-width:768px)" in STYLE_CSS or "@media (max-width: 768px)" in STYLE_CSS


def test_mobile_block_covers_header_menu_and_burger():
    assert ".header-menu" in STYLE_CSS
    assert ".burger" in STYLE_CSS
    assert "header .team-strip { display:none }" in STYLE_CSS


def test_mobile_block_covers_floor_collapse():
    assert ".floor-toggle" in STYLE_CSS
    assert "#floor .body { height:120px" in STYLE_CSS
    assert "aspect-ratio:768/432" in STYLE_CSS


def test_mobile_block_covers_board_tabs_and_touch_targets():
    assert ".board-tabs" in STYLE_CSS
    assert ".board-tab" in STYLE_CSS
    assert "min-height:44px" in STYLE_CSS


def test_mobile_block_covers_fullwidth_dialogs():
    assert "dialog { width:100vw" in STYLE_CSS
    assert ".dialog-actions" in STYLE_CSS


def test_mobile_block_covers_tests_layout_and_table_scroll():
    assert ".tests-layout { display:block" in STYLE_CSS
    assert ".table-scroll" in STYLE_CSS


def test_index_html_has_burger_and_board_tabs_markup():
    assert 'id="btn-menu"' in INDEX_HTML
    assert 'id="header-menu"' in INDEX_HTML
    assert 'id="board-tabs"' in INDEX_HTML
    assert 'id="btn-floor-toggle"' in INDEX_HTML
    assert 'class="table-scroll"' in INDEX_HTML
