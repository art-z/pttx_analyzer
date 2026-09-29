"""Port of frontend slide-layer-filter.js for export parity."""

from __future__ import annotations

SYSTEM_PLACEHOLDER_TYPES = frozenset({"dt", "sldNum", "ftr", "hdr"})
EDITABLE_PLACEHOLDER_TYPES = frozenset({"title", "ctrTitle", "subTitle", "body", "obj", "content"})


def is_design_glyph_text(text: str | None) -> bool:
    trimmed = (text or "").strip()
    return 0 < len(trimmed) <= 2


def slide_has_content_elements(slide: dict) -> bool:
    return bool(slide.get("content_elements"))


def slide_covers_placeholder(slide: dict, placeholder_type: str | None) -> bool:
    if not placeholder_type:
        return False
    return any(
        element.get("placeholder_type") == placeholder_type
        for element in slide.get("content_elements") or []
    )


def should_render_slide_layer(layer: dict, slide: dict) -> bool:
    if not layer.get("decorative"):
        return True
    if layer.get("kind") != "text":
        return True
    if is_design_glyph_text(layer.get("text")):
        return True

    scope = layer.get("source_scope")
    if scope not in {"master", "layout"}:
        return True
    if not slide_has_content_elements(slide):
        return True
    if layer.get("placeholder_type") in SYSTEM_PLACEHOLDER_TYPES:
        return False
    if slide_covers_placeholder(slide, layer.get("placeholder_type")):
        return False
    return False


def filter_slide_render_layers(layers: list[dict] | None, slide: dict) -> list[dict]:
    return [layer for layer in (layers or []) if should_render_slide_layer(layer, slide)]
