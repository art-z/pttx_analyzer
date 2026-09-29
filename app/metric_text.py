"""Detect numeric values with typographic units inside a single PPTX text shape."""

from __future__ import annotations

import re
from typing import Any

METRIC_SUFFIX_RE = re.compile(
    r"^(?P<value>[\d\s.,+\-/]+)(?P<unit>%|°|℃|℉|‰|[₽$€£]|[A-Za-z\u0400-\u04FF]{1,6})$"
)
UNIT_TOKEN_RE = re.compile(
    r"^(%|°|℃|℉|‰|[₽$€£]|[A-Za-z\u0400-\u04FF]{1,6})$"
)

TYPOGRAPHY_KEYS = ("family", "size_pt", "bold", "italic", "strike", "underline", "color", "alpha")


def _first_line_runs(runs: list[dict]) -> list[dict]:
    line: list[dict] = []
    for run in runs:
        if run.get("break") in {"line", "paragraph"}:
            break
        if run.get("text"):
            line.append(run)
    return line


def _style_signature(run: dict) -> tuple:
    return (
        run.get("family"),
        run.get("size_pt"),
        bool(run.get("bold")),
        bool(run.get("italic")),
        bool(run.get("strike")),
        run.get("underline"),
        run.get("color"),
        run.get("alpha"),
    )


def _typography_from_run(run: dict | None, fallback: dict | None = None) -> dict:
    base = fallback or {}
    run = run or {}
    payload: dict[str, Any] = {}
    for key in TYPOGRAPHY_KEYS:
        value = run.get(key)
        if value is None:
            value = base.get(key)
        if value is not None:
            payload[key] = value
    return payload


def _summarize_run_typography(runs: list[dict], fallback: dict | None = None) -> dict:
    if not runs:
        return _typography_from_run(None, fallback)
    if len(runs) == 1:
        return _typography_from_run(runs[0], fallback)
    weighted: dict[tuple, int] = {}
    styles: dict[tuple, dict] = {}
    for run in runs:
        text = run.get("text") or ""
        if not text:
            continue
        key = _style_signature(run)
        weighted[key] = weighted.get(key, 0) + len(text)
        styles[key] = run
    if not weighted:
        return _typography_from_run(None, fallback)
    dominant = max(weighted, key=weighted.get)
    return _typography_from_run(styles[dominant], fallback)


def _is_unit_token(text: str) -> bool:
    token = (text or "").strip()
    if not token:
        return False
    return bool(UNIT_TOKEN_RE.fullmatch(token))


def _serialize_runs_for_export(runs: list[dict]) -> list[dict] | None:
    payload: list[dict] = []
    for run in runs:
        if run.get("break"):
            payload.append({"break": run["break"]})
            continue
        text = run.get("text")
        if not text:
            continue
        item = {"text": text}
        for key in TYPOGRAPHY_KEYS:
            if run.get(key) is not None:
                item[key] = run[key]
        payload.append(item)
    return payload or None


def _line_groups_from_runs(runs: list[dict]) -> list[list[dict]]:
    groups: list[list[dict]] = []
    current: list[dict] = []
    for run in runs:
        if run.get("break") in {"line", "paragraph"}:
            if current:
                groups.append(current)
                current = []
        elif run.get("text"):
            current.append(run)
    if current:
        groups.append(current)
    return groups


def _line_group_text(group: list[dict]) -> str:
    return "".join(run.get("text") or "" for run in group).strip()


def paragraph_is_metric(paragraph: dict) -> bool:
    """True when a single txBody paragraph is value + unit, possibly split by soft breaks."""
    runs = paragraph.get("runs") or []
    if not runs:
        return False

    line_runs = _first_line_runs(runs)
    joined_first_line = "".join(run.get("text") or "" for run in line_runs).strip()
    if joined_first_line and detect_metric_text(joined_first_line, line_runs, None):
        return True

    line_groups = _line_groups_from_runs(runs)
    if len(line_groups) >= 2 and _is_unit_token(_line_group_text(line_groups[-1])):
        # Value + unit on separate lines stay split for vertical flex rendering.
        return False
    return False


def paragraph_metric_display_text(paragraph: dict) -> str:
    runs = paragraph.get("runs") or []
    line_groups = _line_groups_from_runs(runs)
    if len(line_groups) >= 2 and _is_unit_token(_line_group_text(line_groups[-1])):
        value = "".join(_line_group_text(group) for group in line_groups[:-1]).strip()
        unit = _line_group_text(line_groups[-1]).strip()
        return f"{value}{unit}"
    return (paragraph.get("text") or _line_group_text(_first_line_runs(runs))).replace("\n", "")


def segments_form_metric(segments: list[dict]) -> bool:
    if len(segments) < 2:
        return False
    signatures = {
        (
            (segment.get("typography") or {}).get("family"),
            (segment.get("typography") or {}).get("size_pt"),
            bool((segment.get("typography") or {}).get("bold")),
            bool((segment.get("typography") or {}).get("italic")),
        )
        for segment in segments
    }
    if len(signatures) > 1:
        return False
    combined = "".join((segment.get("text") or "").replace("\n", "").strip() for segment in segments)
    if not combined:
        return False
    typography = segments[0].get("typography") or {}
    return detect_metric_text(combined, None, typography) is not None


def runs_have_inline_style_variation(runs: list[dict]) -> bool:
    signatures: set[tuple] = set()
    for run in runs:
        if run.get("break") or not run.get("text"):
            continue
        signatures.add(_style_signature(run))
        if len(signatures) > 1:
            return True
    return False


def detect_metric_text(
    text: str,
    runs: list[dict] | None,
    typography: dict | None = None,
) -> dict | None:
    """Return structured metric payload when text looks like value + unit."""
    typography = typography or {}
    line_runs = _first_line_runs(runs or [])
    joined = "".join(run.get("text") or "" for run in line_runs) or (text or "").split("\n", 1)[0]
    joined = joined.strip()
    if not joined:
        return None

    if line_runs and len(line_runs) >= 2 and _is_unit_token(line_runs[-1].get("text")):
        value_runs = line_runs[:-1]
        unit_runs = [line_runs[-1]]
        value = "".join(run.get("text") or "" for run in value_runs).strip()
        unit = (unit_runs[0].get("text") or "").strip()
        if value and unit:
            value_typography = _summarize_run_typography(value_runs, typography)
            unit_typography = _typography_from_run(unit_runs[0], typography)
            styles_differ = _style_signature(value_runs[0]) != _style_signature(unit_runs[0])
            if styles_differ or METRIC_SUFFIX_RE.fullmatch(joined):
                return {
                    "value": value,
                    "unit": unit,
                    "value_typography": value_typography,
                    "unit_typography": unit_typography,
                    "split_source": "runs",
                }

    line_groups = _line_groups_from_runs(runs or [])
    if len(line_groups) >= 2 and _is_unit_token(_line_group_text(line_groups[-1])):
        value = "".join(_line_group_text(group) for group in line_groups[:-1]).strip()
        unit = _line_group_text(line_groups[-1]).strip()
        if value and unit and METRIC_SUFFIX_RE.fullmatch(f"{value}{unit}"):
            value_runs = [run for group in line_groups[:-1] for run in group]
            unit_run = line_groups[-1][0]
            return {
                "value": value,
                "unit": unit,
                "value_typography": _summarize_run_typography(value_runs, typography),
                "unit_typography": _typography_from_run(unit_run, typography),
                "split_source": "runs",
            }

    match = METRIC_SUFFIX_RE.fullmatch(joined)
    if not match:
        return None

    value = match.group("value").strip()
    unit = match.group("unit")
    if not value or not unit:
        return None

    value_typography = _summarize_run_typography(line_runs, typography) if line_runs else dict(typography)
    unit_typography = dict(value_typography)
    if line_runs and len(line_runs) >= 2:
        unit_typography = _typography_from_run(line_runs[-1], typography)

    payload = {
        "value": value,
        "unit": unit,
        "value_typography": value_typography,
        "unit_typography": unit_typography,
        "split_source": "text",
    }
    if line_runs and len(line_runs) >= 2 and _style_signature(line_runs[-1]) != _style_signature(line_runs[0]):
        payload["split_source"] = "runs"
    return payload


def attach_metric_fields(element: dict, paragraphs: list[dict]) -> None:
    runs = []
    for paragraph in paragraphs:
        runs.extend(paragraph.get("runs") or [])
    flat = []
    for index, paragraph in enumerate(paragraphs):
        if index > 0:
            flat.append({"break": "paragraph"})
        flat.extend(paragraph.get("runs") or [])

    exported_runs = _serialize_runs_for_export(flat)
    if exported_runs and runs_have_inline_style_variation(flat):
        element["text_runs"] = exported_runs

    metric = detect_metric_text(element.get("text") or "", flat, element.get("typography"))
    if metric:
        element["metric"] = metric
