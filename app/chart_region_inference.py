"""Detect pseudo-chart layouts built from shapes and axis labels (not native c:chart)."""

from __future__ import annotations

import re
from collections import Counter
from statistics import median
from typing import Any

from .chart_palette import (
    collect_series_colors_from_elements,
    collect_series_fill_variants_from_elements,
    is_neutral_chart_color,
    normalize_chart_color,
    normalize_chart_fill,
    palette_colors_from_fill_variants,
)

TITLE_ZONE_MAX_Y = 0.22
PLOT_TOP_MIN_Y = 0.18
X_AXIS_BAND_MIN_Y = 0.62
Y_AXIS_BAND_MAX_X = 0.20
Y_AXIS_BAND_MAX_Y = 0.80
LEGEND_MAX_SIZE_PT = 18.0
LEGEND_MIN_COUNT = 3
MIN_X_AXIS_LABELS = 3
MIN_Y_AXIS_LABELS = 2
MIN_PLOT_MARKS = 3
MIN_PLOT_WIDTH_NORM = 0.30
MIN_PLOT_HEIGHT_NORM = 0.18
MIN_CONFIDENCE = 0.62
MAX_AXIS_LABEL_LEN = 24
GENERIC_AXIS_LABELS = frozenset({
    "текстовый блок",
    "text block",
    "подпись",
    "label",
    "заголовок",
    "описание",
})
PLOT_MARK_KINDS = frozenset({"fill", "shape", "line", "image"})
TABLE_GRID_MIN_ROWS = 2
TABLE_GRID_MIN_COLS = 2
TABLE_GRID_MIN_CELLS = 6
TABLE_GRID_FILL_RATIO = 0.70
TABLE_ROW_TOL_PT = 6.0
TABLE_COL_TOL_PT = 8.0
LABELED_LEGEND_MIN_PAIRS = 2
LABELED_LEGEND_MAX_LABEL_LEN = 16
LABELED_LEGEND_SWATCH_MAX_PT = 22.0
LABELED_LEGEND_SWATCH_MIN_PT = 4.0
LABELED_LEGEND_TEXT_GAP_MAX_NORM = 0.05
LABELED_LEGEND_ROW_TOL_NORM = 0.035
LABELED_LEGEND_COLUMN_TOL_NORM = 0.04
LABELED_LEGEND_MIN_CONFIDENCE = 0.68
LABELED_LEGEND_IMAGE_MIN_WIDTH_NORM = 0.28
LABELED_LEGEND_IMAGE_MIN_HEIGHT_NORM = 0.22
MIN_VERTICAL_BARS = 5
MIN_VERTICAL_BARS_WITHOUT_AXIS = 6
MIN_BAR_WIDTH_NORM = 0.025
MIN_BAR_HEIGHT_NORM = 0.10
MIN_BAR_HEIGHT_UNIQUE = 3
MIN_BAR_HEIGHT_RANGE_NORM = 0.04
VERTICAL_BAR_MIN_CONFIDENCE = 0.64
VERTICAL_BAR_X_ALIGN_TOL_NORM = 0.07
VERTICAL_BAR_X_CLUSTER_TOL_NORM = 0.05
VERTICAL_BAR_MIN_ASPECT = 1.4

_MONTH_RE = re.compile(
    r"^(янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек|"
    r"jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?$",
    re.IGNORECASE,
)


def apply_chart_region_inference(slides_catalog: dict | None, slide_size: tuple[float, float] | None) -> None:
    if not slides_catalog or not slide_size:
        return

    slide_width, slide_height = slide_size
    inferred = 0
    for slide in slides_catalog.get("slides") or []:
        result = infer_chart_region_on_slide(slide, slide_width, slide_height)
        if result:
            slide["inferred_chart"] = result
            inferred += 1
        elif "inferred_chart" in slide:
            del slide["inferred_chart"]

    summary = slides_catalog.setdefault("summary", {})
    summary["inferred_chart_slides"] = inferred


def infer_chart_region_on_slide(
    slide: dict[str, Any],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    elements = slide.get("content_elements") or []
    if any(element.get("kind") in {"table", "chart", "diagram"} for element in elements):
        return None

    result = _infer_shape_layout_chart(elements, slide_width, slide_height)
    if result:
        return result
    result = _infer_vertical_bar_chart(elements, slide_width, slide_height)
    if result:
        return result
    return _infer_labeled_legend_chart(slide, elements, slide_width, slide_height)


def _infer_shape_layout_chart(
    elements: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    texts = [element for element in elements if element.get("kind") == "text" and _text_value(element)]
    marks = [element for element in elements if element.get("kind") in PLOT_MARK_KINDS]

    if len(marks) < MIN_PLOT_MARKS:
        return None

    x_axis = _axis_band(texts, axis="x", slide_width=slide_width, slide_height=slide_height)
    y_axis = _axis_band(texts, axis="y", slide_width=slide_width, slide_height=slide_height)
    if not x_axis or len(x_axis["labels"]) < MIN_X_AXIS_LABELS:
        return None
    if y_axis and len(y_axis["labels"]) < MIN_Y_AXIS_LABELS:
        y_axis = None

    plot_region = _plot_region_norm(x_axis, y_axis, slide_width, slide_height)
    if plot_region["width"] < MIN_PLOT_WIDTH_NORM or plot_region["height"] < MIN_PLOT_HEIGHT_NORM:
        return None

    plot_marks = _plot_mark_candidates(marks, plot_region, slide_width, slide_height, texts)
    if len(plot_marks) < MIN_PLOT_MARKS:
        return None

    if _looks_like_text_table(texts, plot_region, slide_width, slide_height):
        return None

    legend = _legend_band(marks, plot_region, slide_width, slide_height, x_axis, y_axis)
    chart_type = _guess_chart_type(plot_marks, x_axis, y_axis)
    confidence = _confidence_score(plot_marks, x_axis, y_axis, legend, plot_region, chart_type)
    if confidence < MIN_CONFIDENCE:
        return None

    consumed_ids = {element["element_id"] for element in plot_marks}
    if x_axis:
        consumed_ids.update(label["element_id"] for label in x_axis["labels"])
    if y_axis:
        consumed_ids.update(label["element_id"] for label in y_axis["labels"])
    if legend:
        consumed_ids.update(item["element_id"] for item in legend["items"])

    series_palette = collect_series_colors_from_elements(plot_marks)
    return {
        "source": "shape_layout",
        "confidence": round(confidence, 3),
        "chart_type_guess": chart_type,
        "plot_region_norm": plot_region,
        "x_axis": _serialize_axis(x_axis),
        "y_axis": _serialize_axis(y_axis),
        "legend": legend,
        "series_palette": series_palette,
        "style_tokens": _infer_chart_style_tokens(
            elements, x_axis, y_axis, plot_region, slide_width, slide_height,
        ),
        "signals": {
            "plot_mark_count": len(plot_marks),
            "x_axis_label_count": len(x_axis["labels"]) if x_axis else 0,
            "y_axis_label_count": len(y_axis["labels"]) if y_axis else 0,
            "legend_mark_count": len(legend["items"]) if legend else 0,
            "legend_pair_count": 0,
            "plot_image_count": 0,
            "plot_width_norm": round(plot_region["width"], 3),
            "plot_height_norm": round(plot_region["height"], 3),
        },
        "categories_preview": [label["text"] for label in (x_axis or {}).get("labels", [])],
        "plot_mark_element_ids": sorted(element["element_id"] for element in plot_marks if element.get("element_id")),
        "series_preview": [
            {"name": label["text"], "values_preview": []}
            for label in (y_axis or {}).get("labels", [])
        ],
        "consumed_element_ids": sorted(consumed_ids),
    }


def _infer_vertical_bar_chart(
    elements: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    texts = [element for element in elements if element.get("kind") == "text" and _text_value(element)]
    marks = [element for element in elements if element.get("kind") in PLOT_MARK_KINDS]
    if len(marks) < MIN_VERTICAL_BARS:
        return None

    x_axis = _axis_band(texts, axis="x", slide_width=slide_width, slide_height=slide_height)
    plot_region = (
        _plot_region_norm(x_axis, None, slide_width, slide_height)
        if x_axis
        else None
    )

    bars = _vertical_bar_candidates(
        marks,
        plot_region,
        slide_width,
        slide_height,
        texts,
        x_axis,
    )
    if len(bars) < MIN_VERTICAL_BARS:
        return None
    if not _vertical_bars_have_height_variety(bars):
        return None

    if x_axis:
        if len(x_axis["labels"]) < MIN_X_AXIS_LABELS:
            return None
        if not _vertical_bars_align_with_axis(bars, x_axis):
            return None
        if _looks_like_text_table(texts, plot_region, slide_width, slide_height):
            return None
    else:
        if len(bars) < MIN_VERTICAL_BARS_WITHOUT_AXIS:
            return None
        bar_centers = sorted(_bar_center_x(bar, slide_width, slide_height) for bar in bars)
        if not _labels_evenly_spaced(bar_centers, tolerance=0.45):
            return None
        plot_region = _plot_region_from_vertical_bars(bars, slide_width, slide_height)

    if not plot_region or plot_region["width"] < MIN_PLOT_WIDTH_NORM or plot_region["height"] < MIN_PLOT_HEIGHT_NORM:
        return None

    legend_marks = [element for element in elements if element.get("kind") in {"fill", "shape"}]
    legend_pairs = _labeled_legend_pairs(texts, legend_marks, slide_width, slide_height)
    legend = _serialize_labeled_legend(legend_pairs) if legend_pairs else None

    series_fill_variants = collect_series_fill_variants_from_elements(bars)
    if not series_fill_variants and legend_pairs:
        series_fill_variants = [
            normalized
            for normalized in (
                normalize_chart_fill({"kind": "solid", "color": pair["color"]})
                for pair in legend_pairs
            )
            if normalized
        ]

    series_palette = palette_colors_from_fill_variants(series_fill_variants)
    if not series_palette:
        series_palette = collect_series_colors_from_elements(bars)
    if legend_pairs:
        for pair in legend_pairs:
            color = normalize_chart_color(pair.get("color"))
            if color and color not in series_palette:
                series_palette.append(color)

    confidence = _vertical_bar_confidence(bars, x_axis, legend_pairs, plot_region)
    if confidence < VERTICAL_BAR_MIN_CONFIDENCE:
        return None

    consumed_ids = {element["element_id"] for element in bars}
    if x_axis:
        consumed_ids.update(label["element_id"] for label in x_axis["labels"])
    if legend_pairs:
        consumed_ids.update(pair["swatch_element_id"] for pair in legend_pairs)
        consumed_ids.update(pair["label_element_id"] for pair in legend_pairs)

    return {
        "source": "vertical_bar_cluster",
        "confidence": round(confidence, 3),
        "chart_type_guess": "bar",
        "subtype": {"direction": "col", "grouping": "clustered"},
        "plot_region_norm": plot_region,
        "x_axis": _serialize_axis(x_axis),
        "y_axis": None,
        "legend": legend,
        "series_palette": series_palette,
        "series_fill_variants": series_fill_variants,
        "style_tokens": _infer_chart_style_tokens(
            elements, x_axis, None, plot_region, slide_width, slide_height,
        ),
        "signals": {
            "plot_mark_count": len(bars),
            "x_axis_label_count": len(x_axis["labels"]) if x_axis else 0,
            "y_axis_label_count": 0,
            "legend_mark_count": len(legend_pairs),
            "legend_pair_count": len(legend_pairs),
            "plot_image_count": sum(1 for bar in bars if bar.get("kind") == "image"),
            "plot_width_norm": round(plot_region["width"], 3),
            "plot_height_norm": round(plot_region["height"], 3),
            "vertical_bar_count": len(bars),
            "bar_fill_variant_count": len(series_fill_variants),
        },
        "categories_preview": [label["text"] for label in (x_axis or {}).get("labels", [])],
        "bar_element_ids": sorted(element["element_id"] for element in bars if element.get("element_id")),
        "series_preview": [
            {
                "name": pair["text"],
                "values_preview": [],
                "colors_preview": [pair["color"]],
            }
            for pair in (legend_pairs or [])
        ] or [{"name": "Series 1", "values_preview": []}],
        "consumed_element_ids": sorted(consumed_ids),
    }


def _serialize_labeled_legend(pairs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "kind": "labeled_pairs",
        "layout": _legend_group_layout(pairs) or "row",
        "labeled_pairs": [
            {
                "element_id": pair["swatch_element_id"],
                "label_element_id": pair["label_element_id"],
                "text": pair["text"],
                "color": pair["color"],
            }
            for pair in pairs
        ],
    }


def _infer_labeled_legend_chart(
    slide: dict[str, Any],
    elements: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    if slide.get("inferred_table"):
        return None

    texts = [element for element in elements if element.get("kind") == "text" and _text_value(element)]
    marks = [element for element in elements if element.get("kind") in {"fill", "shape"}]
    images = [element for element in elements if element.get("kind") == "image"]

    pairs = _labeled_legend_pairs(texts, marks, slide_width, slide_height)
    if len(pairs) < LABELED_LEGEND_MIN_PAIRS:
        return None

    plot_images = _chart_plot_images(images, pairs, slide_width, slide_height)
    plot_region = _plot_region_from_legend_image(pairs, plot_images, slide_width, slide_height)
    if plot_region["width"] < MIN_PLOT_WIDTH_NORM or plot_region["height"] < MIN_PLOT_HEIGHT_NORM:
        return None

    if _looks_like_text_table(texts, plot_region, slide_width, slide_height):
        return None

    confidence = _labeled_legend_confidence(pairs, plot_images, plot_region)
    if confidence < LABELED_LEGEND_MIN_CONFIDENCE:
        return None

    series_palette = [pair["color"] for pair in pairs]
    legend = {
        "kind": "labeled_pairs",
        "labeled_pairs": [
            {
                "element_id": pair["swatch_element_id"],
                "label_element_id": pair["label_element_id"],
                "text": pair["text"],
                "color": pair["color"],
            }
            for pair in pairs
        ],
    }
    consumed_ids = {
        pair["swatch_element_id"]
        for pair in pairs
    } | {
        pair["label_element_id"]
        for pair in pairs
    } | {
        image.get("element_id")
        for image in plot_images
        if image.get("element_id")
    }

    return {
        "source": "labeled_legend_image" if plot_images else "labeled_legend",
        "confidence": round(confidence, 3),
        "chart_type_guess": "line",
        "plot_region_norm": plot_region,
        "x_axis": None,
        "y_axis": None,
        "legend": legend,
        "series_palette": series_palette,
        "style_tokens": _infer_chart_style_tokens(
            elements, None, None, plot_region, slide_width, slide_height,
        ),
        "signals": {
            "plot_mark_count": 0,
            "x_axis_label_count": 0,
            "y_axis_label_count": 0,
            "legend_mark_count": len(pairs),
            "legend_pair_count": len(pairs),
            "plot_image_count": len(plot_images),
            "plot_width_norm": round(plot_region["width"], 3),
            "plot_height_norm": round(plot_region["height"], 3),
        },
        "categories_preview": [],
        "series_preview": [
            {"name": pair["text"], "values_preview": [], "colors_preview": [pair["color"]]}
            for pair in pairs
        ],
        "consumed_element_ids": sorted(consumed_ids),
    }


def _text_value(element: dict[str, Any]) -> str:
    return str(element.get("text") or "").strip()


def _axis_label_text(text: str) -> bool:
    if not text or len(text) > MAX_AXIS_LABEL_LEN:
        return False
    if text.count("\n") > 0:
        return False
    normalized = text.strip().lower()
    if normalized in GENERIC_AXIS_LABELS:
        return False
    return True


def _axis_band(
    texts: list[dict[str, Any]],
    *,
    axis: str,
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []
    for element in texts:
        text = _text_value(element)
        if not _axis_label_text(text):
            continue
        geometry = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
        y = float(geometry.get("y") or 0)
        x = float(geometry.get("x") or 0)
        if y < TITLE_ZONE_MAX_Y:
            continue
        if axis == "x":
            if y < X_AXIS_BAND_MIN_Y:
                continue
        else:
            if x > Y_AXIS_BAND_MAX_X:
                continue
            if y >= Y_AXIS_BAND_MAX_Y:
                continue
        candidates.append({
            "element_id": element.get("element_id"),
            "text": text,
            "geometry_norm": geometry,
            "geometry_pt": element.get("geometry_pt") or {},
            "typography": element.get("typography") or {},
        })

    if axis == "x" and len(candidates) < MIN_X_AXIS_LABELS:
        return None
    if axis == "y" and len(candidates) < MIN_Y_AXIS_LABELS:
        return None

    if axis == "x":
        candidates = _select_axis_cluster(candidates, axis="x")
        if not candidates or len(candidates) < MIN_X_AXIS_LABELS:
            return None
    else:
        candidates = _select_axis_cluster(candidates, axis="y")
        if not candidates or len(candidates) < MIN_Y_AXIS_LABELS:
            return None
        unique_texts = {item["text"].strip().lower() for item in candidates}
        if len(unique_texts) < MIN_Y_AXIS_LABELS and len(candidates) < 4:
            return None

    if axis == "x":
        candidates.sort(key=lambda item: item["geometry_norm"].get("x", 0))
        band_y = median([item["geometry_norm"]["y"] for item in candidates])
        if not _labels_evenly_spaced([item["geometry_norm"]["x"] for item in candidates]):
            return None
    else:
        candidates.sort(key=lambda item: item["geometry_norm"].get("y", 0))
        band_y = median([item["geometry_norm"]["y"] for item in candidates])
        if not _labels_evenly_spaced([item["geometry_norm"]["y"] for item in candidates]):
            return None

    return {
        "axis": axis,
        "band_center_norm": band_y if axis == "y" else median([item["geometry_norm"]["x"] for item in candidates]),
        "labels": candidates,
    }


def _select_axis_cluster(
    candidates: list[dict[str, Any]],
    *,
    axis: str,
) -> list[dict[str, Any]]:
    if not candidates:
        return []
    coord_key = "y" if axis == "x" else "x"
    tolerance = 0.04 if axis == "x" else 0.05
    min_labels = MIN_X_AXIS_LABELS if axis == "x" else MIN_Y_AXIS_LABELS
    clusters: list[list[dict[str, Any]]] = []
    for item in candidates:
        value = float(item["geometry_norm"].get(coord_key) or 0)
        placed = False
        for cluster in clusters:
            center = median([entry["geometry_norm"][coord_key] for entry in cluster])
            if abs(value - center) <= tolerance:
                cluster.append(item)
                placed = True
                break
        if not placed:
            clusters.append([item])
    if not clusters:
        return []
    if axis == "x":
        clusters.sort(
            key=lambda cluster: median([item["geometry_norm"]["y"] for item in cluster]),
            reverse=True,
        )
    else:
        clusters.sort(key=lambda cluster: median([item["geometry_norm"]["x"] for item in cluster]))
    for cluster in clusters:
        if len(cluster) >= min_labels:
            return cluster
    return []


def _labels_evenly_spaced(values: list[float], *, tolerance: float = 0.35) -> bool:
    if len(values) < 2:
        return True
    gaps = [values[index + 1] - values[index] for index in range(len(values) - 1)]
    gaps = [gap for gap in gaps if gap > 0.008]
    if len(gaps) < max(1, len(values) - 2):
        return False
    med = median(gaps)
    if med <= 0:
        return False
    irregular = sum(1 for gap in gaps if abs(gap - med) / med > tolerance)
    return irregular <= max(1, len(gaps) // 3)


def _plot_region_norm(
    x_axis: dict[str, Any] | None,
    y_axis: dict[str, Any] | None,
    slide_width: float,
    slide_height: float,
) -> dict[str, float]:
    x = Y_AXIS_BAND_MAX_X
    y = PLOT_TOP_MIN_Y
    right = 0.94
    bottom = X_AXIS_BAND_MIN_Y - 0.03

    if x_axis:
        labels = x_axis["labels"]
        x = min(x, min(item["geometry_norm"]["x"] for item in labels) - 0.02)
        right = max(right, max(item["geometry_norm"]["x"] + item["geometry_norm"].get("width", 0.04) for item in labels) + 0.02)
        bottom = min(bottom, min(item["geometry_norm"]["y"] for item in labels) - 0.02)

    if y_axis:
        labels = y_axis["labels"]
        x = max(x, max(item["geometry_norm"]["x"] + item["geometry_norm"].get("width", 0.08) for item in labels) + 0.02)
        y = min(y, min(item["geometry_norm"]["y"] for item in labels) - 0.01)
        bottom = max(bottom, max(item["geometry_norm"]["y"] + item["geometry_norm"].get("height", 0.04) for item in labels) + 0.01)

    return {
        "x": round(max(0.0, x), 4),
        "y": round(max(TITLE_ZONE_MAX_Y, y), 4),
        "width": round(max(0.08, right - x), 4),
        "height": round(max(0.08, bottom - y), 4),
    }


def _plot_mark_candidates(
    marks: list[dict[str, Any]],
    plot_region: dict[str, float],
    slide_width: float,
    slide_height: float,
    texts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    plot_marks: list[dict[str, Any]] = []
    for element in marks:
        geometry = element.get("geometry_pt") or {}
        width_pt = float(geometry.get("width_pt") or 0)
        height_pt = float(geometry.get("height_pt") or 0)
        if width_pt <= 0 or height_pt <= 0:
            continue
        if max(width_pt, height_pt) <= LEGEND_MAX_SIZE_PT and min(width_pt, height_pt) >= max(width_pt, height_pt) * 0.65:
            continue
        norm = element.get("geometry_norm") or _norm_from_pt(geometry, slide_width, slide_height)
        if not _intersects_region(norm, plot_region, margin=0.01):
            continue
        if _shape_has_center_label(element, texts, slide_width, slide_height):
            continue
        aspect = width_pt / max(height_pt, 0.01)
        if aspect < 1.4 and element.get("kind") != "line":
            continue
        plot_marks.append(element)
    return plot_marks


def _vertical_bar_candidates(
    marks: list[dict[str, Any]],
    plot_region: dict[str, float] | None,
    slide_width: float,
    slide_height: float,
    texts: list[dict[str, Any]],
    x_axis: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    axis_band_y = None
    if x_axis:
        axis_band_y = median([item["geometry_norm"]["y"] for item in x_axis["labels"]])

    for element in marks:
        geometry = element.get("geometry_pt") or {}
        width_pt = float(geometry.get("width_pt") or 0)
        height_pt = float(geometry.get("height_pt") or 0)
        if width_pt <= 0 or height_pt <= 0:
            continue
        if height_pt / max(width_pt, 0.01) < VERTICAL_BAR_MIN_ASPECT:
            continue
        if max(width_pt, height_pt) <= LEGEND_MAX_SIZE_PT and min(width_pt, height_pt) >= max(width_pt, height_pt) * 0.65:
            continue

        norm = element.get("geometry_norm") or _norm_from_pt(geometry, slide_width, slide_height)
        if float(norm.get("width") or 0) < MIN_BAR_WIDTH_NORM:
            continue
        if float(norm.get("height") or 0) < MIN_BAR_HEIGHT_NORM:
            continue
        if plot_region and not _intersects_region(norm, plot_region, margin=0.03):
            continue
        if axis_band_y is not None and float(norm.get("y") or 0) + float(norm.get("height") or 0) > axis_band_y + 0.02:
            continue
        if _shape_has_center_label(element, texts, slide_width, slide_height):
            continue
        bars.append(element)

    return bars


def _bar_center_x(element: dict[str, Any], slide_width: float, slide_height: float) -> float:
    norm = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
    return float(norm.get("x") or 0) + float(norm.get("width") or 0) / 2


def _vertical_bars_have_height_variety(bars: list[dict[str, Any]]) -> bool:
    heights = [
        round(float((bar.get("geometry_norm") or {}).get("height") or 0), 3)
        for bar in bars
    ]
    if len(set(heights)) >= MIN_BAR_HEIGHT_UNIQUE:
        return True
    if not heights:
        return False
    return max(heights) - min(heights) >= MIN_BAR_HEIGHT_RANGE_NORM


def _vertical_bars_align_with_axis(
    bars: list[dict[str, Any]],
    x_axis: dict[str, Any],
) -> bool:
    label_centers = [
        float(item["geometry_norm"].get("x") or 0) + float(item["geometry_norm"].get("width") or 0) / 2
        for item in x_axis["labels"]
    ]
    bar_centers = [
        float((bar.get("geometry_norm") or {}).get("x") or 0)
        + float((bar.get("geometry_norm") or {}).get("width") or 0) / 2
        for bar in bars
    ]
    bar_clusters = _cluster_norm_values(bar_centers, VERTICAL_BAR_X_CLUSTER_TOL_NORM)
    if len(bar_clusters) < MIN_X_AXIS_LABELS:
        return False
    if abs(len(bar_clusters) - len(label_centers)) > max(2, len(label_centers) // 2):
        return False

    matched = 0
    for label_center in label_centers:
        if any(abs(cluster_center - label_center) <= VERTICAL_BAR_X_ALIGN_TOL_NORM for cluster_center in bar_clusters):
            matched += 1
    return matched >= min(len(label_centers), MIN_X_AXIS_LABELS)


def _plot_region_from_vertical_bars(
    bars: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> dict[str, float]:
    norms = [
        bar.get("geometry_norm") or _norm_from_pt(bar.get("geometry_pt") or {}, slide_width, slide_height)
        for bar in bars
    ]
    left = min(float(norm.get("x") or 0) for norm in norms)
    top = min(float(norm.get("y") or 0) for norm in norms)
    right = max(float(norm.get("x") or 0) + float(norm.get("width") or 0) for norm in norms)
    bottom = max(float(norm.get("y") or 0) + float(norm.get("height") or 0) for norm in norms)
    return {
        "x": round(max(0.0, left - 0.02), 4),
        "y": round(max(TITLE_ZONE_MAX_Y, top - 0.02), 4),
        "width": round(max(0.08, right - left + 0.04), 4),
        "height": round(max(0.08, bottom - top + 0.04), 4),
    }


def _vertical_bar_confidence(
    bars: list[dict[str, Any]],
    x_axis: dict[str, Any] | None,
    legend_pairs: list[dict[str, Any]],
    plot_region: dict[str, float],
) -> float:
    score = 0.46
    score += min(0.24, len(bars) * 0.011)
    if x_axis:
        score += min(0.16, len(x_axis["labels"]) * 0.012)
    if legend_pairs:
        score += 0.08
    heights = {
        round(float((bar.get("geometry_norm") or {}).get("height") or 0), 3)
        for bar in bars
    }
    if len(heights) >= MIN_BAR_HEIGHT_UNIQUE:
        score += 0.06
    if plot_region["width"] >= 0.45:
        score += 0.05
    if plot_region["height"] >= 0.22:
        score += 0.04
    return min(score, 0.97)


def _shape_has_center_label(
    shape: dict[str, Any],
    texts: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> bool:
    shape_norm = shape.get("geometry_norm") or _norm_from_pt(shape.get("geometry_pt") or {}, slide_width, slide_height)
    cx = shape_norm.get("x", 0) + shape_norm.get("width", 0) / 2
    cy = shape_norm.get("y", 0) + shape_norm.get("height", 0) / 2
    for element in texts:
        text = _text_value(element)
        if not text:
            continue
        norm = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
        tx = norm.get("x", 0) + norm.get("width", 0) / 2
        ty = norm.get("y", 0) + norm.get("height", 0) / 2
        if abs(tx - cx) <= 0.03 and abs(ty - cy) <= 0.03:
            return True
    return False


def _legend_band(
    marks: list[dict[str, Any]],
    plot_region: dict[str, float],
    slide_width: float,
    slide_height: float,
    x_axis: dict[str, Any] | None,
    y_axis: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not x_axis:
        return None
    band_y = median([item["geometry_norm"]["y"] for item in x_axis["labels"]])
    items: list[dict[str, Any]] = []
    for element in marks:
        geometry = element.get("geometry_pt") or {}
        width_pt = float(geometry.get("width_pt") or 0)
        height_pt = float(geometry.get("height_pt") or 0)
        if width_pt <= 0 or max(width_pt, height_pt) > LEGEND_MAX_SIZE_PT:
            continue
        norm = element.get("geometry_norm") or _norm_from_pt(geometry, slide_width, slide_height)
        if abs(norm.get("y", 0) - band_y) > 0.05:
            continue
        if norm.get("x", 0) < plot_region["x"]:
            continue
        items.append({
            "element_id": element.get("element_id"),
            "geometry_norm": norm,
            "fill": element.get("fill"),
        })
    if len(items) < LEGEND_MIN_COUNT:
        return None
    if not _labels_evenly_spaced([item["geometry_norm"]["x"] for item in items], tolerance=0.45):
        return None
    swatch_colors = [
        normalize_chart_color((item.get("fill") or {}).get("color"))
        for item in items
        if isinstance(item.get("fill"), dict)
    ]
    if not _legend_swatch_colors_distinct(swatch_colors):
        return None
    return {"items": items}


def _legend_label_text(text: str) -> bool:
    if not text or len(text) > LABELED_LEGEND_MAX_LABEL_LEN:
        return False
    if text.count("\n") > 0:
        return False
    normalized = text.strip().lower()
    if normalized in GENERIC_AXIS_LABELS:
        return False
    if len(text.strip()) < 1:
        return False
    return True


def _swatch_color(element: dict[str, Any]) -> str | None:
    fill = element.get("fill") or {}
    if isinstance(fill, dict):
        return normalize_chart_color(fill.get("color"))
    return None


def _legend_swatch_colors_distinct(colors: list[str | None], *, min_colors: int = 2) -> bool:
    """Legend swatches in one group must all use different colors."""
    normalized = [
        color
        for color in colors
        if color and not is_neutral_chart_color(color)
    ]
    unique = set(normalized)
    if len(unique) < min_colors:
        return False
    return len(unique) == len(normalized)


def _is_legend_swatch(element: dict[str, Any], slide_width: float, slide_height: float) -> bool:
    geometry = element.get("geometry_pt") or {}
    width_pt = float(geometry.get("width_pt") or 0)
    height_pt = float(geometry.get("height_pt") or 0)
    if width_pt < LABELED_LEGEND_SWATCH_MIN_PT or height_pt < LABELED_LEGEND_SWATCH_MIN_PT:
        return False
    if max(width_pt, height_pt) > LABELED_LEGEND_SWATCH_MAX_PT:
        return False
    aspect = width_pt / max(height_pt, 0.01)
    if aspect < 0.45 or aspect > 2.2:
        return False
    color = _swatch_color(element)
    if not color or is_neutral_chart_color(color):
        return False
    norm = element.get("geometry_norm") or _norm_from_pt(geometry, slide_width, slide_height)
    if float(norm.get("y") or 0) < TITLE_ZONE_MAX_Y:
        return False
    return True


def _labeled_legend_pairs(
    texts: list[dict[str, Any]],
    marks: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> list[dict[str, Any]]:
    swatches = [
        element for element in marks
        if _is_legend_swatch(element, slide_width, slide_height)
    ]
    if len(swatches) < LABELED_LEGEND_MIN_PAIRS:
        return []

    pairs: list[dict[str, Any]] = []
    used_text_ids: set[str] = set()
    for swatch in sorted(swatches, key=lambda element: (
        float((element.get("geometry_norm") or {}).get("y") or 0),
        float((element.get("geometry_norm") or {}).get("x") or 0),
    )):
        swatch_norm = swatch.get("geometry_norm") or _norm_from_pt(swatch.get("geometry_pt") or {}, slide_width, slide_height)
        swatch_right = float(swatch_norm.get("x") or 0) + float(swatch_norm.get("width") or 0)
        swatch_cy = float(swatch_norm.get("y") or 0) + float(swatch_norm.get("height") or 0) / 2
        best_text = None
        best_gap = 999.0
        for text_element in texts:
            element_id = text_element.get("element_id")
            if element_id in used_text_ids:
                continue
            label = _text_value(text_element)
            if not _legend_label_text(label):
                continue
            text_norm = text_element.get("geometry_norm") or _norm_from_pt(
                text_element.get("geometry_pt") or {},
                slide_width,
                slide_height,
            )
            text_left = float(text_norm.get("x") or 0)
            text_cy = float(text_norm.get("y") or 0) + float(text_norm.get("height") or 0) / 2
            gap = text_left - swatch_right
            if gap < -0.008 or gap > LABELED_LEGEND_TEXT_GAP_MAX_NORM:
                continue
            if abs(text_cy - swatch_cy) > LABELED_LEGEND_ROW_TOL_NORM:
                continue
            if gap < best_gap:
                best_gap = gap
                best_text = text_element
        if not best_text:
            continue
        color = _swatch_color(swatch)
        if not color:
            continue
        pairs.append({
            "swatch_element_id": swatch.get("element_id"),
            "label_element_id": best_text.get("element_id"),
            "text": _text_value(best_text),
            "color": color,
            "geometry_norm": swatch_norm,
        })
        used_text_ids.add(best_text.get("element_id"))

    if len(pairs) < LABELED_LEGEND_MIN_PAIRS:
        return []

    if not _legend_swatch_colors_distinct([pair["color"] for pair in pairs]):
        return []

    layout = _legend_group_layout(pairs)
    if not layout:
        return []

    if layout == "column":
        return sorted(pairs, key=lambda pair: float(pair["geometry_norm"].get("y") or 0))
    return sorted(pairs, key=lambda pair: float(pair["geometry_norm"].get("x") or 0))


def _legend_group_layout(pairs: list[dict[str, Any]]) -> str | None:
    xs = [float(pair["geometry_norm"].get("x") or 0) for pair in pairs]
    ys = [float(pair["geometry_norm"].get("y") or 0) for pair in pairs]
    row_y = median(ys)
    col_x = median(xs)
    row_aligned = all(abs(y - row_y) <= LABELED_LEGEND_ROW_TOL_NORM for y in ys)
    column_aligned = all(abs(x - col_x) <= LABELED_LEGEND_COLUMN_TOL_NORM for x in xs)

    if column_aligned and (max(ys) - min(ys)) > LABELED_LEGEND_ROW_TOL_NORM:
        pair_y = sorted(ys)
        if len(pair_y) >= 3 and not _labels_evenly_spaced(pair_y, tolerance=0.55):
            return None
        return "column"

    if row_aligned:
        pair_x = sorted(xs)
        if len(pair_x) >= 3 and not _labels_evenly_spaced(pair_x, tolerance=0.55):
            return None
        return "row"

    if column_aligned:
        pair_y = sorted(ys)
        if len(pair_y) >= 3 and not _labels_evenly_spaced(pair_y, tolerance=0.55):
            return None
        return "column"

    return None


def _legend_bounds_from_pairs(pairs: list[dict[str, Any]]) -> dict[str, float]:
    left = min(float(pair["geometry_norm"].get("x") or 0) for pair in pairs)
    top = min(float(pair["geometry_norm"].get("y") or 0) for pair in pairs)
    right = max(
        float(pair["geometry_norm"].get("x") or 0) + float(pair["geometry_norm"].get("width") or 0)
        for pair in pairs
    )
    bottom = max(
        float(pair["geometry_norm"].get("y") or 0) + float(pair["geometry_norm"].get("height") or 0)
        for pair in pairs
    )
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def _image_relates_to_legend(
    image_norm: dict[str, float],
    legend_bounds: dict[str, float],
) -> bool:
    image_top = float(image_norm.get("y") or 0)
    image_bottom = image_top + float(image_norm.get("height") or 0)
    legend_top = float(legend_bounds.get("y") or 0)
    legend_bottom = legend_top + float(legend_bounds.get("height") or 0)

    legend_below_image = image_bottom <= legend_top + 0.05
    legend_above_image = legend_bottom <= image_top + 0.08
    vertical_overlap = min(image_bottom, legend_bottom) - max(image_top, legend_top)
    beside = vertical_overlap >= min(
        float(image_norm.get("height") or 0),
        float(legend_bounds.get("height") or 0),
    ) * 0.35
    return legend_below_image or legend_above_image or beside


def _chart_plot_images(
    images: list[dict[str, Any]],
    pairs: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> list[dict[str, Any]]:
    if not images:
        return []
    legend_bounds = _legend_bounds_from_pairs(pairs)
    legend_top = float(legend_bounds.get("y") or 0)
    candidates = []
    for image in images:
        norm = image.get("geometry_norm") or _norm_from_pt(image.get("geometry_pt") or {}, slide_width, slide_height)
        width = float(norm.get("width") or 0)
        height = float(norm.get("height") or 0)
        if width < LABELED_LEGEND_IMAGE_MIN_WIDTH_NORM or height < LABELED_LEGEND_IMAGE_MIN_HEIGHT_NORM:
            continue
        if float(norm.get("y") or 0) < TITLE_ZONE_MAX_Y:
            continue
        if not _image_relates_to_legend(norm, legend_bounds):
            continue
        candidates.append(image)
    candidates.sort(
        key=lambda element: (
            -float((element.get("geometry_norm") or {}).get("width") or 0)
            * float((element.get("geometry_norm") or {}).get("height") or 0),
            abs(float((element.get("geometry_norm") or {}).get("y") or 0) - legend_top),
        ),
    )
    return candidates[:1]


def _plot_region_from_legend_image(
    pairs: list[dict[str, Any]],
    plot_images: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> dict[str, float]:
    legend_bounds = _legend_bounds_from_pairs(pairs)
    legend_left = float(legend_bounds.get("x") or 0)
    legend_top = float(legend_bounds.get("y") or 0)
    legend_right = legend_left + float(legend_bounds.get("width") or 0)
    legend_bottom = legend_top + float(legend_bounds.get("height") or 0) + 0.06

    if plot_images:
        norms = [
            image.get("geometry_norm") or _norm_from_pt(image.get("geometry_pt") or {}, slide_width, slide_height)
            for image in plot_images
        ]
        image_left = min(float(norm.get("x") or 0) for norm in norms)
        image_top = min(float(norm.get("y") or 0) for norm in norms)
        image_right = max(float(norm.get("x") or 0) + float(norm.get("width") or 0) for norm in norms)
        image_bottom = max(float(norm.get("y") or 0) + float(norm.get("height") or 0) for norm in norms)
        left = min(legend_left, image_left)
        top = min(legend_top, image_top)
        right = max(legend_right + 0.12, image_right)
        bottom = max(legend_bottom, image_bottom)
        return {
            "x": round(max(0.0, left), 4),
            "y": round(max(TITLE_ZONE_MAX_Y, top), 4),
            "width": round(max(0.08, right - left), 4),
            "height": round(max(0.08, bottom - top), 4),
        }

    return {
        "x": round(Y_AXIS_BAND_MAX_X, 4),
        "y": round(PLOT_TOP_MIN_Y, 4),
        "width": round(max(0.30, legend_left - Y_AXIS_BAND_MAX_X - 0.02), 4),
        "height": round(max(0.18, legend_top - PLOT_TOP_MIN_Y - 0.03), 4),
    }


def _labeled_legend_confidence(
    pairs: list[dict[str, Any]],
    plot_images: list[dict[str, Any]],
    plot_region: dict[str, float],
) -> float:
    score = 0.52
    score += min(0.16, len(pairs) * 0.05)
    if plot_images:
        score += 0.18
    if plot_region["width"] >= 0.45:
        score += 0.06
    if plot_region["height"] >= 0.35:
        score += 0.06
    if len({pair["color"] for pair in pairs}) == len(pairs):
        score += 0.04
    return min(score, 0.96)


def _looks_like_text_table(
    texts: list[dict[str, Any]],
    plot_region: dict[str, float],
    slide_width: float,
    slide_height: float,
) -> bool:
    region_texts = []
    for element in texts:
        norm = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
        if not _intersects_region(norm, plot_region, margin=0.04):
            continue
        if float(norm.get("y") or 0) >= X_AXIS_BAND_MIN_Y:
            continue
        region_texts.append(element)
    if len(region_texts) < TABLE_GRID_MIN_CELLS:
        return False

    row_centers = _cluster_axis_values(
        [float((element.get("geometry_pt") or {}).get("y_pt") or 0) for element in region_texts],
        TABLE_ROW_TOL_PT,
    )
    col_centers = _cluster_axis_values(
        [float((element.get("geometry_pt") or {}).get("x_pt") or 0) for element in region_texts],
        TABLE_COL_TOL_PT,
    )
    if len(row_centers) < TABLE_GRID_MIN_ROWS or len(col_centers) < TABLE_GRID_MIN_COLS:
        return False

    matrix = [[0 for _ in col_centers] for _ in row_centers]
    for element in region_texts:
        geometry = element.get("geometry_pt") or {}
        row = _nearest_index(float(geometry.get("y_pt") or 0), row_centers, TABLE_ROW_TOL_PT)
        col = _nearest_index(float(geometry.get("x_pt") or 0), col_centers, TABLE_COL_TOL_PT)
        if row is None or col is None:
            continue
        matrix[row][col] += 1

    filled = sum(1 for row in matrix for cell in row if cell)
    total = len(row_centers) * len(col_centers)
    if total == 0:
        return False
    return filled / total >= TABLE_GRID_FILL_RATIO and len(col_centers) >= 3 and len(row_centers) >= 3


def _guess_chart_type(
    plot_marks: list[dict[str, Any]],
    x_axis: dict[str, Any] | None,
    y_axis: dict[str, Any] | None,
) -> str:
    horizontal = 0
    vertical = 0
    for element in plot_marks:
        geometry = element.get("geometry_pt") or {}
        width_pt = float(geometry.get("width_pt") or 0)
        height_pt = float(geometry.get("height_pt") or 0)
        if width_pt / max(height_pt, 0.01) >= 2.0:
            horizontal += 1
        elif height_pt / max(width_pt, 0.01) >= 2.0:
            vertical += 1

    if y_axis and horizontal >= max(2, len(plot_marks) // 2):
        x_labels = [label["text"] for label in (x_axis or {}).get("labels", [])]
        if x_labels and sum(1 for label in x_labels if _MONTH_RE.match(label.strip())) >= max(2, len(x_labels) // 2):
            return "gantt"
        return "bar"
    if x_axis and vertical >= max(2, len(plot_marks) // 2):
        return "bar"
    return "bar"


def _confidence_score(
    plot_marks: list[dict[str, Any]],
    x_axis: dict[str, Any] | None,
    y_axis: dict[str, Any] | None,
    legend: dict[str, Any] | None,
    plot_region: dict[str, float],
    chart_type: str,
) -> float:
    score = 0.35
    score += min(0.20, len(plot_marks) * 0.03)
    if x_axis:
        score += min(0.18, len(x_axis["labels"]) * 0.025)
    if y_axis:
        score += min(0.15, len(y_axis["labels"]) * 0.025)
    if x_axis and y_axis:
        score += 0.12
    if legend:
        score += 0.06
    if plot_region["width"] >= 0.55:
        score += 0.08
    if chart_type == "gantt":
        score += 0.04
    return min(score, 0.98)


def _dominant_axis_typography(axis: dict[str, Any] | None) -> dict[str, Any]:
    if not axis:
        return {}
    typographies = [item.get("typography") or {} for item in axis.get("labels") or []]
    typographies = [item for item in typographies if item]
    if not typographies:
        return {}

    def most_common(key: str):
        values = [item.get(key) for item in typographies if item.get(key) is not None]
        return Counter(values).most_common(1)[0][0] if values else None

    sizes = [float(item["size_pt"]) for item in typographies if item.get("size_pt") is not None]
    result = {
        "family": most_common("family"),
        "size_pt": round(median(sizes), 2) if sizes else None,
        "bold": bool(most_common("bold")) if most_common("bold") is not None else None,
        "color": normalize_chart_color(most_common("color")),
    }
    return {key: value for key, value in result.items() if value is not None}


def _element_line_color(element: dict[str, Any]) -> str | None:
    stroke = element.get("stroke") or {}
    fill = element.get("fill") or {}
    return normalize_chart_color(stroke.get("color") or fill.get("color"))


def _regular_line_group(
    elements: list[dict[str, Any]],
    orientation: str,
    plot_region: dict[str, float],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    candidates = []
    for element in elements:
        if element.get("kind") not in {"fill", "shape", "line"}:
            continue
        norm = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
        if not _intersects_region(norm, plot_region, margin=0.02):
            continue
        geometry = element.get("geometry_pt") or {}
        width_pt = float(geometry.get("width_pt") or float(norm.get("width") or 0) * slide_width)
        height_pt = float(geometry.get("height_pt") or float(norm.get("height") or 0) * slide_height)
        if orientation == "horizontal":
            if float(norm.get("width") or 0) < plot_region["width"] * 0.5 or height_pt > 2.5:
                continue
            position = float(norm.get("y") or 0) + float(norm.get("height") or 0) / 2
            width = height_pt
        else:
            if float(norm.get("height") or 0) < plot_region["height"] * 0.5 or width_pt > 2.5:
                continue
            position = float(norm.get("x") or 0) + float(norm.get("width") or 0) / 2
            width = width_pt
        color = _element_line_color(element)
        if not color:
            continue
        stroke = element.get("stroke") or {}
        candidates.append({
            "element_id": element.get("element_id"),
            "position": position,
            "color": color,
            "width_pt": float(stroke.get("width_pt") or width or 0.5),
        })
    candidates.sort(key=lambda item: item["position"])
    if len(candidates) < 3 or not _labels_evenly_spaced([item["position"] for item in candidates], tolerance=0.4):
        return None
    color = Counter(item["color"] for item in candidates).most_common(1)[0][0]
    widths = [item["width_pt"] for item in candidates]
    return {
        "visible": True,
        "color": color,
        "width_pt": round(median(widths), 2),
        "count": len(candidates),
        "element_ids": [item["element_id"] for item in candidates],
    }


def _infer_chart_style_tokens(
    elements: list[dict[str, Any]],
    x_axis: dict[str, Any] | None,
    y_axis: dict[str, Any] | None,
    plot_region: dict[str, float],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any]:
    horizontal = _regular_line_group(elements, "horizontal", plot_region, slide_width, slide_height)
    vertical = _regular_line_group(elements, "vertical", plot_region, slide_width, slide_height)
    strongest = max(
        [item for item in (horizontal, vertical) if item],
        key=lambda item: item["count"],
        default=None,
    )
    grid_line = {
        "visible": bool(strongest),
        "horizontal_visible": bool(horizontal),
        "vertical_visible": bool(vertical),
        "horizontal_count": horizontal["count"] if horizontal else 0,
        "vertical_count": vertical["count"] if vertical else 0,
    }
    if strongest:
        grid_line.update({"color": strongest["color"], "width_pt": strongest["width_pt"]})
    return {
        "category_axis": {"visible": bool(x_axis), "typography": _dominant_axis_typography(x_axis)},
        "value_axis": {"visible": bool(y_axis), "typography": _dominant_axis_typography(y_axis)},
        "axis_line": {
            "visible": False,
            "color": strongest["color"] if strongest else None,
            "width_pt": strongest["width_pt"] if strongest else None,
        },
        "grid_line": grid_line,
        "axis_label": {
            "typography": _dominant_axis_typography(x_axis) or _dominant_axis_typography(y_axis),
        },
    }


def _serialize_axis(axis: dict[str, Any] | None) -> dict[str, Any] | None:
    if not axis:
        return None
    return {
        "axis": axis["axis"],
        "labels": [{"element_id": item["element_id"], "text": item["text"]} for item in axis["labels"]],
        "typography": _dominant_axis_typography(axis),
    }


def _norm_from_pt(geometry_pt: dict[str, Any], slide_width: float, slide_height: float) -> dict[str, float]:
    return {
        "x": round(float(geometry_pt.get("x_pt") or 0) / slide_width, 4),
        "y": round(float(geometry_pt.get("y_pt") or 0) / slide_height, 4),
        "width": round(float(geometry_pt.get("width_pt") or 0) / slide_width, 4),
        "height": round(float(geometry_pt.get("height_pt") or 0) / slide_height, 4),
    }


def _intersects_region(box: dict[str, float], region: dict[str, float], *, margin: float = 0.0) -> bool:
    left = float(box.get("x") or 0)
    top = float(box.get("y") or 0)
    width = float(box.get("width") or 0)
    height = float(box.get("height") or 0)
    right = left + width
    bottom = top + height
    region_right = region["x"] + region["width"]
    region_bottom = region["y"] + region["height"]
    return (
        right >= region["x"] - margin
        and left <= region_right + margin
        and bottom >= region["y"] - margin
        and top <= region_bottom + margin
    )


def _cluster_norm_values(values: list[float], tolerance: float) -> list[float]:
    if not values:
        return []
    sorted_values = sorted(values)
    clusters: list[list[float]] = [[sorted_values[0]]]
    for value in sorted_values[1:]:
        if abs(value - median(clusters[-1])) <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [median(cluster) for cluster in clusters]


def _cluster_axis_values(values: list[float], tolerance: float) -> list[float]:
    if not values:
        return []
    sorted_values = sorted(values)
    clusters: list[list[float]] = [[sorted_values[0]]]
    for value in sorted_values[1:]:
        if abs(value - median(clusters[-1])) <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [median(cluster) for cluster in clusters]


def _nearest_index(value: float, centers: list[float], tolerance: float) -> int | None:
    if not centers:
        return None
    best_index = min(range(len(centers)), key=lambda index: abs(centers[index] - value))
    if abs(centers[best_index] - value) > tolerance:
        return None
    return best_index
