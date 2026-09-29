"""Infer deck-wide content margins from slide element geometry."""

from __future__ import annotations

from statistics import median

MIN_ELEMENT_WIDTH_NORM = 0.01
MIN_ELEMENT_HEIGHT_NORM = 0.005
MIN_MARGIN_NORM = 0.012
DEFAULT_BOTTOM_MARGIN_NORM = 0.04
BACKGROUND_AREA_NORM = 0.55
BACKGROUND_ORIGIN_NORM = 0.08
TITLE_ZONE_MAX_Y = 0.22
TITLE_FALLBACK_MAX_Y = 0.18
TITLE_FALLBACK_MIN_WIDTH = 0.45
MAX_TITLE_CONTENT_GAP_NORM = 0.28


def _is_background_like(element: dict) -> bool:
    geom = element.get("geometry_norm") or {}
    width = float(geom.get("width") or 0)
    height = float(geom.get("height") or 0)
    area = width * height
    if area < BACKGROUND_AREA_NORM:
        return False
    origin_x = float(geom.get("x") or 0)
    origin_y = float(geom.get("y") or 0)
    if origin_x > BACKGROUND_ORIGIN_NORM or origin_y > BACKGROUND_ORIGIN_NORM:
        return False
    kind = element.get("kind")
    if kind in {"image", "shape", "graphic"}:
        return True
    return area > 0.92


def _content_geometry(slide: dict) -> list[dict]:
    geometry: list[dict] = []
    for element in slide.get("content_elements") or []:
        if _is_background_like(element):
            continue
        geom = element.get("geometry_norm")
        if not geom:
            continue
        width = float(geom.get("width") or 0)
        height = float(geom.get("height") or 0)
        if width < MIN_ELEMENT_WIDTH_NORM or height < MIN_ELEMENT_HEIGHT_NORM:
            continue
        geometry.append(geom)
    return geometry


def _title_candidate(element: dict, *, fallback: bool = False) -> bool:
    if element.get("kind") != "text":
        return False
    geom = element.get("geometry_norm") or {}
    y = float(geom.get("y") or 1)
    if y >= TITLE_ZONE_MAX_Y:
        return False
    role = str(
        element.get("placeholder_type")
        or element.get("text_role")
        or element.get("role")
        or element.get("name")
        or ""
    ).lower()
    if role in {"title", "ctrtitle", "ctr_title"}:
        return True
    return fallback and y < TITLE_FALLBACK_MAX_Y and float(geom.get("width") or 0) >= TITLE_FALLBACK_MIN_WIDTH


def _title_content_spacing(slide: dict) -> tuple[float, float] | None:
    elements = list(slide.get("content_elements") or [])
    titles = [element for element in elements if _title_candidate(element)]
    if not titles:
        titles = [element for element in elements if _title_candidate(element, fallback=True)]
    if not titles:
        return None
    title = max(
        titles,
        key=lambda item: float((item.get("geometry_norm") or {}).get("width") or 0)
        * float((item.get("geometry_norm") or {}).get("height") or 0),
    )
    title_geom = title.get("geometry_norm") or {}
    title_bottom = float(title_geom.get("y") or 0) + float(title_geom.get("height") or 0)
    content_tops: list[float] = []
    for element in elements:
        if element is title or _is_background_like(element):
            continue
        geom = element.get("geometry_norm") or {}
        width = float(geom.get("width") or 0)
        height = float(geom.get("height") or 0)
        top = float(geom.get("y") or 0)
        if width < MIN_ELEMENT_WIDTH_NORM or height < MIN_ELEMENT_HEIGHT_NORM:
            continue
        if top >= title_bottom:
            content_tops.append(top)
    if not content_tops:
        return None
    gap = min(content_tops) - title_bottom
    if gap < 0 or gap > MAX_TITLE_CONTENT_GAP_NORM:
        return None
    return title_bottom, gap


def analyze_content_margins(
    slides: list[dict] | None,
    slide_size_pt: dict[str, float] | None,
) -> dict:
    width_pt = float((slide_size_pt or {}).get("width") or 0)
    height_pt = float((slide_size_pt or {}).get("height") or 0)

    left_norms: list[float] = []
    top_norms: list[float] = []
    right_gaps: list[float] = []
    bottom_gaps: list[float] = []
    title_bottoms: list[float] = []
    title_content_gaps: list[float] = []

    for slide in slides or []:
        geometry = _content_geometry(slide)
        if not geometry:
            continue
        left_norms.append(min(float(item.get("x") or 0) for item in geometry))
        top_norms.append(min(float(item.get("y") or 0) for item in geometry))
        right_gaps.append(1 - max(float(item.get("x") or 0) + float(item.get("width") or 0) for item in geometry))
        bottom_gaps.append(1 - max(float(item.get("y") or 0) + float(item.get("height") or 0) for item in geometry))
        title_spacing = _title_content_spacing(slide)
        if title_spacing:
            title_bottoms.append(title_spacing[0])
            title_content_gaps.append(title_spacing[1])

    left_norm = _median(left_norms)
    top_norm = _median(top_norms)
    right_norm = _median(right_gaps)
    observed_bottom_norm = _median(bottom_gaps)
    title_bottom_norm = _median(title_bottoms)
    title_content_gap_norm = _median(title_content_gaps)

    style_margin_norm = _median([value for value in (top_norm, left_norm) if value is not None])
    if style_margin_norm is None:
        style_margin_norm = DEFAULT_BOTTOM_MARGIN_NORM

    bottom_norm = max(
        style_margin_norm,
        observed_bottom_norm or 0.0,
        MIN_MARGIN_NORM,
    )

    return {
        "left_norm": _round_norm(left_norm),
        "top_norm": _round_norm(top_norm),
        "right_norm": _round_norm(right_norm),
        "bottom_norm": round(bottom_norm, 4),
        "left_pt": _round_pt(left_norm, width_pt),
        "top_pt": _round_pt(top_norm, height_pt),
        "right_pt": _round_pt(right_norm, width_pt),
        "bottom_pt": _round_pt(bottom_norm, height_pt),
        "title_bottom_norm": _round_norm(title_bottom_norm),
        "title_content_gap_norm": _round_norm(title_content_gap_norm),
        "title_bottom_pt": _round_pt(title_bottom_norm, height_pt),
        "title_content_gap_pt": _round_pt(title_content_gap_norm, height_pt),
        "title_gap_slide_count": len(title_content_gaps),
        "slide_count_analyzed": len(left_norms),
        "source": "content_bbox_median",
    }


def apply_content_margins_to_slides(slide_catalog: dict | None, content_margins: dict | None) -> None:
    if not slide_catalog or not content_margins:
        return

    bottom_pt = content_margins.get("bottom_pt")
    bottom_norm = content_margins.get("bottom_norm")
    if not bottom_pt and not bottom_norm:
        return

    for slide in slide_catalog.get("slides") or []:
        render = slide.setdefault("render", {})
        render["content_margins"] = content_margins
        slide_height_pt = float((render.get("slide_size_pt") or {}).get("height") or 0)
        effective_bottom_pt = bottom_pt
        if not effective_bottom_pt and bottom_norm and slide_height_pt:
            effective_bottom_pt = round(bottom_norm * slide_height_pt, 2)
        if not effective_bottom_pt:
            continue

        for element in slide.get("content_elements") or []:
            if element.get("kind") != "table" and not element.get("table"):
                continue
            table = element.setdefault("table", {})
            y_pt = float((element.get("geometry_pt") or {}).get("y_pt") or 0)
            if slide_height_pt:
                available = round(max(slide_height_pt - y_pt - effective_bottom_pt, 0), 2)
                table["content_bottom_margin_pt"] = effective_bottom_pt
                table["available_height_pt"] = available
                if bottom_norm is not None:
                    table["content_bottom_margin_norm"] = bottom_norm


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    return float(median(values))


def _round_norm(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 4)


def _round_pt(norm: float | None, slide_axis_pt: float) -> float | None:
    if norm is None or not slide_axis_pt:
        return None
    return round(norm * slide_axis_pt, 2)
