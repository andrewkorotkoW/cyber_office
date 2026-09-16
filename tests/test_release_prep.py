"""Подготовка к раздаче: репозиторий публичный на GitHub, эти тесты не дают личным
путям/адресам и пропущенным .env-переменным вернуться незамеченными."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from app import config

ROOT = config.ROOT

# каталоги, где личным путям место (рантайм, venv, git) или это история (docs/log)
EXCLUDE_DIRS = {".git", ".venv", "workspace", "__pycache__", ".pytest_cache", ".idea"}
EXCLUDE_SUBTREES = {ROOT / "docs" / "log"}
# сам сканер неизбежно упоминает то, что ищет — не сканируем себя
EXCLUDE_FILES = {ROOT / "tests" / "test_release_prep.py"}
BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".ttf", ".otf", ".woff", ".woff2", ".pyc"}

# реальное имя пользователя автора и адреса его домашней сети — placeholder'ы вроде
# "x"/"my-repo"/"user" в тестах и примерах намеренно не считаются личными
REAL_USERNAME = "andrey" + "korotkow"
PERSONAL_PATTERNS = [
    re.compile(re.escape(REAL_USERNAME)),
    re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"),
    re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
    re.compile(r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"),
]


def _scan_files():
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() in BINARY_SUFFIXES:
            continue
        if any(part in EXCLUDE_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if any(subtree in path.parents for subtree in EXCLUDE_SUBTREES):
            continue
        if path in EXCLUDE_FILES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        yield path, text


def test_no_personal_paths_or_home_network_addresses():
    offenders = []
    for path, text in _scan_files():
        for pattern in PERSONAL_PATTERNS:
            if pattern.search(text):
                offenders.append(f"{path.relative_to(ROOT)}: {pattern.pattern}")
    assert not offenders, "личные пути/адреса найдены:\n" + "\n".join(offenders)


def test_setup_sh_is_valid_bash():
    result = subprocess.run(["bash", "-n", str(ROOT / "scripts" / "setup.sh")], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_env_example_has_every_config_variable():
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
    documented = set(re.findall(r"^#?(AO_[A-Z_]+)=", env_example, re.MULTILINE))
    config_src = (ROOT / "app" / "config.py").read_text(encoding="utf-8")
    used = set(re.findall(r'os\.getenv\("(AO_[A-Z_]+)"', config_src))
    missing = used - documented
    assert not missing, f".env.example не документирует переменные: {missing}"


def test_repos_json_not_committed_and_example_has_placeholder():
    assert not (ROOT / "workspace" / "repos.json").exists() or "repos.json" in (ROOT / ".gitignore").read_text()
    example = (ROOT / "workspace" / "repos.example.json").read_text(encoding="utf-8")
    assert REAL_USERNAME not in example
    assert "path" in example
