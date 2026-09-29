"""Baseline DS definitions for tables, charts, and diagrams when deck has no samples."""

from __future__ import annotations

from typing import Any

from .baseline_shell import attach_baseline_previews, CIRCULAR_LEGEND_BAND_RATIO
from .chart_palette import (
    resolve_chart_palette_for_baselines,
    extract_design_system_chart_colors,
    extract_design_system_text_colors,
)
from .circular_chart_inference import (
    DEFAULT_DOUGHNUT_HOLE_SIZE,
    apply_circular_profiles_to_chart_baselines,
    apply_circular_style_to_chart_baselines,
)
from .diagram_region_inference import apply_flow_diagram_styles_to_baselines

BASELINE_CHART_TYPES = ("line", "area", "bar", "pie", "doughnut")
BASELINE_DIAGRAM_TYPES = ("flow", "process")

_DEMO_CATEGORIES = ["Q1", "Q2", "Q3", "Q4"]
_DEMO_DONUT_CATEGORIES = ["A", "B", "C", "D"]
_DEMO_DONUT_VALUES = [42, 32, 22, 12]
_DEMO_DONUT_SERIES = [{"name": "Share", "values_preview": _DEMO_DONUT_VALUES}]
_DEMO_SERIES = [
    {"name": "Series A", "values_preview": [12, 19, 8, 15]},
    {"name": "Series B", "values_preview": [8, 14, 11, 9]},
]
_DEMO_PALETTE = ["#0077FF", "#00A86B", "#FF6B35", "#7B61FF", "#FFB020"]


def enrich_graphic_components_with_baselines(
    catalog: dict[str, Any],
    slides: dict[str, Any] | None = None,
    shell_templates: list[dict[str, Any]] | None = None,
    chart_series_palette: dict[str, Any] | None = None,
    design_system_palette: list[str] | None = None,
    design_system_text_colors: list[str] | None = None,
    spatial: dict[str, Any] | None = None,
    content_margins: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append missing baseline component definitions for DS rendering fallbacks."""
    catalog = dict(catalog or {})
    catalog["tables"] = list(catalog.get("tables") or [])
    catalog["charts"] = list(catalog.get("charts") or [])
    catalog["diagrams"] = list(catalog.get("diagrams") or [])

    catalog["tables"].extend(_missing_table_baselines(catalog["tables"]))
    deck_palette = resolve_chart_palette_for_baselines(
        chart_series_palette,
        design_system_palette,
        _DEMO_PALETTE,
        reserved_text_colors=design_system_text_colors,
    )
    deck_fill_variants = list((chart_series_palette or {}).get("fill_variants") or [])
    if not deck_fill_variants:
        deck_fill_variants = [{"kind": "solid", "color": color} for color in deck_palette[:5]]
    chart_style_profile = _chart_style_profile(slides)
    radius_profiles = (slides or {}).get("summary", {}).get("rectangle_radius_profiles") or {}
    rectangle_radius_profile = (slides or {}).get("summary", {}).get("rectangle_radius_profile") or {}
    bar_radius_profile = radius_profiles.get("bar_chart") or {}
    diagram_radius_profile = radius_profiles.get("diagram") or {}
    if bar_radius_profile.get("sample_count"):
        chart_style_profile["series_geometry"] = bar_radius_profile
    elif rectangle_radius_profile.get("sample_count") and not chart_style_profile.get("series_geometry"):
        chart_style_profile["series_geometry"] = rectangle_radius_profile
    catalog["charts"].extend(_missing_chart_baselines(
        catalog["charts"],
        deck_palette,
        deck_fill_variants,
        chart_style_profile,
    ))
    catalog["diagrams"].extend(_missing_diagram_baselines(catalog["diagrams"]))

    size_profiles = (slides or {}).get("summary", {}).get("circular_chart_size_profiles") or []
    apply_circular_profiles_to_chart_baselines(catalog, size_profiles)
    apply_circular_style_to_chart_baselines(catalog, slides)
    apply_flow_diagram_styles_to_baselines(catalog, slides)
    _apply_rectangle_radius_fallback_to_diagrams(
        catalog,
        diagram_radius_profile if diagram_radius_profile.get("sample_count") else rectangle_radius_profile,
    )

    summary = dict(catalog.get("summary") or {})
    summary["table_component_count"] = len(catalog["tables"])
    summary["chart_component_count"] = len(catalog["charts"])
    summary["diagram_component_count"] = len(catalog["diagrams"])
    summary["baseline_table_count"] = sum(1 for item in catalog["tables"] if item.get("is_baseline"))
    summary["baseline_chart_count"] = sum(1 for item in catalog["charts"] if item.get("is_baseline"))
    summary["baseline_diagram_count"] = sum(1 for item in catalog["diagrams"] if item.get("is_baseline"))
    catalog["summary"] = summary
    catalog["groups"] = {
        "tables": {"label": "Таблицы", "component_ids": [item["component_id"] for item in catalog["tables"]]},
        "charts": {"label": "Графики", "component_ids": [item["component_id"] for item in catalog["charts"]]},
        "diagrams": {"label": "Диаграммы", "component_ids": [item["component_id"] for item in catalog["diagrams"]]},
    }
    return attach_baseline_previews(
        catalog,
        slides,
        shell_templates,
        spatial=spatial,
        content_margins=content_margins,
    )


def _existing_signatures(items: list[dict[str, Any]]) -> set[str]:
    return {str(item.get("variant_signature") or item.get("component_id") or "") for item in items}


def _missing_table_baselines(tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    signatures = _existing_signatures(tables)
    baselines: list[dict[str, Any]] = []
    specs = (
        ("tbl_baseline_native", "table|native|baseline", "native", "DsTable"),
        ("tbl_baseline_inferred", "table|inferred_grid|baseline", "inferred_grid", "DsTable"),
    )
    for component_id, signature, source, ds_component in specs:
        if signature in signatures:
            continue
        baselines.append({
            "component_id": component_id,
            "kind": "table",
            "slot_role": "table",
            "variant_signature": signature,
            "is_baseline": True,
            "table_source": source,
            "ds_binding": {
                "component": ds_component,
                "props_from": ["structure", "style_tokens", "column_widths_pt", "row_heights_pt"],
                "content_from": ["data_preview", "cell_text"],
            },
            "structure": {"header_row": 0, "merged_cells": [], "row_sizing": {"mode": "fit_content"}},
            "style_tokens": {
                "header_cell": {"typography": {"bold": True, "size_pt": 10.0}},
                "body_cell": {"typography": {"size_pt": 9.0}},
            },
            "table_style_id": None,
            "column_widths_pt": [80.0, 80.0, 80.0],
            "default_size": {"rows": 3, "cols": 3},
            "data_preview": {
                "rows": [
                    ["Header A", "Header B", "Header C"],
                    ["Value", "Value", "Value"],
                    ["Value", "Value", "Value"],
                ],
            },
            "frequency": {"instance_count": 0, "slide_numbers": [], "template_ids": []},
            "instances": [],
        })
    return baselines


def _missing_chart_baselines(
    charts: list[dict[str, Any]],
    deck_palette: list[str],
    deck_fill_variants: list[dict[str, Any]] | None = None,
    chart_style_profile: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    present_types = {
        str(item.get("chart_type") or "").lower()
        for item in charts
        if not item.get("is_baseline")
    }
    baselines: list[dict[str, Any]] = []
    for chart_type in BASELINE_CHART_TYPES:
        if chart_type in present_types:
            continue
        signature = f"chart|{chart_type}|baseline|ds"
        is_circular = chart_type in {"pie", "doughnut"}
        profile = chart_style_profile or {}
        category_axis = profile.get("category_axis") or {"visible": True, "typography": {}}
        value_axis = profile.get("value_axis") or {"visible": True, "typography": {}}
        axis_line = profile.get("axis_line") or {"visible": False}
        grid_line = profile.get("grid_line") or {
            "visible": False,
            "horizontal_visible": False,
            "vertical_visible": False,
        }
        baselines.append({
            "component_id": f"cht_baseline_{chart_type}",
            "kind": "chart",
            "slot_role": "chart",
            "variant_signature": signature,
            "is_baseline": True,
            "chart_type": chart_type,
            "subtype": _baseline_chart_subtype(chart_type),
            "ds_binding": {
                "component": "DsChart",
                "props_from": ["chart_type", "subtype", "style_tokens"],
                "content_from": ["series_preview", "categories_preview", "center_metric_preview"],
            },
            "style_tokens": {
                "series_palette": [{"color": color} for color in deck_palette],
                "series_fill_variants": list(deck_fill_variants or [])[:6],
                "series_geometry": profile.get("series_geometry") or {},
                "plot_area_fill": None,
                "category_axis": category_axis,
                "value_axis": value_axis,
                "axis_line": axis_line,
                "grid_line": grid_line,
                "legend": {"visible": True, "position": "below", "typography": {}},
                "axis_label": profile.get("axis_label") or {"typography": {}},
                "circular_layout": {
                    "preserve_aspect": True,
                    "legend_band_ratio": CIRCULAR_LEGEND_BAND_RATIO,
                    "center_metric": {"enabled": chart_type == "doughnut"},
                },
            },
            "series_palette": deck_palette,
            "series_preview": _DEMO_DONUT_SERIES if is_circular else _DEMO_SERIES,
            "categories_preview": _DEMO_DONUT_CATEGORIES if is_circular else _DEMO_CATEGORIES,
            "center_metric_preview": {"value": "42", "unit": "%"} if chart_type == "doughnut" else None,
            "frequency": {"instance_count": 0, "slide_numbers": [], "template_ids": []},
            "instances": [],
        })
    return baselines


def _chart_style_profile(slides: dict[str, Any] | None) -> dict[str, Any]:
    candidates = []
    for slide in (slides or {}).get("slides") or []:
        inferred = slide.get("inferred_chart") or {}
        style = inferred.get("style_tokens") or {}
        if not style or float(inferred.get("confidence") or 0) < 0.62:
            continue
        grid = style.get("grid_line") or {}
        signals = inferred.get("signals") or {}
        candidates.append((
            int(grid.get("horizontal_count") or 0) + int(grid.get("vertical_count") or 0),
            int(signals.get("x_axis_label_count") or 0) + int(signals.get("y_axis_label_count") or 0),
            float(inferred.get("confidence") or 0),
            slide.get("slide_number"),
            inferred.get("source"),
            style,
        ))
    if not candidates:
        return {}
    candidates.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    best = candidates[0]
    return {
        **best[5],
        "inference": {
            "source": "pseudo_chart",
            "slide_number": best[3],
            "detector": best[4],
            "confidence": best[2],
        },
    }


def _baseline_chart_subtype(chart_type: str) -> dict[str, Any]:
    if chart_type == "bar":
        return {"direction": "col", "grouping": "clustered"}
    if chart_type in {"pie", "doughnut"}:
        return {"hole_size": DEFAULT_DOUGHNUT_HOLE_SIZE if chart_type == "doughnut" else 0}
    return {}


def _missing_diagram_baselines(diagrams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    present_types = {
        str(item.get("diagram_type") or "").lower()
        for item in diagrams
        if not item.get("is_baseline")
    }
    baselines: list[dict[str, Any]] = []
    for diagram_type in BASELINE_DIAGRAM_TYPES:
        if diagram_type in present_types:
            continue
        signature = f"diagram|{diagram_type}|baseline|ds"
        baselines.append({
            "component_id": f"dgm_baseline_{diagram_type}",
            "kind": "diagram",
            "slot_role": "diagram",
            "variant_signature": signature,
            "is_baseline": True,
            "diagram_type": diagram_type,
            "layout_id": diagram_type,
            "node_count": 3,
            "preview_texts": ["Шаг 1", "Шаг 2", "Шаг 3"],
            "style_tokens": {
                "connector": {"width_pt": 1},
                "node": {"fill": None, "border": None, "typography": {}},
                "arrow": {"head_type": "none", "tail_type": "triangle"},
            },
            "ds_binding": {
                "component": "DsDiagram",
                "props_from": ["diagram_type", "layout_id"],
                "content_from": ["preview_texts"],
            },
            "frequency": {"instance_count": 0, "slide_numbers": [], "template_ids": []},
            "instances": [],
        })
    return baselines


def _apply_rectangle_radius_fallback_to_diagrams(
    catalog: dict[str, Any],
    profile: dict[str, Any],
) -> None:
    if not profile.get("sample_count"):
        return
    for diagram in catalog.get("diagrams") or []:
        if not diagram.get("is_baseline"):
            continue
        tokens = dict(diagram.get("style_tokens") or {})
        node = dict(tokens.get("node") or {})
        if node.get("radius_pt") is None:
            node["radius_pt"] = profile.get("corner_radius_pt") or 0
            node["radius_ratio"] = profile.get("corner_radius_ratio") or 0
            node["radius_source"] = profile.get("source")
        tokens["node"] = node
        diagram["style_tokens"] = tokens
