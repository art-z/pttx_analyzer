"""Apply catalog fill payloads (solid, linear/radial gradients) to PPTX shapes and cells."""

from __future__ import annotations

from typing import Any

from pptx.dml.color import RGBColor
from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn

FILL_TAGS = ("a:noFill", "a:solidFill", "a:gradFill", "a:pattFill", "a:blipFill", "a:grpFill")


def parse_hex_color(value: str | None) -> RGBColor | None:
    if not value or not isinstance(value, str):
        return None
    cleaned = value.strip().lstrip("#")
    if len(cleaned) == 6:
        return RGBColor(int(cleaned[0:2], 16), int(cleaned[2:4], 16), int(cleaned[4:6], 16))
    return None


def resolve_color(value: Any) -> RGBColor | None:
    if isinstance(value, str):
        return parse_hex_color(value)
    if isinstance(value, dict):
        return parse_hex_color(value.get("color"))
    return None


def _hex_from_color(value: Any) -> str | None:
    if isinstance(value, str):
        cleaned = value.strip().lstrip("#")
        return cleaned.upper() if len(cleaned) == 6 else None
    if isinstance(value, dict):
        return _hex_from_color(value.get("color"))
    return None


def _fill_parent(element) -> Any:
    if hasattr(element, "_tc"):
        return element._tc.get_or_add_tcPr()
    return element._element.spPr


def _remove_fill_nodes(parent) -> None:
    for tag in FILL_TAGS:
        node = parent.find(qn(tag))
        if node is not None:
            parent.remove(node)


def _catalog_angle_to_lin_ang_raw(angle_deg: float | None) -> int:
    ooxml_deg = (90.0 - float(angle_deg or 0.0)) % 360.0
    return int(round(ooxml_deg * 60000))


def _rect_attr(value: float | None, default: float = 0.5) -> int:
    return int(round(float(value if value is not None else default) * 100000))


def _gradient_stop_xml(stop: dict[str, Any]) -> str:
    color_hex = _hex_from_color(stop.get("color"))
    if not color_hex:
        return ""
    position = max(0.0, min(1.0, float(stop.get("position") or 0.0)))
    pos_raw = int(round(position * 100000))
    alpha = float(stop.get("alpha", 1.0))
    alpha_xml = ""
    if alpha < 0.999:
        alpha_xml = f'<a:alpha val="{int(round(alpha * 100000))}"/>'
    return (
        f'<a:gs pos="{pos_raw}">'
        f'<a:srgbClr val="{color_hex}">{alpha_xml}</a:srgbClr>'
        f"</a:gs>"
    )


def build_grad_fill_xml(fill: dict[str, Any]) -> str | None:
    stops = fill.get("stops") or []
    stop_xml = "".join(_gradient_stop_xml(stop) for stop in stops)
    if stop_xml.count("<a:gs") < 2:
        return None

    kind = fill.get("kind")
    if kind == "radial_gradient":
        rect = fill.get("fill_to_rect") or {}
        path = fill.get("path") or "circle"
        vector_xml = (
            f'<a:path path="{path}">'
            f'<a:fillToRect l="{_rect_attr(rect.get("l"))}" t="{_rect_attr(rect.get("t"))}" '
            f'r="{_rect_attr(rect.get("r"))}" b="{_rect_attr(rect.get("b"))}"/>'
            f"</a:path>"
        )
    else:
        scaled = "1" if fill.get("scaled") else "0"
        vector_xml = (
            f'<a:lin ang="{_catalog_angle_to_lin_ang_raw(fill.get("angle_deg"))}" scaled="{scaled}"/>'
        )

    return (
        f'<a:gradFill {nsdecls("a")} rotWithShape="1">'
        f"<a:gsLst>{stop_xml}</a:gsLst>"
        f"{vector_xml}"
        f"</a:gradFill>"
    )


def build_solid_color_fill_xml(color: Any) -> str | None:
    """Build a:solidFill XML from a catalog color or fill payload."""
    if isinstance(color, str):
        hex_val = _hex_from_color(color)
        if not hex_val:
            return None
        return f'<a:solidFill><a:srgbClr val="{hex_val}"/></a:solidFill>'

    if not isinstance(color, dict):
        return None

    if color.get("kind") == "none":
        return None

    alpha = float(color.get("alpha", 1.0))
    if alpha <= 0:
        return None

    alpha_xml = ""
    if alpha < 0.999:
        alpha_xml = f'<a:alpha val="{int(round(alpha * 100000))}"/>'

    scheme = color.get("scheme")
    if color.get("type") == "scheme" and scheme:
        return f'<a:solidFill><a:schemeClr val="{scheme}">{alpha_xml}</a:schemeClr></a:solidFill>'

    hex_val = _hex_from_color(color.get("color"))
    if not hex_val:
        return None
    return f'<a:solidFill><a:srgbClr val="{hex_val}">{alpha_xml}</a:srgbClr></a:solidFill>'


def apply_catalog_fill(element, fill: dict[str, Any] | None) -> None:
    if not fill or fill.get("kind") == "none" or (fill.get("alpha") is not None and fill.get("alpha") <= 0):
        element.fill.background()
        return

    kind = fill.get("kind")
    if kind in {None, "solid"} and fill.get("color"):
        color = resolve_color(fill.get("color"))
        if color is None:
            element.fill.background()
            return
        element.fill.solid()
        element.fill.fore_color.rgb = color
        return

    if kind in {"linear_gradient", "radial_gradient"}:
        grad_xml = build_grad_fill_xml(fill)
        if not grad_xml:
            element.fill.background()
            return
        parent = _fill_parent(element)
        _remove_fill_nodes(parent)
        parent.append(parse_xml(grad_xml))
        return

    color = resolve_color(fill)
    if color is not None:
        element.fill.solid()
        element.fill.fore_color.rgb = color
        return
    element.fill.background()
