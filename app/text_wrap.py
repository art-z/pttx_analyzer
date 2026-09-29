"""Simulate DrawingML text-box auto-wrap for parsed paragraph runs."""

from __future__ import annotations

import copy
import re
from typing import Any

MONOSPACE_FAMILY_RE = re.compile(r"consolas|courier|mono|menlo|source code", re.IGNORECASE)
MONOSPACE_CHAR_WIDTH_RATIO = 0.6015625
PROPORTIONAL_CHAR_WIDTH_RATIO = 0.5


def text_wrap_enabled(wrap: str | None) -> bool:
    return wrap not in {None, "", "none"}


def available_text_width_pt(
    geometry_pt: dict[str, float] | None,
    body_insets_pt: dict[str, float] | None,
) -> float | None:
    geometry = geometry_pt or {}
    width_pt = float(geometry.get("width_pt") or 0.0)
    if width_pt <= 0:
        return None
    insets = body_insets_pt or {}
    left = float(insets.get("left") or insets.get("left_pt") or 0.0)
    right = float(insets.get("right") or insets.get("right_pt") or 0.0)
    available = width_pt - left - right
    return available if available > 0 else None


def _char_width_pt(char: str, size_pt: float, family: str | None) -> float:
    if not char or char == "\n":
        return 0.0
    ratio = MONOSPACE_CHAR_WIDTH_RATIO if MONOSPACE_FAMILY_RE.search(family or "") else PROPORTIONAL_CHAR_WIDTH_RATIO
    return float(size_pt or 14.0) * ratio


def _clone_run(run: dict[str, Any], text: str) -> dict[str, Any]:
    payload = copy.copy(run)
    payload["text"] = text
    return payload


def _wrap_run_group(runs: list[dict[str, Any]], max_width_pt: float) -> list[dict[str, Any]]:
    if max_width_pt <= 0 or not runs:
        return list(runs)

    output: list[dict[str, Any]] = []
    line_width = 0.0
    pending: dict[str, Any] | None = None
    pending_text = ""

    def flush_pending() -> None:
        nonlocal pending, pending_text, line_width
        if pending is not None and pending_text:
            output.append(_clone_run(pending, pending_text))
        pending = None
        pending_text = ""

    for run in runs:
        text = run.get("text") or ""
        if not text:
            continue
        size_pt = float(run.get("size_pt") or 14.0)
        family = run.get("family") or "Arial"
        index = 0
        while index < len(text):
            char = text[index]
            char_width = _char_width_pt(char, size_pt, family)
            if line_width > 0 and line_width + char_width > max_width_pt:
                flush_pending()
                output.append({"break": "line"})
                line_width = 0.0
                continue
            if pending is None or pending is not run:
                flush_pending()
                pending = run
                pending_text = char
            else:
                pending_text += char
            line_width += char_width
            index += 1
    flush_pending()
    return output or list(runs)


def paragraph_uses_monospace_font(paragraph: dict[str, Any]) -> bool:
    for run in paragraph.get("runs") or []:
        family = (run.get("family") or "").lower()
        if MONOSPACE_FAMILY_RE.search(family):
            return True
    return False


def expand_wrapped_paragraph_runs(
    paragraphs: list[dict[str, Any]],
    *,
    geometry_pt: dict[str, float] | None,
    body_insets_pt: dict[str, float] | None,
    wrap: str | None,
    monospace_only: bool = True,
) -> list[dict[str, Any]]:
    if not paragraphs or not text_wrap_enabled(wrap):
        return paragraphs
    max_width_pt = available_text_width_pt(geometry_pt, body_insets_pt)
    if max_width_pt is None:
        return paragraphs

    expanded: list[dict[str, Any]] = []
    for paragraph in paragraphs:
        runs = paragraph.get("runs") or []
        if not runs or (monospace_only and not paragraph_uses_monospace_font(paragraph)):
            expanded.append(paragraph)
            continue

        wrapped_runs: list[dict[str, Any]] = []
        current_group: list[dict[str, Any]] = []
        for run in runs:
            if run.get("break") in {"line", "paragraph"}:
                if current_group:
                    wrapped_runs.extend(_wrap_run_group(current_group, max_width_pt))
                    current_group = []
                wrapped_runs.append({"break": run["break"]})
            elif run.get("text"):
                current_group.append(run)
        if current_group:
            wrapped_runs.extend(_wrap_run_group(current_group, max_width_pt))

        updated = dict(paragraph)
        updated["runs"] = wrapped_runs
        expanded.append(updated)
    return expanded


def rebuild_paragraph_text(paragraph: dict[str, Any]) -> str:
    parts: list[str] = []
    for run in paragraph.get("runs") or []:
        if run.get("break") == "line":
            parts.append("\n")
        elif run.get("text"):
            parts.append(run["text"])
    text = "".join(parts).strip()
    return text.lstrip("\u200b\ufeff")
