"""Линтер DESIGN.md (app/core/design_md.py): front matter (открытие/закрытие,
обязательные ключи, ссылки {a.b.c}, hex-цвета) и порядок ##-разделов."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from app import config
from app.core.design_md import lint_file, lint_text, main

VALID = """---
version: "1"
name: "x"
description: "d"
colors:
  arcade:
    bg: "#0b0616"
typography:
  fontFamily: "x"
---

## Overview

## Colors

## Typography

## Layout

## Elevation & Depth

## Shapes

## Components

## Do's and Don'ts
"""


def test_real_repo_design_md_has_no_issues():
    assert lint_file(Path(__file__).resolve().parents[1] / "DESIGN.md") == []


def test_valid_minimal_document_has_no_issues():
    assert lint_text(VALID) == []


def test_missing_opening_delimiter():
    issues = lint_text("# hi\n")
    assert any("front matter" in i and "1:" in i for i in issues)


def test_unclosed_front_matter():
    issues = lint_text('---\nversion: "a"\n')
    assert any("не закрыт" in i for i in issues)


def test_missing_required_top_level_keys():
    text = """---
version: "1"
name: "x"
---

## Overview

## Colors

## Typography

## Layout

## Elevation & Depth

## Shapes

## Components

## Do's and Don'ts
"""
    issues = lint_text(text)
    assert any("'description'" in i for i in issues)
    assert any("'colors'" in i for i in issues)
    assert any("'typography'" in i for i in issues)


def test_unresolved_reference_reports_key_and_line():
    text = VALID.replace(
        'fontFamily: "x"', 'fontFamily: "x"\n  ref: "{colors.nope.zzz}"'
    )
    issues = lint_text(text)
    assert any("{colors.nope.zzz}" in i and "typography.ref" in i for i in issues)


def test_wildcard_reference_resolves():
    text = """---
version: "1"
name: "x"
description: "d"
colors:
  status:
    todo:
      color: "#111"
    done:
      color: "#222"
typography:
  fontFamily: "x"
components:
  pill:
    backgroundColor: "{colors.status.*.color}"
---

## Overview

## Colors

## Typography

## Layout

## Elevation & Depth

## Shapes

## Components

## Do's and Don'ts
"""
    assert lint_text(text) == []


def test_invalid_hex_color_reports_key_and_value():
    text = VALID.replace('bg: "#0b0616"', 'bg: "#gggggg"')
    issues = lint_text(text)
    assert any("#gggggg" in i and "colors.arcade.bg" in i for i in issues)


def test_valid_hex_forms_rgb_rrggbb_rrggbbaa():
    text = VALID.replace('bg: "#0b0616"', 'bg: "#abc"')
    assert lint_text(text) == []
    text = VALID.replace('bg: "#0b0616"', 'bg: "#0b0616aa"')
    assert lint_text(text) == []


def test_extra_section_between_required_ones():
    text = VALID.replace("## Colors\n", "## Colors\n\n## Extra\n")
    issues = lint_text(text)
    assert any("неожиданный раздел '## Extra'" in i for i in issues)


def test_sections_out_of_order():
    text = VALID.replace(
        "## Overview\n\n## Colors\n", "## Colors\n\n## Overview\n"
    )
    issues = lint_text(text)
    assert any("не по порядку" in i for i in issues)


def test_missing_required_section():
    text = VALID.replace("## Shapes\n\n", "")
    issues = lint_text(text)
    assert any("'## Shapes'" in i for i in issues)


# ------------------------------------------------------------------ CLI: python -m app.core.design_md lint
def test_cli_main_returns_0_on_valid_file(tmp_path, capsys):
    path = tmp_path / "DESIGN.md"
    path.write_text(VALID, encoding="utf-8")
    assert main(["lint", str(path)]) == 0
    assert capsys.readouterr().out == ""


def test_cli_main_returns_1_on_invalid_file(tmp_path, capsys):
    path = tmp_path / "DESIGN.md"
    path.write_text("# hi\n", encoding="utf-8")
    assert main(["lint", str(path)]) == 1
    assert "front matter" in capsys.readouterr().out


def test_cli_main_returns_1_when_file_missing(tmp_path, capsys):
    assert main(["lint", str(tmp_path / "nope.md")]) == 1
    assert "не найден" in capsys.readouterr().out


def test_cli_subprocess_end_to_end(tmp_path):
    valid_path = tmp_path / "valid.md"
    valid_path.write_text(VALID, encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-m", "app.core.design_md", "lint", str(valid_path)],
        cwd=str(config.ROOT), capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

    invalid_path = tmp_path / "invalid.md"
    invalid_path.write_text("# hi\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-m", "app.core.design_md", "lint", str(invalid_path)],
        cwd=str(config.ROOT), capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "front matter" in result.stdout
