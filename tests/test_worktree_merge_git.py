"""Пункт 2 «Надёжность»: worktree.merge() мерджит в отдельном временном detached worktree,
а не в рабочей копии пользователя (см. память cyber_office_worktree_merge_in_tmp). Тесты ниже
работают с настоящим git во временных репозиториях (без мока) и проверяют три вещи по чек-листу
задачи: (1) грязная/чужая рабочая копия пользователя не трогается при успешном мердже, (2) настоящий
конфликт двух правок одного файла классифицируется как 'conflict' (мердж отменён, git чист), (3)
прочая ошибка git (несуществующая base-ветка) классифицируется как 'failed', без побочных изменений
в репозитории — и Office.approve() на 'failed' не должен звать retry (см. tests/test_missions.py::
test_merge_conflict_marks_failed_and_retry_rebases для обратного случая — 'conflict' ведёт к retry)."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app.core import worktree
from app.core.office import Office
from app.core.roster import Roster
from app.core.runner import FakeRunner
from app.core.tasks import TaskStore

pytestmark = pytest.mark.asyncio


def _git(repo: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    assert r.returncode == 0, f"git {args} failed: {r.stdout}{r.stderr}"
    return r.stdout.strip()


def _git_allow_fail(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def _commit(repo: Path, message: str) -> None:
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t",
                    "commit", "-q", "-m", message], check=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """Репо с main (два коммита) и веткой agent/x, где агент поменял README — независимо от
    tests/conftest.py::workspace, чтобы не тянуть лишнюю фикстуру для чисто git-уровневых тестов."""
    from app import config
    monkeypatch.setenv("AO_WORKSPACE", str(tmp_path / "ws"))
    import importlib
    importlib.reload(config)
    config.ensure_dirs()

    r = tmp_path / "repo"
    r.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=r, check=True)
    (r / "README.md").write_text("line1\n", encoding="utf-8")
    (r / "other.md").write_text("other\n", encoding="utf-8")
    _commit(r, "init")

    _git(r, "branch", "agent/x")
    _git(r, "worktree", "add", "-q", str(tmp_path / "aw"), "agent/x")
    (tmp_path / "aw" / "README.md").write_text("line1\nagent change\n", encoding="utf-8")
    _commit(tmp_path / "aw", "agent: изменил README")
    _git(r, "worktree", "remove", "--force", str(tmp_path / "aw"))
    return r


# ------------------------------------------------------------ 1) рабочая копия пользователя цела

async def test_merge_does_not_touch_dirty_user_checkout_on_foreign_branch(repo, tmp_path):
    _git(repo, "checkout", "-q", "-b", "user-work")
    (repo / "README.md").write_text("line1\nuser is mid-edit, not committed\n", encoding="utf-8")
    (repo / "scratch.txt").write_text("untracked scratch file\n", encoding="utf-8")

    status_before = _git(repo, "status", "--porcelain")
    assert "README.md" in status_before and "scratch.txt" in status_before

    status, sha = await worktree.merge(str(repo), "agent/x", "merge agent work", base="main")
    assert status == "ok"

    # рабочая копия пользователя — ветка, незакоммиченная правка и untracked-файл — не тронута
    assert _git(repo, "symbolic-ref", "--short", "HEAD") == "user-work"
    status_after = _git(repo, "status", "--porcelain")
    assert status_after == status_before
    assert (repo / "README.md").read_text(encoding="utf-8") == "line1\nuser is mid-edit, not committed\n"
    assert (repo / "scratch.txt").exists()

    # база (main) реально продвинулась на коммит мерджа
    assert _git(repo, "rev-parse", "refs/heads/main") == sha
    main_readme = _git(repo, "show", "main:README.md")
    assert "agent change" in main_readme

    # временный worktree мерджа убран, не остался висеть — только основной чекаут
    worktrees = _git(repo, "worktree", "list", "--porcelain")
    assert sum(1 for line in worktrees.splitlines() if line.startswith("worktree ")) == 1


# ------------------------------------------------------------ 2) настоящий конфликт

async def test_merge_real_conflict_is_classified_as_conflict_and_leaves_repo_clean(repo):
    # main тоже меняет ту же строку README после точки ветвления агента -> конфликт при merge
    (repo / "README.md").write_text("line1\nmain also edited this very line\n", encoding="utf-8")
    _commit(repo, "main: конфликтующая правка")
    main_sha_before = _git(repo, "rev-parse", "refs/heads/main")

    status, out = await worktree.merge(str(repo), "agent/x", "merge agent work", base="main")
    assert status == "conflict"
    assert "CONFLICT" in out

    # merge --abort уже отработал: конфликт не оставляет README.md текущего чекаута тронутым,
    # база не продвинулась, и никакого зависшего MERGE_HEAD/lock-файла не осталось
    assert _git(repo, "rev-parse", "refs/heads/main") == main_sha_before
    assert (repo / "README.md").read_text(encoding="utf-8") == "line1\nmain also edited this very line\n"
    assert _git_allow_fail(repo, "rev-parse", "--verify", "-q", "MERGE_HEAD").returncode != 0
    worktrees = _git(repo, "worktree", "list", "--porcelain")
    assert sum(1 for line in worktrees.splitlines() if line.startswith("worktree ")) == 1


# ------------------------------------------------------------ 3) прочая ошибка git != конфликт

async def test_merge_nonexistent_base_branch_is_classified_as_failed_not_conflict(repo):
    status, out = await worktree.merge(str(repo), "agent/x", "merge agent work", base="does-not-exist")
    assert status == "failed"
    assert "CONFLICT" not in out
    assert out          # текст ошибки git есть, не пустая строка

    # лишних worktree не осталось (сбой на самом первом git-шаге, до создания tmp)
    worktrees = _git(repo, "worktree", "list", "--porcelain")
    assert sum(1 for line in worktrees.splitlines() if line.startswith("worktree ")) == 1


async def test_office_approve_on_failed_merge_does_not_retry_or_touch_branch(repo, monkeypatch):
    """'failed' (в отличие от 'conflict') не должен вызывать Office.retry(): ветка/worktree
    задачи остаются как были, статус — failed с текстом ошибки git, без подсказки '-prev'."""
    from app import config
    store, roster = TaskStore(config.TASKS_FILE), Roster()
    # base_for заставляет worktree.merge упасть на самом первом git-шаге (несуществующая
    # база) — это гарантированно 'failed', а не 'conflict' (см. test_merge_nonexistent_base_
    # branch_is_classified_as_failed_not_conflict выше на том же сценарии напрямую)
    office = Office(store, roster, FakeRunner(delay=0.01), base_for=lambda _repo: "does-not-exist")

    t = store.create("T", "p", str(repo), "michael")
    t.status, t.branch, t.worktree = "review", "agent/x", str(repo / "_unused_worktree")
    store.update(t)

    retried = []
    orig_retry = office.retry
    async def spy_retry(*a, **kw):
        retried.append((a, kw))
        return await orig_retry(*a, **kw)
    monkeypatch.setattr(office, "retry", spy_retry)

    ok, out = await office.approve(t.id)
    assert ok is False
    assert retried == []                      # retry ни разу не вызван

    after = store.get(t.id)
    assert after.status == "failed"
    assert after.error == out
    assert "CONFLICT" not in out
    assert after.branch == "agent/x" and after.worktree == str(repo / "_unused_worktree")   # не заменены
    assert "-prev" not in after.prompt
    assert _git(repo, "branch", "--list", "agent/x") != ""   # ветка не переименована/не удалена
