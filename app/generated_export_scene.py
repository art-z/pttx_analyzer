"""Format-neutral, editable scene for generated slide export."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .graphic_style_materialization import materialize_graphic_styles

GENERATED_SCENE_VERSION = 1


def _box_from_norm(box: dict[str, Any] | None, slide_size: dict[str, Any]) -> dict[str, float] | None:
    if not box:
        return None
    try:
        x = float(box.get("x"))
        y = float(box.get("y"))
        width = float(box.get("width"))
        height = float(box.get("height"))
        slide_width = float(slide_size.get("width"))
        slide_height = float(slide_size.get("height"))
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0 or slide_width <= 0 or slide_height <= 0:
        return None
    return {
        "x_pt": x * slide_width,
        "y_pt": y * slide_height,
        "width_pt": width * slide_width,
        "height_pt": height * slide_height,
    }


def _sync_scene_geometry(slide: dict[str, Any], slide_size: dict[str, Any]) -> dict[str, Any]:
    next_slide = deepcopy(slide)
    render = next_slide.setdefault("render", {})
    synced_layers = []
    for layer in render.get("layers") or []:
        next_layer = dict(layer)
        geometry_pt = _box_from_norm(layer.get("geometry_norm"), slide_size)
        if geometry_pt:
            next_layer["geometry_pt"] = {**(layer.get("geometry_pt") or {}), **geometry_pt}
        synced_layers.append(next_layer)
    render["layers"] = synced_layers

    synced_elements = []
    for element in next_slide.get("content_elements") or []:
        next_element = dict(element)
        geometry_pt = _box_from_norm(element.get("geometry_norm"), slide_size)
        if geometry_pt:
            next_element["geometry_pt"] = {**(element.get("geometry_pt") or {}), **geometry_pt}
        text_group_geometry_pt = _box_from_norm(element.get("text_group_geometry_norm"), slide_size)
        if text_group_geometry_pt:
            next_element["text_group_geometry_pt"] = {
                **(element.get("text_group_geometry_pt") or {}),
                **text_group_geometry_pt,
            }
        synced_elements.append(next_element)
    next_slide["content_elements"] = synced_elements
    return next_slide


def build_generated_export_scene(
    report: dict[str, Any], title: str, slides: list[dict[str, Any]],
) -> dict[str, Any]:
    """Preserve slide primitives so PPTX, HTML and PDF adapters share one input."""
    slide_size = (
        (report.get("typography") or {}).get("visibility", {}).get("slide_size_pt")
        or {"width": 960, "height": 540}
    )
    selected = []
    for index, source in enumerate(slides, start=1):
        # The browser preview has already resolved graphic colors. Older API
        # clients still get report-level fallback styling once on the server.
        if source.get("export_scene_version") == GENERATED_SCENE_VERSION:
            slide = deepcopy(source)
        else:
            slide = materialize_graphic_styles(report, source)
        slide["export_scene_version"] = GENERATED_SCENE_VERSION
        slide["slide_number"] = index
        slide.setdefault("render", {}).setdefault("slide_size_pt", slide_size)
        slide = _sync_scene_geometry(slide, slide["render"]["slide_size_pt"])
        selected.append(slide)

    return {
        "version": GENERATED_SCENE_VERSION,
        "title": title,
        "slide_size_pt": slide_size,
        "slides": selected,
    }
