"""Resolve DrawingML fills and colors with alpha, modifiers, and gradients."""

from __future__ import annotations

import colorsys
from typing import Any

from .colors import _build_theme_map, _normalize_hex

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}

COLOR_NODE_TAGS = frozenset({"schemeClr", "srgbClr", "sysClr", "prstClr", "scrgbClr"})


def resolve_color_node(
    node,
    theme_map: dict,
    *,
    placeholder_color: str | None = None,
) -> dict[str, Any] | None:
    if node is None:
        return None

    tag = node.tag.rsplit("}", 1)[-1]
    base_hex, meta = _base_color(node, tag, theme_map, placeholder_color=placeholder_color)
    if not base_hex:
        return None

    rgb = _hex_to_rgb(base_hex)
    alpha = 1.0
    for child in node:
        child_tag = child.tag.rsplit("}", 1)[-1]
        if child_tag in COLOR_NODE_TAGS:
            continue
        rgb, alpha = _apply_modifier(child_tag, child, rgb, alpha)

    payload: dict[str, Any] = {
        "kind": "solid",
        "color": _rgb_to_hex(*rgb),
        "alpha": round(max(0.0, min(1.0, alpha)), 4),
        **meta,
    }
    return payload


def parse_solid_fill(fill_node, theme_map: dict, *, placeholder_color: str | None = None) -> dict[str, Any] | None:
    if fill_node is None:
        return None
    for child in fill_node:
        if child.tag.rsplit("}", 1)[-1] in COLOR_NODE_TAGS:
            return resolve_color_node(child, theme_map, placeholder_color=placeholder_color)
    return None


def parse_gradient_fill(
    grad_fill_node,
    theme_map: dict,
    *,
    placeholder_color: str | None = None,
) -> dict[str, Any] | None:
    if grad_fill_node is None:
        return None

    stops: list[dict[str, Any]] = []
    gs_list = grad_fill_node.find("a:gsLst", NS)
    stop_nodes = gs_list.findall("a:gs", NS) if gs_list is not None else grad_fill_node.findall(".//a:gs", NS)
    for stop_node in stop_nodes:
        position_raw = stop_node.get("pos")
        try:
            position = round(int(position_raw) / 100000, 5)
        except (TypeError, ValueError):
            position = 0.0
        color_node = next(
            (child for child in stop_node if child.tag.rsplit("}", 1)[-1] in COLOR_NODE_TAGS),
            None,
        )
        if color_node is None:
            continue
        resolved = resolve_color_node(color_node, theme_map, placeholder_color=placeholder_color)
        if not resolved:
            continue
        stops.append({
            "position": position,
            "color": resolved["color"],
            "alpha": resolved.get("alpha", 1.0),
            **({"scheme": resolved["scheme"]} if resolved.get("scheme") else {}),
        })

    if len(stops) < 2:
        return None

    stops.sort(key=lambda item: item["position"])
    lin = grad_fill_node.find("a:lin", NS)
    if lin is not None:
        angle_deg = _linear_gradient_angle_deg(lin.get("ang"))
        return {
            "kind": "linear_gradient",
            "angle_deg": angle_deg,
            "scaled": lin.get("scaled") in {"1", "true", "True"},
            "stops": stops,
        }

    path = grad_fill_node.find("a:path", NS)
    if path is not None:
        fill_to_rect = path.find("a:fillToRect", NS)
        rect = _parse_fill_to_rect(fill_to_rect)
        return {
            "kind": "radial_gradient",
            "path": path.get("path") or "circle",
            "fill_to_rect": rect,
            "stops": stops,
        }

    return {
        "kind": "linear_gradient",
        "angle_deg": 0.0,
        "scaled": False,
        "stops": stops,
    }


def parse_fill_from_sp_pr(sp_pr, theme_map: dict, *, placeholder_color: str | None = None) -> dict[str, Any] | None:
    if sp_pr is None:
        return None
    for fill in sp_pr:
        tag = fill.tag.rsplit("}", 1)[-1]
        if tag == "noFill":
            return {"kind": "none", "alpha": 0.0}
        if tag == "solidFill":
            return parse_solid_fill(fill, theme_map, placeholder_color=placeholder_color)
        if tag == "gradFill":
            return parse_gradient_fill(fill, theme_map, placeholder_color=placeholder_color)
    return None


def parse_fill_from_bg_pr(bg_pr, theme_map: dict) -> dict[str, Any] | None:
    if bg_pr is None:
        return None
    for fill in bg_pr:
        tag = fill.tag.rsplit("}", 1)[-1]
        if tag == "solidFill":
            return parse_solid_fill(fill, theme_map)
        if tag == "gradFill":
            return parse_gradient_fill(fill, theme_map)
    return None


def solid_css_color(fill: dict[str, Any] | None) -> str | None:
    if not fill or fill.get("kind") == "none":
        return None
    color = fill.get("color")
    if not color:
        return None
    alpha = float(fill.get("alpha", 1.0))
    if alpha >= 0.999:
        return color
    if alpha <= 0:
        return "transparent"
    rgb = _hex_to_rgb(color)
    return f"rgba({rgb[0]}, {rgb[1]}, {rgb[2]}, {round(alpha, 4)})"


def primary_fill_color(fill: dict[str, Any] | None) -> str | None:
    if not fill:
        return None
    if fill.get("kind") in {"solid", None} and fill.get("color"):
        return fill["color"]
    stops = fill.get("stops") or []
    if stops:
        return stops[0].get("color")
    return None


def extract_gradient_fills(package, theme: dict) -> list[dict[str, Any]]:
    theme_map = _build_theme_map(theme)
    gradients: dict[tuple, dict[str, Any]] = {}
    parts = (
        package.list("ppt/slides/")
        + package.list("ppt/slideLayouts/")
        + package.list("ppt/slideMasters/")
    )
    for part in parts:
        if not part.endswith(".xml"):
            continue
        root = package.xml(part)
        for grad_node in root.findall(".//a:gradFill", NS):
            parsed = parse_gradient_fill(grad_node, theme_map)
            if not parsed:
                continue
            key = _gradient_key(parsed)
            if key not in gradients:
                gradients[key] = {**parsed, "occurrences": 0, "sources": {}}
            gradients[key]["occurrences"] += 1
            gradients[key]["sources"][part] = gradients[key]["sources"].get(part, 0) + 1
    return sorted(gradients.values(), key=lambda item: (-item["occurrences"], item["kind"]))


def _gradient_key(fill: dict[str, Any]) -> tuple:
    stops = tuple(
        (round(stop.get("position", 0), 4), stop.get("color"), round(float(stop.get("alpha", 1.0)), 4))
        for stop in fill.get("stops") or []
    )
    if fill.get("kind") == "radial_gradient":
        rect = fill.get("fill_to_rect") or {}
        return (
            fill.get("kind"),
            fill.get("path"),
            tuple(sorted(rect.items())),
            stops,
        )
    return (fill.get("kind"), round(float(fill.get("angle_deg") or 0), 2), stops)


def _base_color(node, tag: str, theme_map: dict, *, placeholder_color: str | None) -> tuple[str | None, dict[str, Any]]:
    meta: dict[str, Any] = {}
    if tag == "schemeClr":
        scheme = node.get("val")
        if scheme == "phClr":
            resolved = placeholder_color or theme_map.get("accent1") or theme_map.get("dk1")
            if not resolved:
                return None, meta
            meta["scheme"] = "phClr"
            return resolved, meta
        resolved = theme_map.get(scheme or "")
        if not resolved:
            return None, meta
        meta["type"] = "scheme"
        meta["scheme"] = scheme
        return resolved, meta
    if tag == "srgbClr":
        resolved = _normalize_hex(node.get("val"))
        if not resolved:
            return None, meta
        meta["type"] = "srgb"
        return resolved, meta
    if tag == "sysClr":
        resolved = _normalize_hex(node.get("lastClr") or node.get("val"))
        if not resolved:
            return None, meta
        meta["type"] = "sys"
        return resolved, meta
    if tag == "scrgbClr":
        try:
            r = round(max(0, min(100000, int(node.get("r", "0")))) / 100000 * 255)
            g = round(max(0, min(100000, int(node.get("g", "0")))) / 100000 * 255)
            b = round(max(0, min(100000, int(node.get("b", "0")))) / 100000 * 255)
        except ValueError:
            return None, meta
        meta["type"] = "scrgb"
        return _rgb_to_hex(r, g, b), meta
    return None, meta


def _apply_modifier(tag: str, node, rgb: tuple[int, int, int], alpha: float) -> tuple[tuple[int, int, int], float]:
    value = _modifier_value(node.get("val"))
    r, g, b = rgb
    if tag == "alpha":
        alpha = value
    elif tag == "alphaMod":
        alpha *= value
    elif tag == "alphaOff":
        alpha += value
    elif tag == "tint":
        r = round(r + (255 - r) * value)
        g = round(g + (255 - g) * value)
        b = round(b + (255 - b) * value)
    elif tag == "shade":
        r = round(r * (1 - value))
        g = round(g * (1 - value))
        b = round(b * (1 - value))
    elif tag in {"lumMod", "lumOff", "satMod"}:
        h, lightness, saturation = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
        if tag == "lumMod":
            lightness = max(0.0, min(1.0, lightness * value))
        elif tag == "lumOff":
            lightness = max(0.0, min(1.0, lightness + value))
        elif tag == "satMod":
            saturation = max(0.0, min(1.0, saturation * value))
        r, g, b = (round(channel * 255) for channel in colorsys.hls_to_rgb(h, lightness, saturation))
    return (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b))), alpha


def _modifier_value(raw) -> float:
    if raw is None:
        return 1.0
    try:
        return int(raw) / 100000.0
    except (TypeError, ValueError):
        return 1.0


def _linear_gradient_angle_deg(raw) -> float:
    if raw is None:
        return 0.0
    try:
        # OOXML angle: 0 = left→right, 90° clockwise from that in CSS terms needs conversion
        angle = int(raw) / 60000.0
    except (TypeError, ValueError):
        return 0.0
    # Convert DrawingML angle to CSS linear-gradient angle
    return round((90 - angle) % 360, 2)


def _parse_fill_to_rect(node) -> dict[str, float]:
    if node is None:
        return {"l": 0.5, "t": 0.5, "r": 0.5, "b": 0.5}
    result = {}
    for side in ("l", "t", "r", "b"):
        raw = node.get(side)
        if raw is None:
            result[side] = 0.5
            continue
        try:
            result[side] = round(int(raw) / 100000, 5)
        except (TypeError, ValueError):
            result[side] = 0.5
    return result


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    normalized = _normalize_hex(value) or "#000000"
    return (
        int(normalized[1:3], 16),
        int(normalized[3:5], 16),
        int(normalized[5:7], 16),
    )


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{max(0, min(255, r)):02X}{max(0, min(255, g)):02X}{max(0, min(255, b)):02X}"
