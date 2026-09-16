"""Каждая задача — отдельная ветка и отдельный git worktree. Агент правит файлы
там, main не трогает. После апрува ветка вливается в main, worktree удаляется."""
from __future__ import annotations

import asyncio
import logging
import shutil
import sys
import uuid
from pathlib import Path

from app.config import WORKTREES_DIR

log = logging.getLogger(__name__)


async def _git(repo: str | Path, *args: str) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        "git", "-C", str(repo), *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    return proc.returncode, out.decode("utf-8", errors="replace").strip()


async def is_repo(path: str) -> bool:
    code, _ = await _git(path, "rev-parse", "--is-inside-work-tree")
    return code == 0


async def default_branch(repo: str, base: str | None = None) -> str:
    """База для diff/merge: (а) явно заданная в repos.json (`base`) — используем как есть;
    (б) иначе ветка, на которую указывает origin/HEAD (без префикса `origin/`);
    (в) иначе первая существующая из main/master. НЕ текущий HEAD рабочей копии —
    им может быть чужая ветка пользователя или detached HEAD (см. ревью 2026-09-16)."""
    if base:
        return base
    code, out = await _git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if code == 0 and out:
        return out.split("/", 1)[1] if out.startswith("origin/") else out
    for name in ("main", "master"):
        code, _ = await _git(repo, "show-ref", "--verify", "--quiet", f"refs/heads/{name}")
        if code == 0:
            return name
    return "main"


async def create(repo: str, task_id: str) -> tuple[str, str]:
    """Возвращает (branch, worktree_path)."""
    branch = f"agent/{task_id}"
    path = WORKTREES_DIR / task_id
    # снять старую регистрацию (после перезапуска сервера каталог мог остаться «missing but registered»)
    await _git(repo, "worktree", "remove", "--force", str(path))
    await _git(repo, "worktree", "prune")
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    code, out = await _git(repo, "worktree", "add", "-f", "-b", branch, str(path))
    if code != 0:
        # ветка уже есть (повторный запуск) — переиспользуем
        code, out = await _git(repo, "worktree", "add", "-f", str(path), branch)
        if code != 0:
            raise RuntimeError(f"git worktree add: {out}")
    await _link_env(Path(repo), path)
    return branch, str(path)


ENV_LINKS = (".venv", "venv", "node_modules", ".env")


async def _link_one(src: Path, dst: Path) -> bool:
    """symlink на оригинал; на Windows он требует прав (обычно только dev-режим/админ) —
    тогда junction для каталога (`mklink /J`, прав не требует) или копия для файла.
    Ничего не вышло — просто лог и продолжаем без этого куска окружения, чем ронять
    создание задачи из-за одного .env, который агент, возможно, и не тронет."""
    try:
        dst.symlink_to(src)
        return True
    except OSError:
        pass
    if sys.platform != "win32":
        return False
    if src.is_dir():
        proc = await asyncio.create_subprocess_exec(
            "cmd", "/c", "mklink", "/J", str(dst), str(src),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await proc.wait()
        if dst.exists():
            return True
        log.warning("не удалось создать junction %s -> %s", dst, src)
        return False
    try:
        shutil.copy2(src, dst)
        return True
    except OSError:
        log.warning("не удалось скопировать %s в %s", src, dst)
        return False


async def _link_env(repo: Path, worktree: Path) -> None:
    """Окружение проекта не в git (.venv, node_modules, .env) — без него агент не может
    запустить тесты, а ставить пакеты ему запрещено. Подкладываем symlink'и на оригиналы
    (на Windows без прав на symlink — junction/копия, см. _link_one).

    Symlink для git — файл, и правило `.venv/` (со слэшем) его НЕ игнорирует, так что
    `git add -A` закоммитил бы ссылку. Поэтому пишем имена в `.git/info/exclude` проекта:
    это локальный файл, в коммиты не попадает, а действует на все worktree."""
    linked = []
    for name in ENV_LINKS:
        src, dst = repo / name, worktree / name
        if src.exists() and not dst.exists() and await _link_one(src, dst):
            linked.append(name)
    if not linked:
        return
    code, common = await _git(worktree, "rev-parse", "--git-common-dir")
    if code == 0:
        exclude = Path(common if common.startswith("/") else worktree / common) / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        present = exclude.read_text(encoding="utf-8").splitlines() if exclude.exists() else []
        new_lines = [f"/{n}" for n in linked if f"/{n}" not in present]
        if new_lines:
            with exclude.open("a", encoding="utf-8") as fh:
                fh.write("".join(l + "\n" for l in new_lines))


async def commit_all(worktree: str, message: str) -> bool:
    """Коммитит всё, что агент оставил незакоммиченным. False — нечего коммитить."""
    await _git(worktree, "add", "-A")
    code, out = await _git(worktree, "-c", "user.name=cyber_office", "-c", "user.email=agent@office.local",
                           "commit", "-q", "-m", message)
    return code == 0


async def diff_stat(repo: str, branch: str, base: str | None = None) -> str:
    resolved = await default_branch(repo, base)
    _, out = await _git(repo, "diff", "--stat", f"{resolved}...{branch}")
    return out


async def diff_full(repo: str, branch: str, base: str | None = None, limit: int = 200_000) -> str:
    resolved = await default_branch(repo, base)
    _, out = await _git(repo, "diff", f"{resolved}...{branch}")
    return out[:limit] + ("\n…(обрезано)" if len(out) > limit else "")


async def head_sha(repo: str) -> str:
    _, out = await _git(repo, "rev-parse", "HEAD")
    return out


async def diff_merge_commit(repo: str, commit: str, limit: int = 200_000) -> str:
    _, out = await _git(repo, "diff", f"{commit}^1", commit)
    return out[:limit] + ("\n…(обрезано)" if len(out) > limit else "")


async def merge(repo: str, branch: str, message: str, base: str | None = None) -> tuple[str, str]:
    """Вливает ветку агента в base без fast-forward — в отдельном временном detached
    worktree, а не в основном чекауте репозитория: тот принадлежит пользователю (может
    быть грязным или переключён на другую ветку) и его нельзя трогать.

    --detach обязателен: base почти наверняка уже выведена в рабочую копию пользователя,
    а git не даёт вывести одну и ту же ветку в двух worktree одновременно без него.

    Возвращает (status, sha_or_output): status — 'ok' (sha влитого коммита),
    'conflict' (настоящий конфликт мерджа — вывод git merge --abort уже сделан) или
    'failed' (прочая ошибка git — полный вывод, без автоповтора со стороны Office)."""
    resolved = await default_branch(repo, base)
    tmp = WORKTREES_DIR / f"_merge_{uuid.uuid4().hex[:8]}"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    code, out = await _git(repo, "worktree", "add", "--detach", str(tmp), resolved)
    if code != 0:
        return "failed", out
    try:
        code, out = await _git(str(tmp), "-c", "user.name=cyber_office", "-c", "user.email=agent@office.local",
                               "merge", "--no-ff", "-q", "-m", message, branch)
        if code != 0:
            if "CONFLICT" in out:
                await _git(str(tmp), "merge", "--abort")
                return "conflict", out
            return "failed", out
        code, sha = await _git(str(tmp), "rev-parse", "HEAD")
        if code != 0:
            return "failed", sha
        # Если base выведена в рабочую копию пользователя — двигаем её fast-forward'ом:
        # это обновит и ref, и индекс, и файлы на диске (update-ref сдвинул бы только ref,
        # и рабочая копия осталась бы на старом коммите — так пропадали файлы после мержа).
        _, head_ref = await _git(repo, "symbolic-ref", "-q", "HEAD")
        if head_ref.strip() == f"refs/heads/{resolved}":
            code, out = await _git(repo, "merge", "--ff-only", sha)
            if code == 0:
                return "ok", sha
            log.warning("ff-only в рабочей копии %s не удался (%s) — обновляю только ref", repo, out.strip()[:200])
        code, out = await _git(repo, "update-ref", f"refs/heads/{resolved}", sha)
        if code != 0:
            return "failed", out
        return "ok", sha
    finally:
        await _git(repo, "worktree", "remove", "--force", str(tmp))
        shutil.rmtree(tmp, ignore_errors=True)
        await _git(repo, "worktree", "prune")


async def remove(repo: str, branch: str | None, worktree: str | None, delete_branch: bool) -> None:
    if worktree:
        await _git(repo, "worktree", "remove", "--force", worktree)
        shutil.rmtree(worktree, ignore_errors=True)
    if branch and delete_branch:
        await _git(repo, "branch", "-D", branch)
    await _git(repo, "worktree", "prune")


async def keep_previous(repo: str, branch: str | None, worktree: str | None) -> str | None:
    """Перед повтором задачи: worktree убираем, а ветку переименовываем в <branch>-prev,
    чтобы агент мог перенести из неё готовую работу (cherry-pick) вместо переделки."""
    if worktree:
        await _git(repo, "worktree", "remove", "--force", worktree)
        shutil.rmtree(worktree, ignore_errors=True)
    await _git(repo, "worktree", "prune")
    if not branch:
        return None
    prev = f"{branch}-prev"
    await _git(repo, "branch", "-D", prev)
    code, _ = await _git(repo, "branch", "-m", branch, prev)
    return prev if code == 0 else None


async def staleness(repo: str, branch: str, base: str | None = None) -> tuple[int, list[str]]:
    """Насколько ветка агента отстала от base: (коммитов в base после точки ветвления,
    файлы, которые менялись и там, и там — кандидаты на конфликт при мердже)."""
    resolved = await default_branch(repo, base)
    code, fork = await _git(repo, "merge-base", resolved, branch)
    if code != 0 or not fork:
        return 0, []
    _, behind = await _git(repo, "rev-list", "--count", f"{fork}..{resolved}")
    behind_n = int(behind or 0)
    if behind_n == 0:
        return 0, []
    _, main_files = await _git(repo, "diff", "--name-only", f"{fork}..{resolved}")
    _, br_files = await _git(repo, "diff", "--name-only", f"{fork}..{branch}")
    overlap = sorted(set(main_files.split()) & set(br_files.split()))
    return behind_n, overlap
