"""Detect pie/doughnut chart regions from square-ish images with centered labels."""

from __future__ import annotations

import math
import re
from statistics import median
from typing import Any

from .chart_palette import normalize_chart_color
from .metric_text import detect_metric_text

TITLE_ZONE_MAX_Y = 0.22
CIRCULAR_MIN_WIDTH_NORM = 0.14
CIRCULAR_MIN_HEIGHT_NORM = 0.20
CIRCULAR_MIN_SQUARENESS = 0.52
CIRCULAR_MAX_COVERAGE = 0.82
CENTER_MAX_OFFSET_RATIO = 0.14
CENTER_TEXT_MIN_COVER = 0.80
MIN_CONFIDENCE = 0.58
MIN_CONFIDENCE_WITH_METRIC = 0.68
CIRCULAR_LEGEND_BAND_RATIO = 0.16
CIRCULAR_DIAMETER_CLUSTER_RATIO = 0.22
CIRCULAR_DIAMETER_CLUSTER_MIN_PT = 18.0
DEFAULT_DOUGHNUT_HOLE_SIZE = 68
MIN_DOUGHNUT_HOLE_SIZE = 64
MAX_DOUGHNUT_HOLE_SIZE = 84
CENTER_METRIC_SAFE_DIAMETER_RATIO = 0.82
GENERIC_CENTER_LABELS = frozenset({
    "текстовый блок",
    "text block",
    "подпись",
    "label",
    "заголовок",
    "описание",
    "пояснение",
})
CAPTION_MAX_BELOW_NORM = 0.14
CAPTION_MAX_HORIZONTAL_OFFSET = 0.55


def apply_circular_chart_inference(slides_catalog: dict | None, slide_size: tuple[float, float] | None) -> None:
    if not slides_catalog or not slide_size:
        return

    slide_width, slide_height = slide_size
    all_instances: list[dict[str, Any]] = []
    slide_hits = 0

    for slide in slides_catalog.get("slides") or []:
        instances = infer_circular_charts_on_slide(slide, slide_width, slide_height)
        if instances:
            slide["inferred_circular_charts"] = instances
            slide_hits += 1
            for instance in instances:
                all_instances.append({
                    **instance,
                    "slide_number": slide.get("slide_number"),
                    "template_id": slide.get("template_id"),
                })
        elif "inferred_circular_charts" in slide:
            del slide["inferred_circular_charts"]

    summary = slides_catalog.setdefault("summary", {})
    summary["inferred_circular_chart_slides"] = slide_hits
    summary["inferred_circular_chart_instances"] = len(all_instances)
    summary["circular_chart_size_profiles"] = build_circular_chart_size_profiles(all_instances)


def infer_circular_charts_on_slide(
    slide: dict[str, Any],
    slide_width: float,
    slide_height: float,
) -> list[dict[str, Any]]:
    elements = slide.get("content_elements") or []
    if any(element.get("kind") in {"table", "diagram"} for element in elements):
        return []
    if slide.get("inferred_table"):
        return []

    texts = [element for element in elements if element.get("kind") == "text" and _text_value(element)]
    images = [element for element in elements if element.get("kind") == "image"]

    instances = _native_circular_chart_instances(elements, slide_width, slide_height)
    if instances:
        return instances

    instances = []
    used_text_ids: set[str] = set()
    for image in images:
        image_norm = image.get("geometry_norm") or _norm_from_pt(image.get("geometry_pt") or {}, slide_width, slide_height)
        if not _is_circular_plot_image(image_norm):
            continue

        center_text = _find_center_text(image, image_norm, texts, used_text_ids, slide_width, slide_height)
        if not center_text:
            continue

        caption_text = _find_chart_caption(image_norm, texts, used_text_ids, slide_width, slide_height)

        metric = _detect_center_metric(center_text)
        confidence = _circular_confidence(image_norm, center_text, metric, image)
        if not metric or confidence < MIN_CONFIDENCE_WITH_METRIC:
            continue

        chart_type = _guess_circular_chart_type(metric, center_text)
        plot_region_pt = image.get("geometry_pt") or _pt_from_norm(image_norm, slide_width, slide_height)
        center_fit = estimate_center_metric_fit(
            image_norm,
            center_text,
            metric,
            slide_width,
            slide_height,
        )
        consumed_ids = {
            image.get("element_id"),
            center_text.get("element_id"),
            caption_text.get("element_id") if caption_text else None,
        } - {None}
        instances.append({
            "source": "image_center_label",
            "confidence": round(confidence, 3),
            "chart_type_guess": chart_type,
            "plot_region_norm": {
                "x": round(float(image_norm.get("x") or 0), 4),
                "y": round(float(image_norm.get("y") or 0), 4),
                "width": round(float(image_norm.get("width") or 0), 4),
                "height": round(float(image_norm.get("height") or 0), 4),
            },
            "plot_region_pt": plot_region_pt,
            "squareness": round(_physical_squareness(image_norm, slide_width, slide_height), 3),
            "center_text": {
                "element_id": center_text.get("element_id"),
                "text": _text_value(center_text),
            },
            "center_metric": metric,
            "center_metric_fit": center_fit,
            "caption_text": {
                "element_id": caption_text.get("element_id"),
                "text": _text_value(caption_text),
                "typography": caption_text.get("typography") if caption_text else None,
            } if caption_text else None,
            "signals": {
                "has_center_metric": bool(metric),
                "has_caption": bool(caption_text),
                "metric_unit": (metric or {}).get("unit"),
                "center_offset_ratio": round(_center_offset_ratio(image_norm, center_text, slide_width, slide_height), 3),
                "image_width_norm": round(float(image_norm.get("width") or 0), 3),
                "image_height_norm": round(float(image_norm.get("height") or 0), 3),
                "physical_squareness": round(_physical_squareness(image_norm, slide_width, slide_height), 3),
                "required_hole_size": center_fit["required_hole_size"],
                "image_behind_center_text": (image.get("z_index") or 0) <= (center_text.get("z_index") or 0),
            },
            "consumed_element_ids": sorted(consumed_ids),
        })
        if center_text.get("element_id"):
            used_text_ids.add(center_text["element_id"])
        if caption_text and caption_text.get("element_id"):
            used_text_ids.add(caption_text["element_id"])

    return instances


def build_circular_chart_size_profiles(instances: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not instances:
        return []

    clusters = cluster_circular_instances(instances)

    profiles: list[dict[str, Any]] = []
    for index, cluster in enumerate(sorted(clusters, key=lambda items: -len(items)), start=1):
        widths = [float(item["plot_region_norm"]["width"]) for item in cluster]
        heights = [float(item["plot_region_norm"]["height"]) for item in cluster]
        squareness = [float(item.get("squareness") or _squareness(item["plot_region_norm"])) for item in cluster]
        widths_pt = [float((item.get("plot_region_pt") or {}).get("width_pt") or 0) for item in cluster]
        heights_pt = [float((item.get("plot_region_pt") or {}).get("height_pt") or 0) for item in cluster]
        diameters_pt = [min(width, height) for width, height in zip(widths_pt, heights_pt) if width > 0 and height > 0]
        hole_sizes = [
            float((item.get("center_metric_fit") or {}).get("required_hole_size") or 0)
            for item in cluster
            if (item.get("center_metric_fit") or {}).get("required_hole_size")
        ]
        size_class = "large" if median(widths) >= 0.30 else "small"
        profiles.append({
            "profile_id": f"circular_{size_class}_{index:02d}",
            "size_class": size_class,
            "instance_count": len(cluster),
            "slide_numbers": sorted({item.get("slide_number") for item in cluster if item.get("slide_number") is not None}),
            "template_ids": sorted({item.get("template_id") for item in cluster if item.get("template_id")}),
            "width_norm": _stats(widths),
            "height_norm": _stats(heights),
            "width_pt": _stats(widths_pt),
            "height_pt": _stats(heights_pt),
            "diameter_pt": _stats(diameters_pt),
            "required_hole_size": _stats(hole_sizes),
            "squareness": _stats(squareness),
            "chart_type_guess": _dominant_chart_type(cluster),
        })
    profiles.sort(key=lambda item: (-item["instance_count"], -item["width_norm"]["median"]))
    return profiles


def circular_instance_diameter_pt(instance: dict[str, Any]) -> float:
    box = instance.get("plot_region_pt") or {}
    width = float(box.get("width_pt") or 0)
    height = float(box.get("height_pt") or 0)
    if width > 0 and height > 0:
        return min(width, height)
    norm = instance.get("plot_region_norm") or {}
    return float(norm.get("width") or 0) * 1000


def cluster_circular_instances(instances: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    clusters: list[list[dict[str, Any]]] = []
    for instance in sorted(instances, key=circular_instance_diameter_pt):
        diameter = circular_instance_diameter_pt(instance)
        placed = False
        for cluster in clusters:
            center = median(circular_instance_diameter_pt(item) for item in cluster)
            tolerance = max(CIRCULAR_DIAMETER_CLUSTER_MIN_PT, center * CIRCULAR_DIAMETER_CLUSTER_RATIO)
            if abs(diameter - center) <= tolerance:
                cluster.append(instance)
                placed = True
                break
        if not placed:
            clusters.append([instance])
    return clusters


def apply_circular_profiles_to_chart_baselines(
    catalog: dict[str, Any],
    size_profiles: list[dict[str, Any]] | None,
) -> None:
    profiles = list(size_profiles or [])
    if not profiles:
        return
    doughnut_profiles = [item for item in profiles if item.get("chart_type_guess") == "doughnut"]
    source_profiles = doughnut_profiles or profiles
    profile = max(
        source_profiles,
        key=lambda item: ((item.get("diameter_pt") or {}).get("median") or 0, item.get("instance_count") or 0),
    )

    for chart in catalog.get("charts") or []:
        if not chart.get("is_baseline"):
            continue
        chart_type = str(chart.get("chart_type") or "").lower()
        if chart_type not in {"pie", "doughnut"}:
            continue
        chart["layout_from_deck"] = True
        chart["default_geometry_norm"] = {
            "width": round(
                profile["width_norm"]["median"]
                * profile["diameter_pt"]["median"]
                / max(profile["width_pt"]["median"], 0.01),
                4,
            ),
            "height": round(
                profile["height_norm"]["median"]
                * profile["diameter_pt"]["median"]
                / max(profile["height_pt"]["median"], 0.01),
                4,
            ),
            "squareness": 1.0,
        }
        chart["default_geometry_pt"] = {
            "width_pt": round(profile["diameter_pt"]["median"], 2),
            "height_pt": round(profile["diameter_pt"]["median"], 2),
        }
        chart["circular_size_profile_id"] = profile["profile_id"]


def apply_circular_style_to_chart_baselines(
    catalog: dict[str, Any],
    slides_catalog: dict[str, Any] | None,
) -> None:
    style = extract_deck_circular_style(slides_catalog)

    for chart in catalog.get("charts") or []:
        if not chart.get("is_baseline"):
            continue
        chart_type = str(chart.get("chart_type") or "").lower()
        if chart_type not in {"pie", "doughnut"}:
            continue

        chart["categories_preview"] = style["categories_preview"]
        chart["series_preview"] = style["series_preview"]
        if style.get("center_metric_preview") and chart_type == "doughnut":
            chart["center_metric_preview"] = style["center_metric_preview"]

        if chart_type == "doughnut":
            subtype = dict(chart.get("subtype") or {})
            subtype["hole_size"] = int(style.get("required_hole_size") or DEFAULT_DOUGHNUT_HOLE_SIZE)
            chart["subtype"] = subtype

        tokens = dict(chart.get("style_tokens") or {})
        circular_layout = dict(tokens.get("circular_layout") or {})
        circular_layout.update({
            "preserve_aspect": True,
            "legend_band_ratio": style.get("legend_band_ratio", CIRCULAR_LEGEND_BAND_RATIO),
            "center_metric": {
                "enabled": chart_type == "doughnut" and bool(style.get("center_metric_preview")),
                "preview": style.get("center_metric_preview"),
                "value_typography": (style.get("center_metric_template") or {}).get("value_typography"),
                "unit_typography": (style.get("center_metric_template") or {}).get("unit_typography"),
                "required_hole_size": int(style.get("required_hole_size") or DEFAULT_DOUGHNUT_HOLE_SIZE),
                "inner_free_radius_pt": style.get("inner_free_radius_pt"),
                "safe_fit": style.get("center_metric_safe_fit"),
            },
        })
        tokens["circular_layout"] = circular_layout
        tokens["legend"] = {
            "visible": True,
            "position": "below",
            "typography": style.get("caption_typography") or {},
        }
        chart["style_tokens"] = tokens


def _find_chart_caption(
    image_norm: dict[str, float],
    texts: list[dict[str, Any]],
    used_text_ids: set[str],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    image_left = float(image_norm.get("x") or 0)
    image_top = float(image_norm.get("y") or 0)
    image_width = float(image_norm.get("width") or 0)
    image_height = float(image_norm.get("height") or 0)
    image_right = image_left + image_width
    image_bottom = image_top + image_height
    image_cx = image_left + image_width / 2
    best: dict[str, Any] | None = None
    best_score = 999.0

    for element in texts:
        element_id = element.get("element_id")
        if element_id in used_text_ids:
            continue
        text = _text_value(element)
        if not text or text.count("\n") > 1:
            continue
        normalized = text.strip().lower()
        if normalized in GENERIC_CENTER_LABELS and not _looks_like_caption_text(text):
            continue

        norm = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
        text_top = float(norm.get("y") or 0)
        text_cx = float(norm.get("x") or 0) + float(norm.get("width") or 0) / 2
        if text_top < image_bottom - 0.01:
            continue
        if text_top > image_bottom + CAPTION_MAX_BELOW_NORM:
            continue
        horizontal_offset = abs(text_cx - image_cx) / max(image_width, 0.08)
        if horizontal_offset > CAPTION_MAX_HORIZONTAL_OFFSET:
            continue
        score = horizontal_offset + (text_top - image_bottom) * 0.5
        if score < best_score:
            best = element
            best_score = score
    return best


def _looks_like_caption_text(text: str) -> bool:
    normalized = text.strip().lower()
    return normalized in {"пояснение", "подпись", "label", "caption"}


def extract_deck_circular_style(slides_catalog: dict[str, Any] | None) -> dict[str, Any] | None:
    instances: list[dict[str, Any]] = []
    for slide in (slides_catalog or {}).get("slides") or []:
        for instance in slide.get("inferred_circular_charts") or []:
            instances.append({
                **instance,
                "slide_number": slide.get("slide_number"),
            })
    metric_instances = [item for item in instances if item.get("center_metric")]
    metric_clusters = cluster_circular_instances(metric_instances) if metric_instances else []
    dominant_metric_instances = max(
        metric_clusters,
        key=lambda cluster: (
            median(circular_instance_diameter_pt(item) for item in cluster),
            len(cluster),
            median(float(item.get("confidence") or 0) for item in cluster),
        ),
    ) if metric_clusters else []
    best_metric = max(
        dominant_metric_instances,
        key=lambda item: (float(item.get("confidence") or 0), item.get("slide_number") or 0),
    ) if dominant_metric_instances else None

    values: list[float] = []
    if dominant_metric_instances:
        for item in sorted(dominant_metric_instances, key=lambda entry: float(entry.get("confidence") or 0), reverse=True)[:4]:
            metric = item.get("center_metric") or {}
            try:
                values.append(float(str(metric.get("value") or "0").replace(",", ".")))
            except ValueError:
                continue
    if len(values) < 4:
        values = [42.0, 32.0, 22.0, 12.0]

    # No arbitrary slide text is allowed to influence a circular component.
    # With no confirmed image+metric pair, family/color are resolved by DS at render time.
    fallback_typography = {"size_pt": 24.0, "bold": True}
    center_metric_preview = {"value": "42", "unit": "%"}
    center_metric_template = {
        "value_typography": fallback_typography,
        "unit_typography": {**fallback_typography, "size_pt": round(max(10.0, float(fallback_typography.get("size_pt") or 24) * 0.62), 2)},
    }
    caption_typography = None
    if best_metric:
        metric = dict(best_metric.get("center_metric") or {})
        metric["value_typography"] = _aggregate_metric_typography(
            dominant_metric_instances,
            "value_typography",
            metric.get("value_typography") or {},
        )
        metric["unit_typography"] = _aggregate_metric_typography(
            dominant_metric_instances,
            "unit_typography",
            metric.get("unit_typography") or metric.get("value_typography") or {},
        )
        center_metric_template = metric
        center_metric_preview = {
            "value": metric.get("value") or str(int(values[0])),
            "unit": metric.get("unit") or "%",
        }

    hole_sizes = [
        float((item.get("center_metric_fit") or {}).get("required_hole_size") or 0)
        for item in (dominant_metric_instances or instances)
        if (item.get("center_metric_fit") or {}).get("required_hole_size")
    ]
    inner_radii = [
        float((item.get("center_metric_fit") or {}).get("inner_free_radius_pt") or 0)
        for item in (dominant_metric_instances or instances)
        if (item.get("center_metric_fit") or {}).get("inner_free_radius_pt")
    ]

    selected_diameter_pt = circular_instance_diameter_pt(best_metric) if best_metric else 0.0
    selected_hole_size = max(
        MIN_DOUGHNUT_HOLE_SIZE,
        round(median(hole_sizes)) if hole_sizes else DEFAULT_DOUGHNUT_HOLE_SIZE,
    )
    if best_metric and selected_diameter_pt > 0:
        center_metric_template, safe_fit = fit_center_metric_typography(
            center_metric_template,
            selected_diameter_pt,
            selected_hole_size,
        )
    else:
        safe_fit = None

    caption_instances = [item for item in (dominant_metric_instances or instances) if item.get("caption_text")]
    if caption_instances:
        best_caption = max(
            caption_instances,
            key=lambda item: (float(item.get("confidence") or 0), item.get("slide_number") or 0),
        )
        caption_typography = (best_caption.get("caption_text") or {}).get("typography")

    return {
        "categories_preview": ["A", "B", "C", "D"],
        "series_preview": [{"name": "Share", "values_preview": [int(v) for v in values[:4]]}],
        "center_metric_preview": center_metric_preview,
        "center_metric_template": center_metric_template,
        "caption_typography": caption_typography,
        "legend_band_ratio": CIRCULAR_LEGEND_BAND_RATIO,
        "required_hole_size": selected_hole_size,
        "inner_free_radius_pt": round(median(inner_radii), 2) if inner_radii else None,
        "center_metric_safe_fit": safe_fit,
    }


def fit_center_metric_typography(
    metric: dict[str, Any],
    diameter_pt: float,
    hole_size: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Shrink metric type only when it does not fit safely inside the hole."""
    fitted = dict(metric or {})
    value_typography = dict(fitted.get("value_typography") or {})
    unit_typography = dict(fitted.get("unit_typography") or value_typography)
    value_size = float(value_typography.get("size_pt") or 18)
    unit_size = float(unit_typography.get("size_pt") or value_size * 0.62)
    value = str(fitted.get("value") or "")
    unit = str(fitted.get("unit") or "")
    estimated_width = len(value) * value_size * 0.58 + len(unit) * unit_size * 0.55
    estimated_height = max(value_size, unit_size) * 1.18
    inner_diameter_pt = max(1.0, float(diameter_pt) * float(hole_size) / 100)
    safe_diameter_pt = inner_diameter_pt * CENTER_METRIC_SAFE_DIAMETER_RATIO
    scale = min(
        1.0,
        safe_diameter_pt / max(estimated_width, 1.0),
        safe_diameter_pt / max(estimated_height, 1.0),
    )
    if scale < 1.0:
        value_typography["size_pt"] = round(value_size * scale, 2)
        unit_typography["size_pt"] = round(unit_size * scale, 2)
    fitted["value_typography"] = value_typography
    fitted["unit_typography"] = unit_typography
    safe_gap_pt = max(0.0, (inner_diameter_pt - safe_diameter_pt) / 2)
    return fitted, {
        "diameter_pt": round(float(diameter_pt), 2),
        "hole_size": round(float(hole_size), 2),
        "inner_diameter_pt": round(inner_diameter_pt, 2),
        "safe_text_width_pt": round(safe_diameter_pt, 2),
        "safe_gap_each_side_pt": round(safe_gap_pt, 2),
        "estimated_text_width_pt": round(estimated_width * scale, 2),
        "estimated_text_height_pt": round(estimated_height * scale, 2),
        "typography_scale": round(scale, 4),
        "fits": True,
    }


def _aggregate_metric_typography(
    instances: list[dict[str, Any]],
    key: str,
    fallback: dict[str, Any],
) -> dict[str, Any]:
    samples = [
        dict(((item.get("center_metric") or {}).get(key)) or {})
        for item in instances
        if ((item.get("center_metric") or {}).get(key))
    ]
    if not samples:
        return dict(fallback)
    result = dict(fallback or samples[0])
    sizes = [float(sample["size_pt"]) for sample in samples if sample.get("size_pt") is not None]
    if sizes:
        result["size_pt"] = round(median(sizes), 2)
    for field in ("family", "color", "bold", "italic", "underline"):
        values = [sample.get(field) for sample in samples if sample.get(field) is not None]
        if values:
            result[field] = max(set(values), key=values.count)
    return result


def _native_circular_chart_instances(
    elements: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> list[dict[str, Any]]:
    instances: list[dict[str, Any]] = []
    for element in elements:
        if element.get("kind") != "chart":
            continue
        chart_type = str(element.get("chart_type") or (element.get("chart") or {}).get("type") or "").lower()
        if chart_type == "donut":
            chart_type = "doughnut"
        if chart_type not in {"pie", "doughnut"}:
            continue
        geometry_norm = element.get("geometry_norm") or _norm_from_pt(
            element.get("geometry_pt") or {}, slide_width, slide_height
        )
        geometry_pt = element.get("geometry_pt") or _pt_from_norm(geometry_norm, slide_width, slide_height)
        subtype = element.get("subtype") or (element.get("chart") or {}).get("subtype") or {}
        hole_size = int(subtype.get("hole_size") or DEFAULT_DOUGHNUT_HOLE_SIZE) if chart_type == "doughnut" else 0
        instances.append({
            "source": "native_chart",
            "confidence": 1.0,
            "chart_type_guess": chart_type,
            "plot_region_norm": geometry_norm,
            "plot_region_pt": geometry_pt,
            "squareness": round(_physical_squareness(geometry_norm, slide_width, slide_height), 3),
            "center_text": None,
            "center_metric": None,
            "center_metric_fit": {
                "required_hole_size": hole_size,
                "inner_free_radius_pt": round(
                    min(float(geometry_pt.get("width_pt") or 0), float(geometry_pt.get("height_pt") or 0))
                    * hole_size / 200,
                    2,
                ) if hole_size else 0,
            },
            "caption_text": None,
            "signals": {
                "native_chart": True,
                "has_center_metric": False,
                "required_hole_size": hole_size,
            },
            "consumed_element_ids": [element.get("element_id")] if element.get("element_id") else [],
        })
    return instances


def estimate_center_metric_fit(
    plot_region_norm: dict[str, float],
    center_text: dict[str, Any],
    metric: dict[str, Any] | None,
    slide_width: float,
    slide_height: float,
) -> dict[str, Any]:
    """Estimate the minimum doughnut hole that contains the center label."""
    diameter_pt = min(
        float(plot_region_norm.get("width") or 0) * slide_width,
        float(plot_region_norm.get("height") or 0) * slide_height,
    )
    typography = dict(center_text.get("typography") or {})
    value_typography = dict((metric or {}).get("value_typography") or typography)
    unit_typography = dict((metric or {}).get("unit_typography") or value_typography)
    value = str((metric or {}).get("value") or _text_value(center_text) or "42")
    unit = str((metric or {}).get("unit") or "")
    value_size = float(value_typography.get("size_pt") or typography.get("size_pt") or 18)
    unit_size = float(unit_typography.get("size_pt") or value_size * 0.62)
    estimated_width = len(value) * value_size * 0.58 + len(unit) * unit_size * 0.55
    estimated_height = max(value_size, unit_size) * 1.18
    padding_pt = max(4.0, max(value_size, unit_size) * 0.20)
    required_radius_pt = math.hypot(estimated_width / 2, estimated_height / 2) + padding_pt
    outer_radius_pt = max(diameter_pt / 2, 1.0)
    required_hole_size = math.ceil(required_radius_pt / outer_radius_pt * 100)
    required_hole_size = max(MIN_DOUGHNUT_HOLE_SIZE, min(MAX_DOUGHNUT_HOLE_SIZE, required_hole_size))
    return {
        "diameter_pt": round(diameter_pt, 2),
        "estimated_text_width_pt": round(estimated_width, 2),
        "estimated_text_height_pt": round(estimated_height, 2),
        "required_hole_size": required_hole_size,
        "inner_free_radius_pt": round(outer_radius_pt * required_hole_size / 100, 2),
    }


def _text_value(element: dict[str, Any]) -> str:
    return str(element.get("text") or "").strip()


def _detect_center_metric(element: dict[str, Any]) -> dict[str, Any] | None:
    metric = element.get("metric") or detect_metric_text(
        _text_value(element),
        None,
        element.get("typography"),
    )
    if metric:
        return metric
    text = _text_value(element)
    if not re.fullmatch(r"[+\-]?\d[\d\s.,]*", text):
        return None
    typography = dict(element.get("typography") or {})
    return {
        "value": text,
        "unit": "",
        "value_typography": typography,
        "unit_typography": typography,
        "split_source": "text",
    }


def _squareness(box: dict[str, float]) -> float:
    width = float(box.get("width") or 0)
    height = float(box.get("height") or 0)
    if width <= 0 or height <= 0:
        return 0.0
    return min(width, height) / max(width, height)


def _physical_squareness(box: dict[str, float], slide_width: float, slide_height: float) -> float:
    return _squareness({
        "width": float(box.get("width") or 0) * slide_width,
        "height": float(box.get("height") or 0) * slide_height,
    })


def _is_circular_plot_image(box: dict[str, float]) -> bool:
    width = float(box.get("width") or 0)
    height = float(box.get("height") or 0)
    top = float(box.get("y") or 0)
    if width < CIRCULAR_MIN_WIDTH_NORM or height < CIRCULAR_MIN_HEIGHT_NORM:
        return False
    if top < TITLE_ZONE_MAX_Y and width > 0.7:
        return False
    if width * height > CIRCULAR_MAX_COVERAGE:
        return False
    return _squareness(box) >= CIRCULAR_MIN_SQUARENESS


def _region_center(box: dict[str, float]) -> tuple[float, float]:
    return (
        float(box.get("x") or 0) + float(box.get("width") or 0) / 2,
        float(box.get("y") or 0) + float(box.get("height") or 0) / 2,
    )


def _text_center(element: dict[str, Any], slide_width: float, slide_height: float) -> tuple[float, float]:
    norm = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
    return (
        float(norm.get("x") or 0) + float(norm.get("width") or 0) / 2,
        float(norm.get("y") or 0) + float(norm.get("height") or 0) / 2,
    )


def _center_offset_ratio(
    image_norm: dict[str, float],
    text_element: dict[str, Any],
    slide_width: float = 1.0,
    slide_height: float = 1.0,
) -> float:
    icx, icy = _region_center(image_norm)
    tcx, tcy = _text_center(text_element, slide_width, slide_height)
    dx = abs(tcx - icx) * slide_width
    dy = abs(tcy - icy) * slide_height
    scale = max(min(
        float(image_norm.get("width") or 0) * slide_width,
        float(image_norm.get("height") or 0) * slide_height,
    ), 1.0)
    return math.hypot(dx, dy) / scale


def _find_center_text(
    image: dict[str, Any],
    image_norm: dict[str, float],
    texts: list[dict[str, Any]],
    used_text_ids: set[str],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    icx, icy = _region_center(image_norm)
    image_left = float(image_norm.get("x") or 0)
    image_top = float(image_norm.get("y") or 0)
    image_right = image_left + float(image_norm.get("width") or 0)
    image_bottom = image_top + float(image_norm.get("height") or 0)
    best: dict[str, Any] | None = None
    best_score = 999.0

    for element in texts:
        element_id = element.get("element_id")
        if element_id in used_text_ids:
            continue
        text = _text_value(element)
        if not text or text.count("\n") > 2:
            continue
        normalized = text.strip().lower()
        if normalized in GENERIC_CENTER_LABELS:
            continue
        if (image.get("z_index") or 0) > (element.get("z_index") or 0):
            continue
        if float((element.get("geometry_norm") or {}).get("y") or 0) < TITLE_ZONE_MAX_Y and len(text) > 28:
            continue

        norm = element.get("geometry_norm") or _norm_from_pt(element.get("geometry_pt") or {}, slide_width, slide_height)
        left = float(norm.get("x") or 0)
        top = float(norm.get("y") or 0)
        right = left + float(norm.get("width") or 0)
        bottom = top + float(norm.get("height") or 0)
        tcx, tcy = left + float(norm.get("width") or 0) / 2, top + float(norm.get("height") or 0) / 2
        if tcx < image_left or tcx > image_right or tcy < image_top or tcy > image_bottom:
            continue

        intersection_width = max(0.0, min(right, image_right) - max(left, image_left))
        intersection_height = max(0.0, min(bottom, image_bottom) - max(top, image_top))
        text_area = max(float(norm.get("width") or 0) * float(norm.get("height") or 0), 1e-9)
        if intersection_width * intersection_height / text_area < CENTER_TEXT_MIN_COVER:
            continue

        offset = _center_offset_ratio(image_norm, element, slide_width, slide_height)
        if offset > CENTER_MAX_OFFSET_RATIO:
            continue

        metric = _detect_center_metric(element)
        if not metric:
            continue
        score = offset - (0.08 if metric else 0.0) - (0.04 if (metric or {}).get("unit") == "%" else 0.0)
        if score < best_score:
            best = element
            best_score = score
    return best


def _circular_confidence(
    image_norm: dict[str, float],
    center_text: dict[str, Any],
    metric: dict[str, Any] | None,
    image: dict[str, Any] | None = None,
) -> float:
    score = 0.42
    squareness = _squareness(image_norm)
    score += min(0.12, (squareness - CIRCULAR_MIN_SQUARENESS) * 0.8)
    image_pt = (image or {}).get("geometry_pt") or {}
    slide_width = float(image_pt.get("width_pt") or 0) / max(float(image_norm.get("width") or 0), 1e-9) or 1.0
    slide_height = float(image_pt.get("height_pt") or 0) / max(float(image_norm.get("height") or 0), 1e-9) or 1.0
    offset = _center_offset_ratio(image_norm, center_text, slide_width, slide_height)
    score += max(0.0, 0.18 - offset * 0.7)
    if metric:
        score += 0.16
    if image is not None and (image.get("z_index") or 0) <= (center_text.get("z_index") or 0):
        score += 0.04
    if (metric or {}).get("unit") == "%":
        score += 0.10
    width = float(image_norm.get("width") or 0)
    if width >= 0.30:
        score += 0.04
    center_color = normalize_chart_color(((metric or {}).get("value_typography") or {}).get("color"))
    if center_color:
        score += 0.02
    return min(score, 0.96)


def _guess_circular_chart_type(metric: dict[str, Any] | None, center_text: dict[str, Any]) -> str:
    if metric or _text_value(center_text):
        return "doughnut"
    return "pie"


def _stats(values: list[float]) -> dict[str, float]:
    if not values:
        return {"median": 0.0, "min": 0.0, "max": 0.0}
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        med = ordered[mid]
    else:
        med = (ordered[mid - 1] + ordered[mid]) / 2
    return {
        "median": round(med, 4),
        "min": round(ordered[0], 4),
        "max": round(ordered[-1], 4),
    }


def _dominant_chart_type(cluster: list[dict[str, Any]]) -> str:
    counts: dict[str, int] = {}
    for item in cluster:
        chart_type = str(item.get("chart_type_guess") or "doughnut")
        counts[chart_type] = counts.get(chart_type, 0) + 1
    return max(counts, key=counts.get)


def _norm_from_pt(geometry_pt: dict[str, Any], slide_width: float, slide_height: float) -> dict[str, float]:
    return {
        "x": round(float(geometry_pt.get("x_pt") or 0) / slide_width, 4),
        "y": round(float(geometry_pt.get("y_pt") or 0) / slide_height, 4),
        "width": round(float(geometry_pt.get("width_pt") or 0) / slide_width, 4),
        "height": round(float(geometry_pt.get("height_pt") or 0) / slide_height, 4),
    }


def _pt_from_norm(box: dict[str, float], slide_width: float, slide_height: float) -> dict[str, float]:
    return {
        "x_pt": round(float(box.get("x") or 0) * slide_width, 2),
        "y_pt": round(float(box.get("y") or 0) * slide_height, 2),
        "width_pt": round(float(box.get("width") or 0) * slide_width, 2),
        "height_pt": round(float(box.get("height") or 0) * slide_height, 2),
    }
