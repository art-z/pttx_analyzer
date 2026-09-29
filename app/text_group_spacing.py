"""Inter-line spacing for split text groups derived from txBody a:pPr/a:lnSpc."""

from __future__ import annotations

from typing import Any


def compute_text_group_spacing_pt(
    segments: list[dict],
    paragraph: dict | None = None,
) -> dict[str, float | str | bool] | None:
    """Derive flex-stack line gap and render line-height from OOXML lnSpc (spcPct/spcPts)."""
    if len(segments) < 2:
        return None

    source = _spacing_source(segments[0], paragraph)
    preceding_size_pt = _preceding_line_size_pt(segments)
    ratio = float(source.get("line_spacing_ratio") or 1.0)
    unit = source.get("line_spacing_unit") or "ratio"
    applicable = source.get("line_height_applicable")
    line_height_pt = source.get("line_height_pt")

    if unit == "pt" and line_height_pt is not None:
        line_step_pt = round(float(line_height_pt), 2)
    else:
        line_step_pt = round(preceding_size_pt * ratio, 2)

    if applicable:
        preceding_box_pt = round(float(line_height_pt or preceding_size_pt * ratio), 2)
        render_line_height_ratio = None
    elif applicable is False:
        render_line_height_ratio = round(ratio, 3)
        preceding_box_pt = round(preceding_size_pt * ratio, 2)
    else:
        render_line_height_ratio = None
        preceding_box_pt = round(preceding_size_pt * ratio, 2)

    line_gap_pt = max(0.0, round(line_step_pt - preceding_box_pt, 2))

    payload: dict[str, float | str | bool] = {
        "line_step_pt": line_step_pt,
        "line_gap_pt": line_gap_pt,
        "line_spacing_ratio": round(ratio, 3),
        "line_spacing_unit": unit,
        "preceding_size_pt": round(preceding_size_pt, 2),
    }
    if line_height_pt is not None:
        payload["line_height_pt"] = round(float(line_height_pt), 2)
    if applicable is not None:
        payload["line_height_applicable"] = bool(applicable)
    if render_line_height_ratio is not None:
        payload["render_line_height_ratio"] = render_line_height_ratio
        # Tight lnSpc inside one txBody (metric badges); flex stack replaces box padding + lnSpc.
        payload["flex_stack_layout"] = "compact_display"
    return payload


def _spacing_source(segment: dict | None, paragraph: dict | None = None) -> dict[str, Any]:
    if paragraph:
        return paragraph
    if not segment:
        return {}
    return segment


def _preceding_line_size_pt(segments: list[dict]) -> float:
    typography = (segments[0].get("typography") or {}) if segments else {}
    return float(typography.get("size_pt") or 14.0)
