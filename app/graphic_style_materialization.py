"""Freeze report-level design-system colors into generated graphic elements."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .chart_palette import (
    extract_design_system_chart_colors,
    extract_design_system_text_colors,
    resolve_chart_palette_for_baselines,
)

FALLBACK_CHART_PALETTE = ["#0077FF", "#00A86B", "#FF6B35", "#7B61FF", "#FFB020"]


def _mapping(container: dict[str, Any], key: str) -> dict[str, Any]:
    value = container.get(key)
    if not isinstance(value, dict):
        value = {}
        container[key] = value
    return value


def _graphic_palette(report: dict[str, Any]) -> list[str]:
    colors = report.get("colors") or {}
    return resolve_chart_palette_for_baselines(
        (report.get("graphic_components") or {}).get("chart_series_palette"),
        extract_design_system_chart_colors(colors),
        FALLBACK_CHART_PALETTE,
        min_colors=5,
        reserved_text_colors=extract_design_system_text_colors(colors),
    )


def _text_color(report: dict[str, Any]) -> str:
    colors = extract_design_system_text_colors(report.get("colors") or {})
    return colors[0] if colors else "#17212D"


def _materialize_chart(element: dict[str, Any], palette: list[str], text_color: str) -> None:
    chart = _mapping(element, "chart")
    style = deepcopy(chart.get("style_tokens") or element.get("style_tokens") or {})
    style["series_palette"] = [{"color": color} for color in palette]
    for key in ("category_axis", "value_axis", "legend"):
        token = _mapping(style, key)
        typography = _mapping(token, "typography")
        typography["color"] = text_color
    chart["style_tokens"] = style
    chart["series_palette"] = list(palette)
    element["series_palette"] = list(palette)


def _materialize_diagram(element: dict[str, Any], accent: str, text_color: str) -> None:
    diagram = _mapping(element, "diagram")
    style = deepcopy(diagram.get("style_tokens") or element.get("style_tokens") or {})
    use_observed = not element.get("is_baseline") or bool(element.get("deck_style_source"))
    connector = _mapping(style, "connector")
    node = _mapping(style, "node")
    typography = _mapping(node, "typography")
    border = _mapping(node, "border")
    if not use_observed or not connector.get("color"):
        connector["color"] = {"color": accent}
    if not use_observed or not border.get("color"):
        border["color"] = {"color": accent}
    border.setdefault("width_pt", 1)
    if not use_observed or not node.get("fill"):
        node["fill"] = {"kind": "solid", "color": "#FFFFFF"}
    typography["color"] = text_color
    typography.setdefault("family", "Arial")
    typography.setdefault("size_pt", 10)
    diagram["style_tokens"] = style
    element["style_tokens"] = style


def _materialize_table(element: dict[str, Any], text_color: str) -> None:
    table = _mapping(element, "table")
    style = deepcopy(table.get("style_tokens") or {})
    for key in ("body_cell", "whole_cell", "header_cell"):
        cell = _mapping(style, key)
        typography = _mapping(cell, "typography")
        typography["color"] = text_color
    table["style_tokens"] = style


def materialize_graphic_styles(
    report: dict[str, Any],
    slide: dict[str, Any],
) -> dict[str, Any]:
    result = deepcopy(slide)
    palette = _graphic_palette(report)
    accent = palette[0]
    text_color = _text_color(report)
    for element in result.get("content_elements") or []:
        kind = element.get("kind")
        if kind == "chart":
            _materialize_chart(element, palette, text_color)
        elif kind == "diagram":
            _materialize_diagram(element, accent, text_color)
        elif kind == "table":
            _materialize_table(element, text_color)
    return result
