"""Parse shape geometry used as image clip masks from DrawingML."""

from __future__ import annotations

import math

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


DEFAULT_ROUND_RECT_ADJ = 0.16667
DEFAULT_ROUND_ADJ2 = 0.0

# DrawingML presets whose corner size is adj × min(width, height) (values in 0..1).
ROUND_CORNER_PRESETS = frozenset({"roundRect", "round1Rect", "round2SameRect", "round2DiagRect"})


def corner_radius_pt(adj: float, width_pt: float, height_pt: float) -> float:
    """OOXML roundRect: corner radius = adj × min(width, height)."""
    if width_pt <= 0 or height_pt <= 0:
        return 0.0
    return round(adj * min(width_pt, height_pt), 2)


def _short_side_pt(width_pt: float, height_pt: float) -> float:
    if width_pt <= 0 or height_pt <= 0:
        return 0.0
    return min(width_pt, height_pt)


def corner_radii_pt(
    preset: str,
    width_pt: float,
    height_pt: float,
    *,
    adj1: float,
    adj2: float = 0.0,
) -> list[float]:
    """Return [tl, tr, br, bl] corner radii in pt (CSS border-radius order).

    Values follow DrawingML preset geometry: adj × min(width, height), no heuristics.
    """
    ss = _short_side_pt(width_pt, height_pt)
    if ss <= 0:
        return [0.0, 0.0, 0.0, 0.0]

    a1 = adj1 * ss
    a2 = adj2 * ss

    if preset == "roundRect":
        radii = [a1, a1, a1, a1]
    elif preset == "round1Rect":
        radii = [0.0, 0.0, a1, 0.0]
    elif preset == "round2SameRect":
        radii = [a1, a2, a2, a1]
    elif preset == "round2DiagRect":
        radii = [a1, a2, a1, a2]
    else:
        radii = [0.0, 0.0, 0.0, 0.0]

    return [round(value, 2) for value in radii]


def apply_mask_geometry(mask: dict, geometry_pt: dict | None) -> dict:
    """Attach absolute corner radii when block geometry is known."""
    result = dict(mask)
    if not geometry_pt:
        return result
    width_pt = geometry_pt.get("width_pt") or 0
    height_pt = geometry_pt.get("height_pt") or 0
    preset = result.get("kind")
    if preset not in ROUND_CORNER_PRESETS:
        return result

    adj1 = result.get("adj1", result.get("adj", DEFAULT_ROUND_RECT_ADJ))
    adj2 = result.get("adj2", DEFAULT_ROUND_ADJ2)
    radii = corner_radii_pt(preset, width_pt, height_pt, adj1=adj1, adj2=adj2)
    result["corner_radii_pt"] = radii
    result["corner_radius_pt"] = max(radii) if any(radii) else 0.0
    return result


def parse_shape_mask(sp_pr) -> dict | None:
    if sp_pr is None:
        return None
    prst_geom = sp_pr.find("a:prstGeom", NS)
    if prst_geom is not None:
        return _parse_preset_mask(prst_geom)
    cust_geom = sp_pr.find("a:custGeom", NS)
    if cust_geom is not None:
        return _parse_custom_mask(cust_geom)
    return None


def _parse_preset_mask(prst_geom) -> dict | None:
    preset = prst_geom.get("prst") or "rect"
    if preset == "rect":
        return None
    if preset == "ellipse":
        return {"kind": "ellipse"}
    if preset in ROUND_CORNER_PRESETS:
        adjustments = _parse_adjustments(prst_geom)
        adj1 = adjustments.get("adj1", adjustments.get("adj", DEFAULT_ROUND_RECT_ADJ))
        adj2 = adjustments.get("adj2", DEFAULT_ROUND_ADJ2)
        payload: dict = {
            "kind": preset,
            "adj1": adj1,
            "radius_pct": round(adj1 * 100, 4),
        }
        if preset == "roundRect":
            payload["adj"] = adj1
        elif preset in {"round2SameRect", "round2DiagRect"}:
            payload["adj2"] = adj2
            payload["radius_pct2"] = round(adj2 * 100, 4)
        elif preset == "round1Rect":
            payload["adj"] = adj1
        return payload
    path = _PRESET_PATHS.get(preset)
    if path:
        return {"kind": "path", "path": path}
    return {"kind": "preset", "preset": preset}


def _parse_adjustments(prst_geom) -> dict[str, float]:
    values: dict[str, float] = {}
    av_lst = prst_geom.find("a:avLst", NS)
    if av_lst is None:
        return values
    for gd in av_lst.findall("a:gd", NS):
        name = gd.get("name")
        if not name:
            continue
        fmla = gd.get("fmla") or ""
        if fmla.startswith("val "):
            try:
                values[name] = int(fmla.split()[1]) / 100000.0
            except (IndexError, ValueError):
                continue
    return values


def _parse_custom_mask(cust_geom) -> dict | None:
    path_lst = cust_geom.find("a:pathLst", NS)
    if path_lst is None:
        return None
    segments: list[str] = []
    for path in path_lst.findall("a:path", NS):
        path_w = max(int(path.get("w", 0) or 0), 1)
        path_h = max(int(path.get("h", 0) or 0), 1)
        commands = _path_commands(path, path_w, path_h)
        if commands:
            segments.extend(commands)
    if not segments:
        return None
    path = " ".join(segments)
    if _is_rect_path(path):
        return None
    return {"kind": "path", "path": path}


def _is_rect_path(path: str) -> bool:
    normalized = " ".join(path.upper().split())
    return normalized in {
        "M 0 0 L 1 0 L 1 1 L 0 1 Z",
        "M 0.0 0.0 L 1.0 0.0 L 1.0 1.0 L 0.0 1.0 Z",
    }


def _path_commands(path, path_w: int, path_h: int) -> list[str]:
    commands: list[str] = []
    current_x = 0.0
    current_y = 0.0
    start_x = 0.0
    start_y = 0.0

    for child in path:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "moveTo":
            current_x, current_y = _point_xy(child, path_w, path_h)
            start_x, start_y = current_x, current_y
            commands.append(f"M {current_x} {current_y}")
            continue
        if tag == "lnTo":
            current_x, current_y = _point_xy(child, path_w, path_h)
            commands.append(f"L {current_x} {current_y}")
            continue
        if tag == "quadBezTo":
            points = [_point_xy(pt, path_w, path_h) for pt in child.findall("a:pt", NS)]
            if len(points) >= 2:
                commands.append(
                    "Q "
                    + " ".join(f"{x} {y}" for x, y in points[:2])
                )
                current_x, current_y = points[1]
            continue
        if tag == "cubicBezTo":
            points = [_point_xy(pt, path_w, path_h) for pt in child.findall("a:pt", NS)]
            if len(points) >= 3:
                commands.append(
                    "C "
                    + " ".join(f"{x} {y}" for x, y in points[:3])
                )
                current_x, current_y = points[2]
            continue
        if tag == "arcTo":
            current_x, current_y = _arc_to_command(child, path_w, path_h, current_x, current_y, commands)
            continue
        if tag == "close":
            commands.append("Z")
            current_x, current_y = start_x, start_y
    return commands


def _point_xy(node, path_w: int, path_h: int) -> tuple[float, float]:
    tag = node.tag.rsplit("}", 1)[-1]
    pt = node if tag == "pt" else node.find("a:pt", NS)
    if pt is None:
        return 0.0, 0.0
    try:
        x = int(pt.get("x", 0)) / path_w
        y = int(pt.get("y", 0)) / path_h
    except (TypeError, ValueError):
        return 0.0, 0.0
    return round(x, 5), round(y, 5)


def _arc_to_command(node, path_w: int, path_h: int, current_x: float, current_y: float, commands: list[str]) -> tuple[float, float]:
    try:
        w_r = int(node.get("wR", 0)) / path_w
        h_r = int(node.get("hR", 0)) / path_h
        start_angle = int(node.get("stAng", 0)) / 60000.0
        swing_angle = int(node.get("swAng", 0)) / 60000.0
    except (TypeError, ValueError):
        return current_x, current_y

    end_angle = start_angle + swing_angle
    center_x = current_x - w_r * math.cos(math.radians(start_angle))
    center_y = current_y - h_r * math.sin(math.radians(start_angle))
    end_x = center_x + w_r * math.cos(math.radians(end_angle))
    end_y = center_y + h_r * math.sin(math.radians(end_angle))
    large_arc = 1 if abs(swing_angle) > 180 else 0
    sweep = 1 if swing_angle >= 0 else 0
    commands.append(
        "A "
        f"{round(w_r, 5)} {round(h_r, 5)} 0 {large_arc} {sweep} "
        f"{round(end_x, 5)} {round(end_y, 5)}"
    )
    return end_x, end_y


_PRESET_PATHS = {
    "triangle": "M 0.5 0 L 1 1 L 0 1 Z",
    "rtTriangle": "M 0 0 L 1 1 L 0 1 Z",
    "parallelogram": "M 0.25 0 L 1 0 L 0.75 1 L 0 1 Z",
    "trapezoid": "M 0.2 0 L 0.8 0 L 1 1 L 0 1 Z",
    "diamond": "M 0.5 0 L 1 0.5 L 0.5 1 L 0 0.5 Z",
    "pentagon": "M 0.5 0 L 1 0.38 L 0.82 1 L 0.18 1 L 0 0.38 Z",
    "hexagon": "M 0.25 0 L 0.75 0 L 1 0.5 L 0.75 1 L 0.25 1 L 0 0.5 Z",
    "octagon": "M 0.3 0 L 0.7 0 L 1 0.3 L 1 0.7 L 0.7 1 L 0.3 1 L 0 0.7 L 0 0.3 Z",
    "star5": "M 0.5 0 L 0.63 0.38 L 1 0.38 L 0.69 0.62 L 0.82 1 L 0.5 0.76 L 0.18 1 L 0.31 0.62 L 0 0.38 L 0.37 0.38 Z",
    "heart": "M 0.5 0.25 C 0.5 0.1 0.35 0 0.2 0 0 0 0 0.2 0.5 0.55 1 0.2 1 0 0.85 0 0.5 0.25 0.5 1 Z",
}
