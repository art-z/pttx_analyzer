"""Parse shape outline (a:ln) from DrawingML."""

from __future__ import annotations

from typing import Any

from .fill_styles import parse_solid_fill

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
EMU_PER_PT = 12700
DEFAULT_STROKE_WIDTH_PT = 0.75
# DrawingML headEnd/tailEnd w/len are multiples of line width (Office/Google Slides).
_ARROW_LENGTH_FACTOR = {"sm": 2.5, "med": 3.5, "lg": 5.0}
_ARROW_WIDTH_FACTOR = {"sm": 2.0, "med": 3.0, "lg": 4.0}


def parse_shape_stroke(sp_pr, theme_map: dict) -> dict[str, Any] | None:
    if sp_pr is None:
        return None
    line = sp_pr.find("a:ln", NS)
    if line is None or line.find("a:noFill", NS) is not None:
        return None

    color = _line_color(line, theme_map)
    if color is None:
        return None

    dash_node = line.find("a:prstDash", NS)
    payload: dict[str, Any] = {
        "width_pt": _line_width_pt(line),
        "color": color,
        "dash": dash_node.get("val") if dash_node is not None else "solid",
    }
    cap = line.get("cap")
    if cap:
        payload["cap"] = cap
    compound = line.get("cmpd")
    if compound:
        payload["compound"] = compound
    head = _parse_arrow_end(line.find("a:headEnd", NS), payload["width_pt"])
    tail = _parse_arrow_end(line.find("a:tailEnd", NS), payload["width_pt"])
    if head:
        payload["head"] = head
    if tail:
        payload["tail"] = tail
    return payload


def arrow_end_size_pt(line_width_pt: float, end: dict[str, Any] | None) -> dict[str, float] | None:
    if not end or end.get("type") in {None, "none"}:
        return None
    length_key = end.get("length") or "med"
    width_key = end.get("width") or length_key
    length_factor = _ARROW_LENGTH_FACTOR.get(length_key, _ARROW_LENGTH_FACTOR["med"])
    width_factor = _ARROW_WIDTH_FACTOR.get(width_key, _ARROW_WIDTH_FACTOR["med"])
    return {
        "length_pt": round(line_width_pt * length_factor, 2),
        "width_pt": round(line_width_pt * width_factor, 2),
    }


def _parse_arrow_end(node, line_width_pt: float) -> dict[str, Any] | None:
    if node is None:
        return None
    arrow_type = node.get("type")
    if not arrow_type or arrow_type == "none":
        return None
    payload: dict[str, Any] = {"type": arrow_type}
    width = node.get("w")
    length = node.get("len")
    if width:
        payload["width"] = width
    if length:
        payload["length"] = length
    size_pt = arrow_end_size_pt(line_width_pt, payload)
    if size_pt:
        payload["size_pt"] = size_pt
    return payload


def _line_width_pt(line) -> float:
    width = line.get("w")
    if width is None:
        return DEFAULT_STROKE_WIDTH_PT
    try:
        return round(int(width) / EMU_PER_PT, 2)
    except ValueError:
        return DEFAULT_STROKE_WIDTH_PT


def _line_color(line, theme_map: dict) -> dict | None:
    solid = line.find("a:solidFill", NS)
    if solid is None:
        return None
    return parse_solid_fill(solid, theme_map)
