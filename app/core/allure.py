"""Отчёт по прогону в духе Allure Overview: разбор allure-results (если testlab.run()
их собрал — см. TestRun.allure) в passed/failed/broken/skipped + шаги/вложения, с
fallback на разбор обычного stdout pytest, когда allure-pytest не установлен в
репозитории. Плюс обёртка над Allure CLI для кнопки «Открыть в Allure» — сам Allure
не устанавливаем, только ищем и запускаем то, что уже стоит у пользователя."""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from pathlib import Path

from app import config
from app.core import testlab

STATUSES = ("passed", "failed", "broken", "skipped")
_SUMMARY_RE = re.compile(r"(\d+) (passed|failed|skipped|error)\b")


def _safe_name(name: str) -> str | None:
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        return None
    return name


def _empty_counts() -> dict[str, int]:
    return {"passed": 0, "failed": 0, "broken": 0, "skipped": 0, "unknown": 0}


# ------------------------------------------------------------------ разбор allure-results
def _step(node: dict) -> dict:
    return {
        "name": node.get("name") or "",
        "status": node.get("status") or "unknown",
        "steps": [_step(s) for s in (node.get("steps") or [])],
    }


def _collect_attachments(node: dict, out: list[dict]) -> None:
    for a in node.get("attachments") or []:
        out.append({"name": a.get("name") or a.get("source") or "", "source": a.get("source") or "", "type": a.get("type") or ""})
    for s in node.get("steps") or []:
        _collect_attachments(s, out)


def _parse_result(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    labels = {l.get("name"): l.get("value") for l in data.get("labels") or []}
    full_name = data.get("fullName") or data.get("name") or ""
    file_, name = full_name, data.get("name") or full_name
    for sep in ("::", "#"):
        if sep in full_name:
            file_, _, rest = full_name.partition(sep)
            name = rest or name
            break
    start, stop = data.get("start"), data.get("stop")
    duration = (stop - start) / 1000.0 if isinstance(start, (int, float)) and isinstance(stop, (int, float)) else None
    status = data.get("status") or "unknown"
    details = data.get("statusDetails") or {}
    attachments: list[dict] = []
    _collect_attachments(data, attachments)
    return {
        "uid": data.get("uuid") or path.stem,
        "name": data.get("name") or name,
        "suite": labels.get("suite") or labels.get("parentSuite") or "",
        "file": file_,
        "status": status if status in STATUSES else "unknown",
        "duration": duration,
        "message": details.get("message"),
        "trace": details.get("trace"),
        "steps": [_step(s) for s in data.get("steps") or []],
        "attachments": attachments,
    }


def _allure_tests(repo: str, run_id: str) -> list[dict]:
    d = testlab.allure_results_dir(repo, run_id)
    if not d.is_dir():
        return []
    return [_parse_result(p) for p in sorted(d.glob("*-result.json"))]


# ------------------------------------------------------------------ fallback без allure
def _fallback(tr: "testlab.TestRun") -> tuple[list[dict], dict]:
    counts = _empty_counts()
    for n, word in _SUMMARY_RE.findall(tr.stdout or ""):
        if word == "error":
            counts["broken"] += int(n)
        else:
            counts[word] += int(n)
    tests = [{
        "uid": nodeid, "name": nodeid.rsplit("::", 1)[-1], "suite": "",
        "file": nodeid.split("::", 1)[0] if "::" in nodeid else nodeid,
        "status": "failed", "duration": None, "message": None, "trace": None,
        "steps": [], "attachments": [],
    } for nodeid in tr.failed]
    return tests, counts


def _counts_from_tests(tests: list[dict]) -> dict[str, int]:
    counts = _empty_counts()
    for t in tests:
        counts[t["status"]] = counts.get(t["status"], 0) + 1
    return counts


# ------------------------------------------------------------------ отчёт по одному прогону
def build_report(repo: str, run_id: str) -> dict:
    tr = testlab.RunStore(repo).get(run_id) or testlab.find_run(run_id)
    if tr is None:
        raise LookupError(run_id)

    tests = _allure_tests(repo, run_id) if tr.allure else []
    if tests:
        counts, source = _counts_from_tests(tests), "allure"
    else:
        tests, counts = _fallback(tr)
        source = "fallback"

    return {
        "run_id": tr.id, "repo": tr.repo, "target": tr.target, "status": tr.status,
        "duration": tr.duration, "started_at": tr.started_at, "finished_at": tr.finished_at,
        "allure": tr.allure, "allure_error": tr.allure_error,
        "counts": counts, "tests": tests, "source": source,
    }


def build_trend(repo: str, limit: int = 20) -> list[dict]:
    runs = list(reversed(testlab.RunStore(repo).list()[:limit]))   # по возрастанию времени, для графика
    out = []
    for tr in runs:
        try:
            report = build_report(repo, tr.id)
        except LookupError:
            continue
        total = sum(report["counts"].values())
        passed = report["counts"].get("passed", 0)
        pass_rate = (passed / total) if total else (1.0 if tr.status == "passed" else 0.0)
        out.append({"run_id": tr.id, "started_at": tr.started_at, "status": tr.status,
                     "duration": tr.duration, "pass_rate": pass_rate})
    return out


def attachment_path(repo: str, run_id: str, source: str) -> Path | None:
    safe = _safe_name(source)
    if not safe:
        return None
    d = testlab.allure_results_dir(repo, run_id)
    p = d / safe
    try:
        p.resolve().relative_to(d.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


# ------------------------------------------------------------------ Allure CLI
def find_allure_bin() -> str | None:
    if config.ALLURE_BIN and Path(config.ALLURE_BIN).is_file():
        return config.ALLURE_BIN
    return shutil.which("allure")


def can_open(repo: str, run_id: str) -> bool:
    if find_allure_bin() is None:
        return False
    d = testlab.allure_results_dir(repo, run_id)
    return d.is_dir() and any(d.iterdir())


async def generate_and_open(repo: str, run_id: str) -> None:
    bin_ = find_allure_bin()
    if not bin_:
        raise RuntimeError("Allure CLI не найден (задай AO_ALLURE_BIN или поставь allure в PATH)")
    results = testlab.allure_results_dir(repo, run_id)
    if not results.is_dir() or not any(results.iterdir()):
        raise RuntimeError("нет allure-results для этого прогона")
    out_dir = testlab.allure_report_dir(repo, run_id)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    proc = await asyncio.create_subprocess_exec(
        bin_, "generate", str(results), "-o", str(out_dir), "--clean",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(out.decode("utf-8", errors="replace").strip()[-800:] or "allure generate завершился с ошибкой")
    index = out_dir / "index.html"
    subprocess.Popen(["open", str(index)])
