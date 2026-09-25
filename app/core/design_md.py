"""Минимальный линтер DESIGN.md-файлов — только stdlib, без pyyaml.

Формат DESIGN.md: YAML-подобный front matter между строками `---`/`---`
(упрощённый парсер под структуру, которая уже используется в DESIGN.md
cyber_office и test_hub — вложенные мэппинги через отступ в 2 пробела,
списки `- "значение"`, полнострочные комментарии `# ...`), затем тело
с `##`-заголовками в фиксированном порядке.

CLI: ``python -m app.core.design_md lint [путь]``.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REQUIRED_TOP_LEVEL_KEYS = ["version", "name", "description", "colors", "typography"]

REQUIRED_SECTIONS = [
    "Overview",
    "Colors",
    "Typography",
    "Layout",
    "Elevation & Depth",
    "Shapes",
    "Components",
    "Do's and Don'ts",
]

_KEY_RE = re.compile(r"^([\w\-]+):\s*(.*)$")
_HEADING_RE = re.compile(r"^##(?!#)\s+(.+?)\s*$")
_REF_RE = re.compile(r"\{([^{}]+)\}")
_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def _unquote(raw: str) -> str:
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        return raw[1:-1]
    return raw


def _parse_mapping(lines, i, indent, path_prefix, leaves):
    node = {}
    n = len(lines)
    while i < n:
        line_no, ind, text = lines[i]
        if ind < indent:
            break
        if ind > indent or text.startswith("- "):
            # неожиданный отступ/элемент списка на месте мэппинга — пропускаем строку
            i += 1
            continue
        m = _KEY_RE.match(text)
        if not m:
            i += 1
            continue
        key, rest = m.group(1), m.group(2)
        child_path = f"{path_prefix}.{key}" if path_prefix else key
        if rest == "":
            if i + 1 < n and lines[i + 1][1] > indent:
                child_indent = lines[i + 1][1]
                if lines[i + 1][2].startswith("- "):
                    value, i = _parse_list(lines, i + 1, child_indent, child_path, leaves)
                else:
                    value, i = _parse_mapping(lines, i + 1, child_indent, child_path, leaves)
            else:
                value = ""
                leaves.append((child_path, line_no, value))
                i += 1
        else:
            value = _unquote(rest)
            leaves.append((child_path, line_no, value))
            i += 1
        node[key] = value
    return node, i


def _parse_list(lines, i, indent, path_prefix, leaves):
    items = []
    n = len(lines)
    idx = 0
    while i < n:
        line_no, ind, text = lines[i]
        if ind != indent or not text.startswith("- "):
            break
        item = _unquote(text[2:].strip())
        leaves.append((f"{path_prefix}[{idx}]", line_no, item))
        items.append(item)
        idx += 1
        i += 1
    return items, i


def _extract_front_matter(raw_lines, issues):
    """Возвращает (строки front matter, индекс начала тела в raw_lines)."""
    if not raw_lines or raw_lines[0].strip() != "---":
        issues.append("1: файл должен начинаться с front matter, ограниченного строками '---'")
        return None, 0
    end_idx = None
    for i in range(1, len(raw_lines)):
        if raw_lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        issues.append("front matter не закрыт второй строкой '---'")
        return None, len(raw_lines)
    return raw_lines[1:end_idx], end_idx + 1


def _resolve_ref(root, path: str) -> bool:
    def rec(node, parts):
        if not parts:
            return True
        part, rest = parts[0], parts[1:]
        if part == "*":
            if not isinstance(node, dict) or not node:
                return False
            return all(rec(v, rest) for v in node.values())
        if not isinstance(node, dict) or part not in node:
            return False
        return rec(node[part], rest)

    return rec(root, path.split("."))


def _check_required_keys(root):
    issues = []
    for key in REQUIRED_TOP_LEVEL_KEYS:
        if key not in root:
            issues.append(f"в front matter отсутствует обязательный ключ: '{key}'")
    return issues


def _check_references(root, leaves):
    issues = []
    for path, line_no, value in leaves:
        if not isinstance(value, str):
            continue
        for m in _REF_RE.finditer(value):
            ref = m.group(1)
            if not _resolve_ref(root, ref):
                issues.append(f"{line_no}: ссылка '{{{ref}}}' не резолвится (ключ '{path}')")
    return issues


def _check_hex_colors(leaves):
    issues = []
    for path, line_no, value in leaves:
        if isinstance(value, str) and value.startswith("#") and not _HEX_RE.match(value):
            issues.append(f"{line_no}: невалидный hex-цвет '{value}' (ключ '{path}')")
    return issues


def _check_heading_order(raw_lines, body_start_idx):
    found = []
    for i in range(body_start_idx, len(raw_lines)):
        m = _HEADING_RE.match(raw_lines[i])
        if m:
            found.append((m.group(1), i + 1))

    issues = []
    found_texts = {text for text, _ in found}
    for section in REQUIRED_SECTIONS:
        if section not in found_texts:
            issues.append(f"отсутствует обязательный раздел '## {section}'")

    max_idx = -1
    for text, line_no in found:
        if text not in REQUIRED_SECTIONS:
            issues.append(f"{line_no}: неожиданный раздел '## {text}'")
            continue
        idx = REQUIRED_SECTIONS.index(text)
        if idx < max_idx:
            issues.append(f"{line_no}: раздел '## {text}' идёт не по порядку")
        else:
            max_idx = idx
    return issues


def lint_text(text: str) -> list[str]:
    issues: list[str] = []
    raw_lines = text.splitlines()
    fm_lines, body_start_idx = _extract_front_matter(raw_lines, issues)

    if fm_lines is not None:
        lines_info = []
        for offset, raw in enumerate(fm_lines):
            line_no = 2 + offset  # front matter начинается на файловой строке 2
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            indent = len(raw) - len(raw.lstrip(" "))
            lines_info.append((line_no, indent, stripped))

        leaves: list[tuple[str, int, str]] = []
        root, _ = _parse_mapping(lines_info, 0, 0, "", leaves)

        issues.extend(_check_required_keys(root))
        issues.extend(_check_references(root, leaves))
        issues.extend(_check_hex_colors(leaves))

    issues.extend(_check_heading_order(raw_lines, body_start_idx))
    return issues


def lint_file(path: Path) -> list[str]:
    return lint_text(Path(path).read_text(encoding="utf-8"))


def _cmd_lint(path_str: str) -> int:
    path = Path(path_str)
    if not path.is_file():
        print(f"файл не найден: {path}")
        return 1
    issues = lint_file(path)
    for issue in issues:
        print(issue)
    return 1 if issues else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.core.design_md")
    sub = parser.add_subparsers(dest="command", required=True)
    lint_parser = sub.add_parser("lint", help="Проверить DESIGN.md")
    lint_parser.add_argument("path", nargs="?", default="DESIGN.md")
    args = parser.parse_args(argv)
    if args.command == "lint":
        return _cmd_lint(args.path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
