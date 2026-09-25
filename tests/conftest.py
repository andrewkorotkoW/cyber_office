import os
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Изолированный workspace и свежий репо-песочница на каждый тест."""
    ws = tmp_path / "ws"
    monkeypatch.setenv("AO_WORKSPACE", str(ws))
    import importlib
    from app import config
    importlib.reload(config)
    from app.core import tasks, roster, memory, worktree, testlab, scenarios, digest
    for m in (tasks, roster, memory, worktree, testlab, scenarios, digest):
        importlib.reload(m)
    config.ensure_dirs()
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    (repo / "README.md").write_text("# demo\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    return {"ws": ws, "repo": str(repo)}
