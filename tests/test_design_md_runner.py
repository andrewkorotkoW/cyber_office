"""Интеграция DESIGN.md (см. app/core/runner.py::design_md_addendum/looks_like_ui_task,
app/core/planner.py::_add_design_hint, app/main.py::_repo_ui_flag и snap["design_md_repos"]):

- задача в репозитории с DESIGN.md и похожая на UI (по ключевым словам промпта или флагу
  "ui" репозитория в repos.json) — ClaudeRunner добавляет в промпт агенту блок про DESIGN.md;
- миссия с UI-целью в репозитории с DESIGN.md — та же подсказка попадает в prompt каждой
  подзадачи плана (FakePlanner/ClaudePlanner используют одну функцию _add_design_hint);
- /api/state отдаёт design_md_repos — только репозитории, где реально лежит файл DESIGN.md.

Паттерны: hang_bin/argv-подмена claude из tests/test_runner_timeout.py (фейковый бинарник
вместо настоящего claude, читаем что ему передали через файл в cwd), FakePlanner из
tests/test_missions.py, TestClient + workspace-reload из tests/test_repo_init.py.
"""
from __future__ import annotations

import importlib
import json
import subprocess
from pathlib import Path

import pytest

from app.core import worktree
from app.core.planner import FakePlanner
from app.core.runner import ClaudeRunner, DESIGN_MD_HINT, design_md_addendum, looks_like_ui_task

pytestmark = pytest.mark.asyncio   # часть тестов ниже (HTTP через TestClient) синхронные — ожидаемо


def _commit_all(repo: Path, message: str) -> None:
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message],
                    cwd=repo, check=True)


# ------------------------------------------------------------------ looks_like_ui_task / design_md_addendum
def test_looks_like_ui_task_matches_keywords_case_insensitively():
    assert looks_like_ui_task("Поправь UI кнопки")
    assert looks_like_ui_task("нужен новый CSS для карточек")
    assert looks_like_ui_task("обнови ИНТЕРФЕЙС настроек")
    assert looks_like_ui_task("почини вёрстку формы логина")
    assert looks_like_ui_task("выбери новую тема оформления")   # keyword "тема" — точная подстрока, без склонений


def test_looks_like_ui_task_false_for_unrelated_text():
    assert not looks_like_ui_task("почини баг в парсере логов")


def test_design_md_addendum_empty_without_design_md_file(tmp_path):
    # даже явный UI-флаг репозитория не спасает, если файла реально нет
    assert design_md_addendum("почини UI кнопки", str(tmp_path), lambda repo: True) == ""


def test_design_md_addendum_present_for_ui_keyword_in_prompt(tmp_path):
    (tmp_path / "DESIGN.md").write_text("# design", encoding="utf-8")
    assert design_md_addendum("почини CSS кнопки", str(tmp_path), lambda repo: False) == DESIGN_MD_HINT


def test_design_md_addendum_absent_for_non_ui_task_without_repo_flag(tmp_path):
    (tmp_path / "DESIGN.md").write_text("# design", encoding="utf-8")
    assert design_md_addendum("почини баг в парсере логов", str(tmp_path), lambda repo: False) == ""


async def test_design_md_addendum_via_repo_ui_flag_resolved_through_worktree(workspace):
    """cwd задачи — изолированный worktree, а не сам репозиторий (см. _repo_root_from_worktree).
    Промпт без UI-ключевых слов, но repos.json помечает репозиторий флагом "ui" — подсказка
    всё равно должна появиться, потому что design_md_addendum распознаёт репозиторий по .git
    worktree-файлу и спрашивает ui_repo_fn про настоящий путь репозитория, а не про cwd."""
    repo = Path(workspace["repo"])
    (repo / "DESIGN.md").write_text("# design", encoding="utf-8")
    _commit_all(repo, "design")
    branch, wt_path = await worktree.create(str(repo), "task-ui-flag")
    try:
        flagged = design_md_addendum("почини баг", wt_path, lambda r: r == str(repo))
        unflagged = design_md_addendum("почини баг", wt_path, lambda r: False)
        assert flagged == DESIGN_MD_HINT
        assert unflagged == ""
    finally:
        await worktree.remove(str(repo), branch, wt_path, delete_branch=True)


# ------------------------------------------------------------------ ClaudeRunner: подсказка реально в argv
FAKE_CLAUDE_SCRIPT = """#!/usr/bin/env python3
import json, sys
with open("argv.json", "w") as f:
    json.dump(sys.argv, f)
print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                   "result": "ok", "total_cost_usd": 0.0, "num_turns": 1}))
"""


@pytest.fixture
def fake_claude_bin(tmp_path) -> Path:
    p = tmp_path / "fake_claude.py"
    p.write_text(FAKE_CLAUDE_SCRIPT, encoding="utf-8")
    p.chmod(0o755)
    return p


def _sent_prompt(argv_file: Path) -> str:
    argv = json.loads(argv_file.read_text(encoding="utf-8"))
    return argv[argv.index("-p") + 1]


async def test_claude_runner_appends_design_hint_for_ui_prompt_with_design_md(tmp_path, fake_claude_bin):
    (tmp_path / "DESIGN.md").write_text("# design", encoding="utf-8")
    runner = ClaudeRunner(binary=str(fake_claude_bin))
    res = await runner.run("michael", "system", "sonnet", "почини CSS кнопки", str(tmp_path), "task1")
    assert res.ok
    assert _sent_prompt(tmp_path / "argv.json").endswith(DESIGN_MD_HINT)


async def test_claude_runner_no_design_hint_for_non_ui_prompt(tmp_path, fake_claude_bin):
    (tmp_path / "DESIGN.md").write_text("# design", encoding="utf-8")
    runner = ClaudeRunner(binary=str(fake_claude_bin))
    res = await runner.run("michael", "system", "sonnet", "почини баг в парсере логов", str(tmp_path), "task1")
    assert res.ok
    assert DESIGN_MD_HINT not in _sent_prompt(tmp_path / "argv.json")


async def test_claude_runner_no_design_hint_without_design_md_file(tmp_path, fake_claude_bin):
    runner = ClaudeRunner(binary=str(fake_claude_bin))
    res = await runner.run("michael", "system", "sonnet", "почини UI кнопки", str(tmp_path), "task1")
    assert res.ok
    assert DESIGN_MD_HINT not in _sent_prompt(tmp_path / "argv.json")


async def test_claude_runner_uses_ui_repo_fn_via_worktree(workspace, fake_claude_bin):
    repo = Path(workspace["repo"])
    (repo / "DESIGN.md").write_text("# design", encoding="utf-8")
    _commit_all(repo, "design")
    branch, wt_path = await worktree.create(str(repo), "task-ui-repo-flag")
    try:
        runner = ClaudeRunner(binary=str(fake_claude_bin), ui_repo_fn=lambda r: r == str(repo))
        res = await runner.run("michael", "system", "sonnet", "почини баг без ui-слов", wt_path, "task-ui-repo-flag")
        assert res.ok
        assert _sent_prompt(Path(wt_path) / "argv.json").endswith(DESIGN_MD_HINT)
    finally:
        await worktree.remove(str(repo), branch, wt_path, delete_branch=True)


# ------------------------------------------------------------------ планировщик миссии: подсказка в подзадачах
TEAM = {"michael": "разработчик", "dwight": "инженер по качеству", "pam": "писатель"}


async def test_fake_planner_adds_design_hint_to_all_tasks_for_ui_goal_with_design_md(tmp_path):
    (tmp_path / "DESIGN.md").write_text("# design", encoding="utf-8")
    plan = await FakePlanner().plan("Обнови UI формы логина", str(tmp_path), TEAM)
    assert plan.tasks   # непустой план — иначе assert ниже проверяет пустое множество
    assert all(t.prompt.endswith(DESIGN_MD_HINT) for t in plan.tasks)


async def test_fake_planner_no_design_hint_without_design_md(tmp_path):
    plan = await FakePlanner().plan("Обнови UI формы логина", str(tmp_path), TEAM)
    assert all(DESIGN_MD_HINT not in t.prompt for t in plan.tasks)


async def test_fake_planner_no_design_hint_for_non_ui_goal(tmp_path):
    (tmp_path / "DESIGN.md").write_text("# design", encoding="utf-8")
    plan = await FakePlanner().plan("Почини баг в парсере логов", str(tmp_path), TEAM)
    assert all(DESIGN_MD_HINT not in t.prompt for t in plan.tasks)


# ------------------------------------------------------------------ /api/state: design_md_repos
def test_api_state_reports_only_repos_with_design_md_file(workspace, monkeypatch, tmp_path):
    repo_with_design = Path(workspace["repo"])
    (repo_with_design / "DESIGN.md").write_text("# design", encoding="utf-8")

    repo_without_design = tmp_path / "plain_repo"
    repo_without_design.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo_without_design, check=True)
    (repo_without_design / "README.md").write_text("# plain\n", encoding="utf-8")
    _commit_all(repo_without_design, "init")

    monkeypatch.setenv("AO_FAKE", "1")
    from app import config
    importlib.reload(config)
    config.ensure_dirs()
    (config.WORKSPACE / "repos.json").write_text(json.dumps([
        {"path": str(repo_with_design), "ui": True},
        {"path": str(repo_without_design)},
    ], ensure_ascii=False), encoding="utf-8")

    import app.main as main_module
    importlib.reload(main_module)
    from fastapi.testclient import TestClient
    with TestClient(main_module.app) as client:
        data = client.get("/api/state").json()

    assert str(repo_with_design) in data["design_md_repos"]
    assert str(repo_without_design) not in data["design_md_repos"]
    assert str(repo_with_design) in data["repos"] and str(repo_without_design) in data["repos"]
