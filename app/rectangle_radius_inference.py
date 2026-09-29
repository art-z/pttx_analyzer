"""Aggregate rectangular corner radii with extra weight for graphic candidates."""

from __future__ import annotations

from typing import Any

GRAPHIC_CANDIDATE_WEIGHT = 6.0
GENERIC_RECTANGLE_WEIGHT = 1.0
RECTANGLE_KINDS = frozenset({"fill", "shape"})


def apply_rectangle_radius_inference(
    slides_catalog: dict[str, Any] | None,
    slide_size: tuple[float, float] | None,
) -> None:
    if not slides_catalog or not slide_size:
        return
    slide_width, slide_height = slide_size
    all_samples: list[dict[str, Any]] = []
    all_bar_samples: list[dict[str, Any]] = []
    all_diagram_samples: list[dict[str, Any]] = []

    for slide in slides_catalog.get("slides") or []:
        elements = slide.get("content_elements") or []
        by_id = {element.get("element_id"): element for element in elements if element.get("element_id")}
        inferred_chart = slide.get("inferred_chart") or {}
        chart_ids = set(
            inferred_chart.get("bar_element_ids")
            or inferred_chart.get("plot_mark_element_ids")
            or inferred_chart.get("consumed_element_ids")
            or []
        )
        inferred_diagram = slide.get("inferred_diagram") or {}
        diagram_ids = set(
            inferred_diagram.get("node_element_ids")
            or inferred_diagram.get("consumed_element_ids")
            or []
        )

        for element in elements:
            sample = rectangle_radius_sample(element, slide_width, slide_height)
            if sample is None:
                continue
            element_id = element.get("element_id")
            if element_id in chart_ids and str(inferred_chart.get("chart_type_guess") or "").lower() == "bar":
                weight, source = GRAPHIC_CANDIDATE_WEIGHT, "bar_chart_candidate"
            elif element_id in diagram_ids and inferred_diagram:
                weight, source = GRAPHIC_CANDIDATE_WEIGHT, "diagram_candidate"
            else:
                weight, source = GENERIC_RECTANGLE_WEIGHT, "generic_rectangle"
            all_samples.append({**sample, "weight": weight, "source": source})

        if str(inferred_chart.get("chart_type_guess") or "").lower() == "bar":
            bar_samples = [
                sample
                for element_id in chart_ids
                if (sample := rectangle_radius_sample(by_id.get(element_id), slide_width, slide_height)) is not None
            ]
            if bar_samples:
                all_bar_samples.extend(bar_samples)
                profile = summarize_radius_samples(bar_samples, GRAPHIC_CANDIDATE_WEIGHT, "bar_chart_candidate")
                style = dict(inferred_chart.get("style_tokens") or {})
                style["series_geometry"] = profile
                inferred_chart["style_tokens"] = style

        if inferred_diagram:
            diagram_samples = [
                sample
                for element_id in diagram_ids
                if (sample := rectangle_radius_sample(by_id.get(element_id), slide_width, slide_height)) is not None
            ]
            if diagram_samples:
                all_diagram_samples.extend(diagram_samples)
                profile = summarize_radius_samples(diagram_samples, GRAPHIC_CANDIDATE_WEIGHT, "diagram_candidate")
                style = dict(inferred_diagram.get("style_tokens") or {})
                node = dict(style.get("node") or {})
                node.update({
                    "radius_pt": profile["corner_radius_pt"],
                    "radius_ratio": profile["corner_radius_ratio"],
                    "radius_source": profile["source"],
                    "radius_sample_count": profile["sample_count"],
                })
                style["node"] = node
                inferred_diagram["style_tokens"] = style

    summary = slides_catalog.setdefault("summary", {})
    summary["rectangle_radius_profile"] = summarize_weighted_radius_samples(all_samples)
    summary["rectangle_radius_profiles"] = {
        "all": summary["rectangle_radius_profile"],
        "bar_chart": summarize_radius_samples(all_bar_samples, GRAPHIC_CANDIDATE_WEIGHT, "bar_chart_candidate"),
        "diagram": summarize_radius_samples(all_diagram_samples, GRAPHIC_CANDIDATE_WEIGHT, "diagram_candidate"),
    }


def rectangle_radius_sample(
    element: dict[str, Any] | None,
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    if not element or element.get("kind") not in RECTANGLE_KINDS:
        return None
    geometry_pt = element.get("geometry_pt") or {}
    geometry_norm = element.get("geometry_norm") or {}
    width_pt = float(geometry_pt.get("width_pt") or float(geometry_norm.get("width") or 0) * slide_width)
    height_pt = float(geometry_pt.get("height_pt") or float(geometry_norm.get("height") or 0) * slide_height)
    short_side = min(width_pt, height_pt)
    if short_side <= 0:
        return None
    mask = element.get("mask") or {}
    radii = element.get("corner_radii_pt") or mask.get("corner_radii_pt") or []
    radius_pt = element.get("corner_radius_pt")
    if radius_pt is None:
        radius_pt = mask.get("corner_radius_pt")
    if radius_pt is None:
        # An ordinary rectangular fill is a meaningful zero-radius observation.
        radius_pt = max((float(value or 0) for value in radii), default=0.0)
    radius_pt = max(0.0, min(float(radius_pt), short_side / 2))
    return {
        "element_id": element.get("element_id"),
        "corner_radius_pt": round(radius_pt, 2),
        "corner_radius_ratio": round(radius_pt / short_side, 4),
        "short_side_pt": round(short_side, 2),
    }


def summarize_radius_samples(
    samples: list[dict[str, Any]],
    weight: float,
    source: str,
) -> dict[str, Any]:
    weighted = [{**sample, "weight": weight, "source": source} for sample in samples]
    return summarize_weighted_radius_samples(weighted)


def summarize_weighted_radius_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    if not samples:
        return {
            "corner_radius_pt": 0.0,
            "corner_radius_ratio": 0.0,
            "sample_count": 0,
            "weighted_sample_count": 0.0,
            "source": "fallback",
        }
    return {
        "corner_radius_pt": round(_weighted_median(samples, "corner_radius_pt"), 2),
        "corner_radius_ratio": round(_weighted_median(samples, "corner_radius_ratio"), 4),
        "sample_count": len(samples),
        "weighted_sample_count": round(sum(float(item.get("weight") or 1) for item in samples), 2),
        "source": _dominant_source(samples),
    }


def _weighted_median(samples: list[dict[str, Any]], key: str) -> float:
    ordered = sorted(samples, key=lambda item: float(item.get(key) or 0))
    total = sum(float(item.get("weight") or 1) for item in ordered)
    threshold = total / 2
    cumulative = 0.0
    for item in ordered:
        cumulative += float(item.get("weight") or 1)
        if cumulative >= threshold:
            return float(item.get(key) or 0)
    return float(ordered[-1].get(key) or 0)


def _dominant_source(samples: list[dict[str, Any]]) -> str:
    weights: dict[str, float] = {}
    for sample in samples:
        source = str(sample.get("source") or "generic_rectangle")
        weights[source] = weights.get(source, 0.0) + float(sample.get("weight") or 1)
    return max(weights, key=weights.get)
