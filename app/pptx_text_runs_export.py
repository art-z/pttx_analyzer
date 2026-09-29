"""Export catalog text_runs (mixed inline styles) to python-pptx paragraphs."""

from __future__ import annotations

from typing import Any

TYPOGRAPHY_KEYS = ("family", "size_pt", "bold", "italic", "underline", "color", "alpha")


def group_text_runs_by_paragraph(text_runs: list[dict[str, Any]] | None) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for run in text_runs or []:
        if run.get("break") == "paragraph":
            if current:
                groups.append(current)
                current = []
            continue
        if run.get("break") == "line" or run.get("text"):
            current.append(run)
    if current:
        groups.append(current)
    return groups


def merge_run_typography(run: dict[str, Any], base: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(base or {})
    for key in TYPOGRAPHY_KEYS:
        if run.get(key) is not None:
            merged[key] = run[key]
    return merged


def add_styled_runs_paragraph(
    text_frame,
    *,
    index: int,
    runs: list[dict[str, Any]],
    typography: dict[str, Any] | None,
    spacing: dict[str, Any] | None,
    bullet: dict[str, Any] | None,
    apply_paragraph_style,
    apply_paragraph_bullet,
    apply_typography,
) -> None:
    paragraph = text_frame.paragraphs[0] if index == 0 else text_frame.add_paragraph()
    if index == 0 and paragraph.runs:
        paragraph.clear()
    elif index > 0:
        pass

    for run in runs:
        if run.get("break") == "line":
            paragraph.add_line_break()
            continue
        text = run.get("text") or ""
        if not text:
            continue
        run_element = paragraph.add_run()
        run_element.text = text
        apply_typography(run_element, merge_run_typography(run, typography))

    apply_paragraph_style(paragraph, typography, spacing)
    apply_paragraph_bullet(paragraph, bullet)
