from pathlib import Path

from app.core import scenarios


def test_is_bike_fit_matches_by_basename():
    assert scenarios.is_bike_fit("/Users/x/PycharmProjects/bike_fit")
    assert not scenarios.is_bike_fit("/Users/x/PycharmProjects/Velo_bot")


def test_ensure_scenarios_dir_writes_conftest_once(workspace):
    scenarios.ensure_scenarios_dir()
    conftest = scenarios.SCENARIOS_DIR / "conftest.py"
    assert conftest.exists()
    text = conftest.read_text(encoding="utf-8")
    conftest.write_text(text + "\n# marker\n", encoding="utf-8")
    scenarios.ensure_scenarios_dir()                     # не должен перезаписать существующий файл
    assert "# marker" in conftest.read_text(encoding="utf-8")


def test_list_scenarios_excludes_conftest(workspace):
    scenarios.ensure_scenarios_dir()
    (scenarios.SCENARIOS_DIR / "test_login.py").write_text("def test_x(page): pass\n", encoding="utf-8")
    (scenarios.SCENARIOS_DIR / "not_a_test.txt").write_text("noise", encoding="utf-8")
    assert scenarios.list_scenarios() == ["test_login.py"]


def test_scenario_path_rejects_traversal_and_unknown(workspace):
    scenarios.ensure_scenarios_dir()
    (scenarios.SCENARIOS_DIR / "test_login.py").write_text("def test_x(page): pass\n", encoding="utf-8")
    assert scenarios.scenario_path("test_login.py") == scenarios.SCENARIOS_DIR / "test_login.py"
    assert scenarios.scenario_path("../conftest.py") is None
    assert scenarios.scenario_path("../../etc/passwd") is None
    assert scenarios.scenario_path("nope.py") is None
    assert scenarios.scenario_path("sub/dir.py") is None


def test_screenshot_path_rejects_traversal(workspace):
    run_dir = scenarios.SCREENSHOTS_DIR / "abc123"
    run_dir.mkdir(parents=True)
    (run_dir / "fail.png").write_bytes(b"\x89PNG")
    assert scenarios.screenshot_path("abc123", "fail.png") == run_dir / "fail.png"
    assert scenarios.screenshot_path("abc123", "../fail.png") is None
    assert scenarios.screenshot_path("abc123", "sub/fail.png") is None
    assert scenarios.screenshot_path("../abc123", "fail.png") is None
    assert scenarios.screenshot_path("abc123", "missing.png") is None


def test_flatten_screenshots_lifts_nested_png_to_run_dir(workspace):
    run_dir = scenarios.SCREENSHOTS_DIR / "run1"
    nested = run_dir / "test-login-chromium"
    nested.mkdir(parents=True)
    (nested / "test-failed-1.png").write_bytes(b"\x89PNG")
    name = scenarios._flatten_screenshots(run_dir)
    assert name == "test-login-chromium-test-failed-1.png"
    assert (run_dir / name).exists()


def test_flatten_screenshots_returns_none_without_png(workspace):
    run_dir = scenarios.SCREENSHOTS_DIR / "run2"
    run_dir.mkdir(parents=True)
    assert scenarios._flatten_screenshots(run_dir) is None
