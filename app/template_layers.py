"""Extract ordered visual layers from slide master/layout for faithful previews."""

from __future__ import annotations

import copy
import posixpath
from collections import Counter
from typing import Any

from .colors import _build_theme_map, _normalize_hex
from .fill_styles import (
    parse_fill_from_sp_pr,
    parse_gradient_fill,
    parse_solid_fill,
    primary_fill_color,
    resolve_color_node,
)
from .graphic_elements import (
    apply_table_intrinsic_geometry,
    parse_chart_element,
    parse_diagram_element,
    parse_table_element,
)
from .line_height import line_height_applicable
from .metric_text import attach_metric_fields, paragraph_is_metric, paragraph_metric_display_text, segments_form_metric
from .text_group_spacing import compute_text_group_spacing_pt
from .pptx import PPTXPackage
from .shape_mask import apply_mask_geometry, parse_shape_mask
from .shape_stroke import DEFAULT_STROKE_WIDTH_PT, parse_shape_stroke
from .text_slots import (
    LAYOUT_REL,
    MASTER_REL,
    _body_properties,
    _match_placeholder,
    _text_shapes,
    effective_run_typography,
    resolve_shape_text_levels,
)
from .slide_geometry import shape_geometry

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
MASTER_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
THEME_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
EDITABLE_PLACEHOLDER_TYPES = frozenset({"title", "ctrTitle", "subTitle", "body", "obj"})
SYSTEM_PLACEHOLDER_TYPES = frozenset({"ftr", "hdr", "dt", "sldNum"})
EMU_PER_PT = 12700


def build_template_render(
    package: PPTXPackage,
    layout_source: str,
    master_source: str | None,
    slide_size: tuple[float, float],
    theme: dict,
) -> dict:
    slide_width, slide_height = slide_size
    slide_width_emu = slide_width * EMU_PER_PT
    slide_height_emu = slide_height * EMU_PER_PT

    fallback_theme_map = _build_theme_map(theme)
    theme_maps_by_source = _build_theme_maps_by_source(theme)

    master_theme_source = _part_related_to(package, master_source, THEME_REL) if master_source else None
    theme_map = theme_maps_by_source.get(master_theme_source or "") or fallback_theme_map

    theme_fonts = _theme_fonts(theme, master_theme_source=master_theme_source)

    layers: list[dict] = []
    z_index = 0

    for source_kind, part in (("master", master_source), ("layout", layout_source)):
        if not part:
            continue
        bg_layer = _background_layer(package, part, source_kind, slide_size, theme_map, z_index)
        if bg_layer:
            layers.append(bg_layer)
            z_index += 1
        z_index = _collect_sp_tree_layers(
            package,
            part,
            source_kind,
            slide_width_emu,
            slide_height_emu,
            theme_map,
            theme_fonts,
            theme,
            layers,
            z_index,
        )

    background_color = _resolve_background_color(layers, theme_map)
    return {
        "slide_size_pt": {"width": slide_width, "height": slide_height},
        "background_color": background_color,
        "layers": layers,
    }


def apply_slide_background_override(
    package: PPTXPackage,
    slide_part: str,
    render: dict,
    slide_size: tuple[float, float],
    theme: dict,
) -> dict:
    """Replace master/layout background layers when the slide defines its own p:bg."""
    theme_map = _build_theme_map(theme)
    slide_bg = _background_layer(package, slide_part, "slide", slide_size, theme_map, 0)
    if not slide_bg:
        return render

    updated = copy.deepcopy(render)
    layers = [
        layer
        for layer in updated.get("layers", [])
        if not (layer.get("source_scope") or "").endswith("_bg")
    ]
    layers.insert(0, slide_bg)
    for index, layer in enumerate(layers):
        layer["z_index"] = index
    updated["layers"] = layers
    updated["background_color"] = _resolve_background_color(layers, theme_map)
    return updated


def _resolve_background_color(layers: list[dict], theme_map: dict) -> str | None:
    for layer in reversed(layers):
        if layer.get("kind") != "fill":
            continue

        if not (layer.get("source_scope") or "").endswith("_bg"):
            continue

        color = primary_fill_color(layer.get("fill"))
        if color:
            return color

    return theme_map.get("lt1") or theme_map.get("dk1") or "#FFFFFF"


def _build_theme_maps_by_source(theme: dict) -> dict[str, dict]:
    result: dict[str, dict] = {}

    for item in theme.get("themes", []):
        source = item.get("source")
        if not source:
            continue

        theme_colors = item.get("colors", {})
        theme_map = {}

        for name, color in theme_colors.items():
            if not isinstance(color, dict):
                continue

            color_type = color.get("type")
            value = color.get("value")

            if not value:
                continue

            if color_type in {"srgbClr", "sysClr"}:
                resolved = _normalize_hex(value)
                if resolved:
                    theme_map[name] = resolved

        for alias, base in (
            ("tx1", "dk1"),
            ("tx2", "dk2"),
            ("bg1", "lt1"),
            ("bg2", "lt2"),
        ):
            if alias not in theme_map and base in theme_map:
                theme_map[alias] = theme_map[base]

        result[source] = theme_map

    return result

def _background_layer(
    package: PPTXPackage,
    part: str,
    source_kind: str,
    slide_size: tuple[float, float],
    theme_map: dict,
    z_index: int,
) -> dict | None:
    root = package.xml(part)
    c_sld = root.find("p:cSld", NS)
    if c_sld is None:
        return None

    bg = c_sld.find("p:bg", NS)
    if bg is None:
        return None

    width_pt, height_pt = slide_size
    full_norm = {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
    full_pt = {"x_pt": 0.0, "y_pt": 0.0, "width_pt": width_pt, "height_pt": height_pt}

    bg_ref = bg.find("p:bgRef", NS)
    if bg_ref is not None:
        parsed_fill = _background_ref_fill(bg_ref, theme_map)
        if parsed_fill and parsed_fill.get("kind") != "none":
            return {
                "layer_id": f"{source_kind}_bg_fill",
                "kind": "fill",
                "source_scope": f"{source_kind}_bg",
                "source_part": part,
                "z_index": z_index,
                "geometry_norm": full_norm,
                "geometry_pt": full_pt,
                "fill": parsed_fill,
            }

    bg_pr = bg.find("p:bgPr", NS)
    if bg_pr is None:
        return None

    for fill in bg_pr:
        tag = fill.tag.rsplit("}", 1)[-1]

        parsed_fill = None

        if tag == "noFill":
            return None

        if tag == "solidFill":
            parsed_fill = parse_solid_fill(fill, theme_map)

        elif tag == "gradFill":
            parsed_fill = parse_gradient_fill(fill, theme_map)

        elif tag == "blipFill":
            image = _resolve_blip(package, part, fill)
            if not image:
                return None

            tint = None
            for child in fill.iter():
                if child.tag.rsplit("}", 1)[-1] in {"schemeClr", "srgbClr", "sysClr", "scrgbClr"}:
                    tint = _parse_color_node(child, theme_map)
                    break

            return {
                "layer_id": f"{source_kind}_bg_image",
                "kind": "image",
                "source_scope": f"{source_kind}_bg",
                "source_part": part,
                "z_index": z_index,
                "geometry_norm": full_norm,
                "geometry_pt": full_pt,
                "asset": image["filename"],
                "crop": _parse_src_rect(fill),
                "fill_mode": _parse_fill_mode(fill),
                "tint": tint,
            }

        if parsed_fill and parsed_fill.get("kind") != "none":
            return {
                "layer_id": f"{source_kind}_bg_fill",
                "kind": "fill",
                "source_scope": f"{source_kind}_bg",
                "source_part": part,
                "z_index": z_index,
                "geometry_norm": full_norm,
                "geometry_pt": full_pt,
                "fill": parsed_fill,
            }

    return None


def _background_ref_fill(bg_ref, theme_map: dict) -> dict | None:
    for child in bg_ref:
        tag = child.tag.rsplit("}", 1)[-1]

        if tag not in {"schemeClr", "srgbClr", "sysClr", "scrgbClr"}:
            continue

        color = resolve_color_node(child, theme_map)
        if not color:
            continue

        return {
            "kind": "solid",
            **color,
            "background_ref": bg_ref.get("idx"),
        }

    return None

def _collect_sp_tree_layers(
    package: PPTXPackage,
    part: str,
    source_kind: str,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    theme: dict,
    layers: list[dict],
    z_index: int,
) -> int:
    root = package.xml(part)
    c_sld = root.find("p:cSld", NS)
    if c_sld is None:
        return z_index
    sp_tree = c_sld.find("p:spTree", NS)
    if sp_tree is None:
        return z_index
    return _walk_nodes(
        package,
        part,
        source_kind,
        sp_tree,
        slide_width_emu,
        slide_height_emu,
        theme_map,
        theme_fonts,
        theme,
        layers,
        z_index,
        parent_matrix=None,
    )


def _walk_nodes(
    package: PPTXPackage,
    part: str,
    source_kind: str,
    container,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    theme: dict,
    layers: list[dict],
    z_index: int,
    parent_matrix: dict | None,
) -> int:
    for child in container:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag in {"nvGrpSpPr", "nvPicPr", "nvSpPr", "nvCxnSpPr"}:
            continue
        if tag == "grpSp":
            z_index = _walk_nodes(
                package,
                part,
                source_kind,
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                theme_fonts,
                theme,
                layers,
                z_index,
                _group_matrix(child, parent_matrix),
            )
            continue
        if tag == "pic":
            layer = _picture_layer(
                package,
                part,
                source_kind,
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                z_index,
                parent_matrix,
            )
            if layer:
                layers.append(layer)
                z_index += 1
            continue
        if tag == "sp":
            if _skip_template_sp_shape(child):
                continue
            layer = _shape_layer(
                package,
                part,
                source_kind,
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                z_index,
                parent_matrix,
            )
            if layer:
                layers.append(layer)
                z_index += 1
                continue
            text_layer = _template_text_layer(
                package,
                part,
                source_kind,
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                theme_fonts,
                theme,
                z_index,
                parent_matrix,
            )
            if text_layer:
                layers.append(text_layer)
                z_index += 1
    return z_index


def _group_matrix(group, parent_matrix: dict | None) -> dict:
    xfrm = group.find("p:grpSpPr/a:xfrm", NS)
    if xfrm is None:
        return parent_matrix or _identity_matrix()
    matrix = _matrix_from_xfrm(xfrm)
    if parent_matrix:
        return _multiply_matrix(parent_matrix, matrix)
    return matrix


def _truthy(value) -> bool:
    return value in {"1", "true", "True"}


def _parse_rot_deg(xfrm) -> float:
    if xfrm is None:
        return 0.0
    raw = xfrm.get("rot")
    if not raw:
        return 0.0
    try:
        return round(int(raw) / 60000.0, 4)
    except (TypeError, ValueError):
        return 0.0


def _identity_matrix() -> dict:
    return {
        "off_x": 0.0,
        "off_y": 0.0,
        "ext_x": 1.0,
        "ext_y": 1.0,
        "ch_off_x": 0.0,
        "ch_off_y": 0.0,
        "ch_ext_x": 1.0,
        "ch_ext_y": 1.0,
        "flip_h": False,
        "flip_v": False,
        "rot_deg": 0.0,
    }


def _matrix_from_xfrm(xfrm) -> dict:
    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    ch_off = xfrm.find("a:chOff", NS)
    ch_ext = xfrm.find("a:chExt", NS)
    return {
        "off_x": _emu(off.get("x") if off is not None else 0),
        "off_y": _emu(off.get("y") if off is not None else 0),
        "ext_x": max(_emu(ext.get("cx") if ext is not None else 1), 1.0),
        "ext_y": max(_emu(ext.get("cy") if ext is not None else 1), 1.0),
        "ch_off_x": _emu(ch_off.get("x") if ch_off is not None else 0),
        "ch_off_y": _emu(ch_off.get("y") if ch_off is not None else 0),
        "ch_ext_x": max(_emu(ch_ext.get("cx") if ch_ext is not None else 1), 1.0),
        "ch_ext_y": max(_emu(ch_ext.get("cy") if ch_ext is not None else 1), 1.0),
        "flip_h": _truthy(xfrm.get("flipH")),
        "flip_v": _truthy(xfrm.get("flipV")),
        "rot_deg": _parse_rot_deg(xfrm),
    }


def _multiply_matrix(outer: dict, inner: dict) -> dict:
    scale_x = outer["ext_x"] / outer["ch_ext_x"]
    scale_y = outer["ext_y"] / outer["ch_ext_y"]
    return {
        "off_x": outer["off_x"] + (inner["off_x"] - outer["ch_off_x"]) * scale_x,
        "off_y": outer["off_y"] + (inner["off_y"] - outer["ch_off_y"]) * scale_y,
        "ext_x": inner["ext_x"] * scale_x,
        "ext_y": inner["ext_y"] * scale_y,
        "ch_off_x": inner["ch_off_x"],
        "ch_off_y": inner["ch_off_y"],
        "ch_ext_x": inner["ch_ext_x"],
        "ch_ext_y": inner["ch_ext_y"],
        "flip_h": outer.get("flip_h", False) ^ inner.get("flip_h", False),
        "flip_v": outer.get("flip_v", False) ^ inner.get("flip_v", False),
        "rot_deg": outer.get("rot_deg", 0.0) + inner.get("rot_deg", 0.0),
    }


def _shape_transform(
    shape,
    parent_matrix: dict | None,
) -> tuple[float, float, float, float, bool, bool, float] | None:
    flip_h = bool(parent_matrix and parent_matrix.get("flip_h"))
    flip_v = bool(parent_matrix and parent_matrix.get("flip_v"))
    rot_deg = float(parent_matrix.get("rot_deg", 0.0)) if parent_matrix else 0.0

    xfrm = shape.find("p:spPr/a:xfrm", NS)
    if xfrm is None:
        geometry = shape_geometry(shape)
        if geometry is None:
            return None
        return (
            geometry["x_pt"] * EMU_PER_PT,
            geometry["y_pt"] * EMU_PER_PT,
            geometry["width_pt"] * EMU_PER_PT,
            geometry["height_pt"] * EMU_PER_PT,
            flip_h,
            flip_v,
            rot_deg,
        )

    if _truthy(xfrm.get("flipH")):
        flip_h = not flip_h
    if _truthy(xfrm.get("flipV")):
        flip_v = not flip_v
    rot_deg += _parse_rot_deg(xfrm)

    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    if off is None or ext is None:
        return None
    x = _emu(off.get("x"))
    y = _emu(off.get("y"))
    width = _emu(ext.get("cx"))
    height = _emu(ext.get("cy"))
    if parent_matrix:
        scale_x = parent_matrix["ext_x"] / parent_matrix["ch_ext_x"]
        scale_y = parent_matrix["ext_y"] / parent_matrix["ch_ext_y"]
        x = parent_matrix["off_x"] + (x - parent_matrix["ch_off_x"]) * scale_x
        y = parent_matrix["off_y"] + (y - parent_matrix["ch_off_y"]) * scale_y
        width *= scale_x
        height *= scale_y

    if width < 0:
        flip_h = not flip_h
        width = abs(width)
    if height < 0:
        flip_v = not flip_v
        height = abs(height)

    return x, y, width, height, flip_h, flip_v, rot_deg


def _attach_transform(
    payload: dict,
    *,
    flip_h: bool,
    flip_v: bool,
    rot_deg: float,
) -> dict:
    if flip_h or flip_v:
        payload["flip"] = {"h": flip_h, "v": flip_v}
    if abs(rot_deg) > 0.001:
        payload["rotate"] = {"deg": round(rot_deg, 4)}
    return payload


def _attach_shape_mask(payload: dict, sp_pr, geometry_pt: dict) -> dict:
    mask = parse_shape_mask(sp_pr)
    if not mask:
        return payload
    mask = apply_mask_geometry(mask, geometry_pt)
    payload["mask"] = mask
    corner_radius_pt = mask.get("corner_radius_pt")
    if corner_radius_pt is not None:
        payload["corner_radius_pt"] = corner_radius_pt
    corner_radii_pt = mask.get("corner_radii_pt")
    if corner_radii_pt is not None:
        payload["corner_radii_pt"] = corner_radii_pt
    return payload


def _geometry_from_transform(
    transform: tuple[float, float, float, float],
    slide_width_emu: float,
    slide_height_emu: float,
) -> tuple[dict, dict]:
    x, y, width, height = transform
    geometry_pt = {
        "x_pt": round(x / EMU_PER_PT, 2),
        "y_pt": round(y / EMU_PER_PT, 2),
        "width_pt": round(width / EMU_PER_PT, 2),
        "height_pt": round(height / EMU_PER_PT, 2),
    }
    geometry_norm = {
        "x": round(x / slide_width_emu, 4),
        "y": round(y / slide_height_emu, 4),
        "width": round(width / slide_width_emu, 4),
        "height": round(height / slide_height_emu, 4),
    }
    return geometry_pt, geometry_norm


def _image_layer_payload(
    *,
    layer_id: str,
    source_kind: str,
    part: str,
    z_index: int,
    name: str | None,
    geometry_pt: dict,
    geometry_norm: dict,
    asset: str,
    crop: dict,
    fill_mode: str,
    flip_h: bool,
    flip_v: bool,
    rot_deg: float,
    mask: dict | None = None,
) -> dict:
    payload = {
        "layer_id": layer_id,
        "kind": "image",
        "source_scope": source_kind,
        "source_part": part,
        "z_index": z_index,
        "name": name,
        "geometry_pt": geometry_pt,
        "geometry_norm": geometry_norm,
        "asset": asset,
        "crop": crop,
        "fill_mode": fill_mode,
    }
    payload = _attach_transform(payload, flip_h=flip_h, flip_v=flip_v, rot_deg=rot_deg)
    if mask:
        mask = apply_mask_geometry(mask, geometry_pt)
        payload["mask"] = mask
        if mask.get("corner_radius_pt") is not None:
            payload["corner_radius_pt"] = mask["corner_radius_pt"]
        corner_radii_pt = mask.get("corner_radii_pt")
        if corner_radii_pt is not None:
            payload["corner_radii_pt"] = corner_radii_pt
    return _attach_template_decorative(payload, source_kind)


def _picture_layer(
    package: PPTXPackage,
    part: str,
    source_kind: str,
    pic,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    z_index: int,
    parent_matrix: dict | None,
) -> dict | None:
    transform = _shape_transform(pic, parent_matrix)
    if transform is None:
        return None
    x, y, width, height, flip_h, flip_v, rot_deg = transform
    blip_fill = pic.find("p:blipFill", NS)
    if blip_fill is None:
        return None
    image = _resolve_blip(package, part, blip_fill)
    if not image:
        return None
    geometry_pt, geometry_norm = _geometry_from_transform((x, y, width, height), slide_width_emu, slide_height_emu)
    name_node = pic.find(".//p:cNvPr", NS)
    mask = parse_shape_mask(pic.find("p:spPr", NS))
    return _image_layer_payload(
        layer_id=f"{source_kind}_pic_{z_index}",
        source_kind=source_kind,
        part=part,
        z_index=z_index,
        name=name_node.get("name") if name_node is not None else None,
        geometry_pt=geometry_pt,
        geometry_norm=geometry_norm,
        asset=image["filename"],
        crop=_parse_src_rect(blip_fill),
        fill_mode=_parse_fill_mode(blip_fill),
        flip_h=flip_h,
        flip_v=flip_v,
        rot_deg=rot_deg,
        mask=mask,
    )


def _line_layer_from_shape(
    package: PPTXPackage,
    part: str,
    source_kind: str,
    shape,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    z_index: int,
    parent_matrix: dict | None,
) -> dict | None:
    transform = _shape_transform(shape, parent_matrix)
    if transform is None:
        return None
    x, y, width, height, flip_h, flip_v, rot_deg = transform
    sp_pr = shape.find("p:spPr", NS)
    if sp_pr is None:
        return None
    stroke = parse_shape_stroke(sp_pr, theme_map)
    if not stroke:
        return None

    pad_emu = max(stroke.get("width_pt", DEFAULT_STROKE_WIDTH_PT), DEFAULT_STROKE_WIDTH_PT) * EMU_PER_PT
    x2 = x + width
    y2 = y + height
    left = min(x, x2)
    top = min(y, y2)
    box_w = max(abs(width), pad_emu)
    box_h = max(abs(height), pad_emu)
    if abs(width) < 0.001:
        left -= pad_emu / 2
    if abs(height) < 0.001:
        top -= pad_emu / 2

    rel_x1 = (x - left) / box_w if box_w else 0.0
    rel_y1 = (y - top) / box_h if box_h else 0.0
    rel_x2 = (x2 - left) / box_w if box_w else 1.0
    rel_y2 = (y2 - top) / box_h if box_h else 1.0
    if flip_h:
        rel_x1, rel_x2 = 1.0 - rel_x2, 1.0 - rel_x1
    if flip_v:
        rel_y1, rel_y2 = 1.0 - rel_y2, 1.0 - rel_y1

    geometry_pt, geometry_norm = _geometry_from_transform((left, top, box_w, box_h), slide_width_emu, slide_height_emu)
    name_node = shape.find(".//p:cNvPr", NS)
    prst = sp_pr.find("a:prstGeom", NS)
    shape_tag = shape.tag.rsplit("}", 1)[-1]
    is_connector = shape_tag == "cxnSp"

    line_payload: dict[str, Any] = {}
    outline_path = None
    if not is_connector:
        mask = parse_shape_mask(sp_pr)
        if mask and mask.get("kind") == "path" and mask.get("path"):
            outline_path = mask["path"]
        elif prst is not None and (prst.get("prst") or "rect") == "rect":
            line_payload["outline"] = "rect"
        elif mask and mask.get("path"):
            outline_path = mask["path"]
        else:
            line_payload["outline"] = "rect"

    if is_connector or (not outline_path and line_payload.get("outline") != "rect"):
        line_payload.update({
            "x1": round(rel_x1, 4),
            "y1": round(rel_y1, 4),
            "x2": round(rel_x2, 4),
            "y2": round(rel_y2, 4),
        })
        if prst is not None and prst.get("prst"):
            line_payload["preset"] = prst.get("prst")

    payload = {
        "layer_id": f"{source_kind}_line_{z_index}",
        "kind": "line",
        "source_scope": source_kind,
        "source_part": part,
        "z_index": z_index,
        "name": name_node.get("name") if name_node is not None else None,
        "geometry_pt": geometry_pt,
        "geometry_norm": geometry_norm,
        "stroke": stroke,
        "line": line_payload,
    }
    if outline_path:
        payload["outline_path"] = outline_path
    return _attach_template_decorative(
        _attach_transform(payload, flip_h=False, flip_v=False, rot_deg=rot_deg),
        source_kind,
    )


def _shape_layer(
    package: PPTXPackage,
    part: str,
    source_kind: str,
    shape,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    z_index: int,
    parent_matrix: dict | None,
) -> dict | None:
    transform = _shape_transform(shape, parent_matrix)
    if transform is None:
        return None
    x, y, width, height, flip_h, flip_v, rot_deg = transform
    sp_pr = shape.find("p:spPr", NS)
    if sp_pr is None:
        return None
    geometry_pt, geometry_norm = _geometry_from_transform((x, y, width, height), slide_width_emu, slide_height_emu)
    name_node = shape.find(".//p:cNvPr", NS)

    parsed_fill = parse_fill_from_sp_pr(sp_pr, theme_map)
    if parsed_fill and parsed_fill.get("kind") not in {None, "none"}:
        payload = {
            "layer_id": f"{source_kind}_shape_{z_index}",
            "kind": "fill",
            "source_scope": source_kind,
            "source_part": part,
            "z_index": z_index,
            "name": name_node.get("name") if name_node is not None else None,
            "geometry_pt": geometry_pt,
            "geometry_norm": geometry_norm,
            "fill": parsed_fill,
        }
        stroke = parse_shape_stroke(sp_pr, theme_map)
        if stroke:
            payload["stroke"] = stroke
        return _attach_template_decorative(
            _attach_shape_mask(
                _attach_transform(
                    payload,
                    flip_h=flip_h,
                    flip_v=flip_v,
                    rot_deg=rot_deg,
                ),
                sp_pr,
                geometry_pt,
            ),
            source_kind,
        )

    for fill in sp_pr:
        tag = fill.tag.rsplit("}", 1)[-1]
        if tag == "blipFill":
            image = _resolve_blip(package, part, fill)
            if image:
                mask = parse_shape_mask(sp_pr)
                return _image_layer_payload(
                    layer_id=f"{source_kind}_shape_image_{z_index}",
                    source_kind=source_kind,
                    part=part,
                    z_index=z_index,
                    name=name_node.get("name") if name_node is not None else None,
                    geometry_pt=geometry_pt,
                    geometry_norm=geometry_norm,
                    asset=image["filename"],
                    crop=_parse_src_rect(fill),
                    fill_mode=_parse_fill_mode(fill),
                    flip_h=flip_h,
                    flip_v=flip_v,
                    rot_deg=rot_deg,
                    mask=mask,
                )
    stroke = parse_shape_stroke(sp_pr, theme_map)
    if stroke:
        return _line_layer_from_shape(
            package,
            part,
            source_kind,
            shape,
            slide_width_emu,
            slide_height_emu,
            theme_map,
            z_index,
            parent_matrix,
        )
    return None


def _shape_text_content(shape) -> str:
    body = shape.find("p:txBody", NS)
    if body is None:
        return ""
    return (_extract_text_content(body) or "").strip()


def _shape_has_decorative_fill(shape) -> bool:
    sp_pr = shape.find("p:spPr", NS)
    if sp_pr is None:
        return False
    for child in sp_pr:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag in {"solidFill", "gradFill", "blipFill", "pattFill"}:
            return True
    return False


def _attach_template_decorative(payload: dict, source_kind: str) -> dict:
    if source_kind in {"master", "layout"}:
        payload["decorative"] = True
    return payload


def _skip_template_sp_shape(shape) -> bool:
    """Skip layout/master shapes whose text is supplied by slide instances."""
    body = shape.find("p:txBody", NS)
    if body is None:
        return False

    text = _shape_text_content(shape)
    if not text and _shape_has_decorative_fill(shape):
        return False

    placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
    if placeholder is not None:
        placeholder_type = placeholder.get("type", "obj")
        if placeholder_type in SYSTEM_PLACEHOLDER_TYPES:
            return not text
        if placeholder_type in EDITABLE_PLACEHOLDER_TYPES:
            return not text
        return not text

    cnv = shape.find("p:nvSpPr/p:cNvSpPr", NS)
    if cnv is not None and cnv.get("txBox") == "1":
        return not text

    return not text


def _template_text_layer(
    package: PPTXPackage,
    part: str,
    source_kind: str,
    shape,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    theme: dict,
    z_index: int,
    parent_matrix: dict | None,
) -> dict | None:
    body = shape.find("p:txBody", NS)
    if body is None:
        return None
    text = _shape_text_content(shape)
    if not text:
        return None

    level_styles = resolve_shape_text_levels(package, part, shape, theme, theme_map)
    paragraphs = _extract_text_paragraphs(
        body,
        theme_map,
        theme_fonts,
        level_styles,
        list_bodies=_list_style_bodies(package, part, shape),
        package=package,
        slide_part=part,
        shape=shape,
    )
    segments = _text_line_segments(paragraphs)
    if not segments:
        return None

    transform = _shape_transform(shape, parent_matrix)
    if transform is None:
        return None
    geometry_pt, geometry_norm = _geometry_from_transform(transform[:4], slide_width_emu, slide_height_emu)
    name_node = shape.find(".//p:cNvPr", NS)
    body_props = _body_properties(shape)
    display_text = "\n".join(segment["text"] for segment in segments)
    typography = segments[0]["typography"] if len(segments) == 1 else _summarize_text_typography(
        _flatten_text_runs(paragraphs),
        paragraphs,
    )
    if segments[0].get("line_spacing_ratio") is not None:
        typography["pptx_line_spacing_ratio"] = segments[0]["line_spacing_ratio"]
    elif paragraphs and paragraphs[0].get("line_spacing_ratio") is not None:
        typography["pptx_line_spacing_ratio"] = paragraphs[0]["line_spacing_ratio"]
    _apply_line_height_typography(typography, segments[0] if segments else paragraphs[0] if paragraphs else None)

    payload: dict[str, Any] = {
        "layer_id": f"{source_kind}_text_{z_index}",
        "kind": "text",
        "source_scope": source_kind,
        "source_part": part,
        "z_index": z_index,
        "name": name_node.get("name") if name_node is not None else None,
        "geometry_pt": geometry_pt,
        "geometry_norm": geometry_norm,
        "text": display_text,
        "typography": typography,
        "decorative": True,
    }
    spacing = _paragraph_spacing_payload(
        segments[0],
        include_hanging_indent=bool(segments[0].get("bullet")),
    )
    if spacing:
        payload["paragraph_spacing_pt"] = spacing
    insets = _body_insets_payload(body_props)
    if insets:
        payload["body_insets_pt"] = insets
    if body_props.get("vertical_anchor"):
        payload["vertical_anchor"] = body_props["vertical_anchor"]
    placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
    if placeholder is not None:
        payload["placeholder_type"] = placeholder.get("type", "obj")
    return payload


def _is_editable_placeholder(shape) -> bool:
    """Backward-compatible alias used by tests and slot extraction heuristics."""
    return _skip_template_sp_shape(shape)


def _parse_src_rect(fill_node) -> dict[str, float]:
    src_rect = fill_node.find("a:srcRect", NS)
    if src_rect is None:
        return {"l": 0.0, "t": 0.0, "r": 0.0, "b": 0.0}
    return {
        side: round(int(src_rect.get(side, 0)) / 100000, 5)
        for side in ("l", "t", "r", "b")
    }


def _parse_fill_mode(fill_node) -> str:
    if fill_node.find("a:stretch", NS) is not None:
        return "stretch"
    if fill_node.find("a:tile", NS) is not None:
        return "tile"
    return "stretch"


def _resolve_blip(package: PPTXPackage, part: str, fill_node) -> dict | None:
    blip = fill_node.find("a:blip", NS)
    if blip is None:
        return None
    embed = blip.get(f"{{{DOC_REL_NS}}}embed")
    if not embed:
        return None
    media_part = _related_image_part(package, part, embed)
    if not media_part:
        return None
    return {"filename": posixpath.basename(media_part), "media_part": media_part}


def _related_image_part(package: PPTXPackage, part: str, relationship_id: str) -> str | None:
    rels = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if not package.exists(rels):
        return None
    for relation in package.xml(rels).findall("r:Relationship", REL_NS):
        if relation.get("Id") != relationship_id or relation.get("Type") != IMAGE_REL_TYPE:
            continue
        target = relation.get("Target")
        if not target:
            continue
        if target.startswith("/"):
            return posixpath.normpath(target.lstrip("/"))
        return posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
    return None


def _parse_color_node(node, theme_map: dict) -> dict | None:
    return resolve_color_node(node, theme_map)


def _emu(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _slide_content_element_id(part: str, local_id: str) -> str:
    slide_slug = part.rsplit("/", 1)[-1].replace(".xml", "")
    return f"{slide_slug}_{local_id}"


TABLE_URI = "http://schemas.openxmlformats.org/drawingml/2006/table"
CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"
DIAGRAM_URI = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
CHART_REL = f"{DOC_REL_NS}/chart"


def build_slide_content_layers(
    package: PPTXPackage,
    slide_part: str,
    slide_size: tuple[float, float],
    theme: dict,
    *,
    base_z_index: int = 100,
) -> list[dict]:
    """Extract slide-specific visual elements above master/layout background."""
    slide_width, slide_height = slide_size
    slide_width_emu = slide_width * EMU_PER_PT
    slide_height_emu = slide_height * EMU_PER_PT
    theme_map = _build_theme_map(theme)
    theme_fonts = _theme_fonts(theme)

    root = package.xml(slide_part)
    c_sld = root.find("p:cSld", NS)
    if c_sld is None:
        return []
    sp_tree = c_sld.find("p:spTree", NS)
    if sp_tree is None:
        return []

    elements: list[dict] = []
    z_index = base_z_index
    z_index = _walk_slide_content(
        package,
        slide_part,
        sp_tree,
        slide_width_emu,
        slide_height_emu,
        theme_map,
        theme_fonts,
        theme,
        elements,
        z_index,
        parent_matrix=None,
    )
    return elements


def _theme_fonts(theme: dict, master_theme_source: str | None = None) -> dict[str, str | None]:
    themes = theme.get("themes", [])

    selected = None
    if master_theme_source:
        selected = next(
            (item for item in themes if item.get("source") == master_theme_source),
            None,
        )

    if selected is None:
        selected = next(
            (item for item in themes if item.get("is_used_by_master")),
            None,
        )

    if selected is None and themes:
        selected = themes[0]

    fonts = selected.get("fonts", {}) if selected else {}

    return {
        "+mj-lt": fonts.get("major", {}).get("latin"),
        "+mn-lt": fonts.get("minor", {}).get("latin"),
    }


def _walk_slide_content(
    package: PPTXPackage,
    part: str,
    container,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    theme: dict,
    elements: list[dict],
    z_index: int,
    parent_matrix: dict | None,
) -> int:
    for child in container:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag in {"nvGrpSpPr", "nvPicPr", "nvSpPr", "nvCxnSpPr", "nvGraphicFramePr"}:
            continue
        if tag == "grpSp":
            z_index = _walk_slide_content(
                package,
                part,
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                theme_fonts,
                theme,
                elements,
                z_index,
                _group_matrix(child, parent_matrix),
            )
            continue
        if tag == "pic":
            layer = _picture_layer(
                package,
                part,
                "slide",
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                z_index,
                parent_matrix,
            )
            if layer:
                layer["element_id"] = _slide_content_element_id(part, layer.pop("layer_id"))
                layer["source_scope"] = "slide"
                elements.append(layer)
                z_index += 1
            continue
        if tag == "sp":
            shape_z_index = z_index
            fill_layer = _shape_layer(
                package,
                part,
                "slide",
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                shape_z_index,
                parent_matrix,
            )
            if fill_layer:
                fill_layer["element_id"] = _slide_content_element_id(part, fill_layer.pop("layer_id"))
                fill_layer["source_scope"] = "slide"
                elements.append(fill_layer)
            text_layers = _slide_text_elements(
                package,
                part,
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                theme_fonts,
                theme,
                shape_z_index,
                parent_matrix,
            )
            if text_layers:
                elements.extend(text_layers)
            if fill_layer or text_layers:
                z_index += 1
            continue
        if tag == "cxnSp":
            line_layer = _line_layer_from_shape(
                package,
                part,
                "slide",
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                z_index,
                parent_matrix,
            )
            if line_layer:
                line_layer["element_id"] = _slide_content_element_id(part, line_layer.pop("layer_id"))
                line_layer["source_scope"] = "slide"
                elements.append(line_layer)
                z_index += 1
            continue
        if tag == "graphicFrame":
            frame = _graphic_frame_element(
                package,
                part,
                child,
                slide_width_emu,
                slide_height_emu,
                theme_map,
                theme_fonts,
                z_index,
                parent_matrix,
            )
            if frame:
                elements.append(frame)
                z_index += 1
    return z_index


def _slide_text_elements(
    package: PPTXPackage,
    slide_part: str,
    shape,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    theme: dict,
    z_index: int,
    parent_matrix: dict | None,
) -> list[dict]:
    body = shape.find("p:txBody", NS)
    if body is None:
        return []
    level_styles = (
        resolve_shape_text_levels(package, slide_part, shape, theme, theme_map)
        if package is not None and slide_part
        else None
    )
    paragraphs = _extract_text_paragraphs(
        body,
        theme_map,
        theme_fonts,
        level_styles,
        list_bodies=_list_style_bodies(package, slide_part, shape),
        package=package,
        slide_part=slide_part,
        shape=shape,
    )
    transform = _shape_transform(shape, parent_matrix)
    if transform is None:
        return []
    geometry_pt, geometry_norm = _geometry_from_transform(transform[:4], slide_width_emu, slide_height_emu)
    body_props = _body_properties(shape)
    body_insets_pt = _body_insets_payload(body_props)
    vertical_anchor = body_props.get("vertical_anchor")
    wrap = body_props.get("wrap")

    from .text_wrap import expand_wrapped_paragraph_runs, paragraph_uses_monospace_font, text_wrap_enabled

    paragraphs = expand_wrapped_paragraph_runs(
        paragraphs,
        geometry_pt=geometry_pt,
        body_insets_pt=body_insets_pt,
        wrap=wrap,
    )
    if text_wrap_enabled(wrap):
        for paragraph in paragraphs:
            if paragraph.get("runs") and paragraph_uses_monospace_font(paragraph):
                paragraph["text"] = _paragraph_text(paragraph["runs"])

    segments = _text_line_segments(paragraphs)
    if not segments:
        return []
    name_node = shape.find(".//p:cNvPr", NS)
    placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
    placeholder_type = placeholder.get("type", "obj") if placeholder is not None else None
    if placeholder is None and shape.find("p:nvSpPr/p:cNvSpPr", NS) is not None:
        if shape.find("p:nvSpPr/p:cNvSpPr", NS).get("txBox") == "1":
            placeholder_type = "body"
    shape_id = name_node.get("id") if name_node is not None else None
    shape_name = name_node.get("name") if name_node is not None else None
    group_id = _slide_content_element_id(slide_part, f"slide_text_{z_index}")

    def _text_element_payload(**payload: Any) -> dict:
        element = dict(payload)
        if body_insets_pt:
            element["body_insets_pt"] = body_insets_pt
        if vertical_anchor:
            element["vertical_anchor"] = vertical_anchor
        if wrap:
            element["wrap"] = wrap
        return element

    if not _segments_need_split(segments):
        text = "\n".join(segment["text"] for segment in segments)
        typography = segments[0]["typography"] if len(segments) == 1 else _summarize_text_typography(
            _flatten_text_runs(paragraphs),
            paragraphs,
        )
        first_segment = segments[0] if segments else {}
        text_paragraphs = _text_paragraphs_payload(paragraphs)
        has_bullet = bool(first_segment.get("bullet"))
        element = _text_element_payload(
            element_id=group_id,
            kind="text",
            source_scope="slide",
            z_index=z_index,
            name=shape_name,
            shape_id=shape_id,
            geometry_pt=geometry_pt,
            geometry_norm=geometry_norm,
            text=text,
            text_sample=text[:160],
            placeholder_type=placeholder_type,
            typography=typography,
            paragraph_spacing_pt=_paragraph_spacing_payload(
                first_segment,
                include_hanging_indent=not text_paragraphs,
            ),
            bullet=_bullet_payload(first_segment),
        )
        if text_paragraphs:
            element["text_paragraphs"] = text_paragraphs
        attach_metric_fields(element, paragraphs)
        return [element]

    elements: list[dict] = []
    group_spacing_pt = compute_text_group_spacing_pt(segments, paragraphs[0] if paragraphs else None)
    for line_index, segment in enumerate(segments):
        text = segment["text"]
        element = _text_element_payload(
            element_id=f"{group_id}_line_{line_index + 1}",
            kind="text",
            source_scope="slide",
            z_index=z_index,
            name=shape_name,
            shape_id=shape_id,
            text_group_id=group_id,
            text_line_index=line_index,
            split_from_shape=True,
            text_group_geometry_norm=geometry_norm,
            text_group_geometry_pt=geometry_pt,
            geometry_pt=geometry_pt,
            geometry_norm=geometry_norm,
            text=text,
            text_sample=text[:160],
            placeholder_type=placeholder_type,
            typography=segment["typography"],
            paragraph_spacing_pt=_paragraph_spacing_payload(segment),
            bullet=_bullet_payload(segment),
        )
        if group_spacing_pt:
            element["text_group_spacing_pt"] = group_spacing_pt
        elements.append(element)
    return elements


def _style_signature(typography: dict) -> tuple:
    return (
        typography.get("family"),
        typography.get("size_pt"),
        bool(typography.get("bold")),
        bool(typography.get("italic")),
        typography.get("color"),
    )


def _geometry_style_signature(typography: dict) -> tuple:
    return (
        typography.get("family"),
        typography.get("size_pt"),
        bool(typography.get("bold")),
        bool(typography.get("italic")),
    )


def _run_geometry_signature(run: dict) -> tuple:
    return (
        run.get("family"),
        run.get("size_pt"),
        bool(run.get("bold")),
        bool(run.get("italic")),
    )


def _apply_line_height_typography(typography: dict, source: dict | None) -> None:
    if not source:
        return
    if source.get("line_spacing_ratio") is not None:
        typography["pptx_line_spacing_ratio"] = source["line_spacing_ratio"]
    if source.get("line_height_applicable"):
        if source.get("line_spacing_ratio") is not None:
            typography["line_height_ratio"] = source["line_spacing_ratio"]
        if source.get("line_height_pt") is not None:
            typography["line_height_pt"] = source["line_height_pt"]
        typography["line_height_applicable"] = True
    elif source.get("line_height_applicable") is False:
        typography["line_height_applicable"] = False


def _typography_from_runs(runs: list[dict], alignment: str = "l", paragraph: dict | None = None) -> dict:
    typography = _summarize_text_typography(
        [run for run in runs if run.get("text")],
        [{"alignment": alignment, "runs": runs}],
    )
    _apply_line_height_typography(typography, paragraph)
    return typography


def _segment_spacing_fields(paragraph: dict) -> dict:
    fields = {
        "margin_left_pt": paragraph.get("margin_left_pt", 0.0),
        "indent_pt": paragraph.get("indent_pt", 0.0),
        "level": paragraph.get("level", 0),
    }
    if paragraph.get("space_before_pt"):
        fields["space_before_pt"] = paragraph["space_before_pt"]
    if paragraph.get("space_after_pt"):
        fields["space_after_pt"] = paragraph["space_after_pt"]
    if paragraph.get("line_spacing_ratio") is not None:
        fields["line_spacing_ratio"] = paragraph["line_spacing_ratio"]
    if paragraph.get("line_height_pt") is not None:
        fields["line_height_pt"] = paragraph["line_height_pt"]
    if paragraph.get("line_height_applicable") is not None:
        fields["line_height_applicable"] = paragraph["line_height_applicable"]
    if paragraph.get("line_spacing_unit"):
        fields["line_spacing_unit"] = paragraph["line_spacing_unit"]
    return fields


def _line_groups_from_runs(runs: list[dict]) -> list[list[dict]]:
    groups: list[list[dict]] = []
    current: list[dict] = []
    for run in runs:
        if run.get("break") in {"line", "paragraph"}:
            if current:
                groups.append(current)
                current = []
        elif run.get("text"):
            current.append(run)
    if current:
        groups.append(current)
    return groups


def _line_group_text(group: list[dict]) -> str:
    return _strip_bullet_placeholder("".join(run["text"] for run in group).strip())


def _paragraph_end_size_pt(paragraph) -> float | None:
    end_rpr = paragraph.find("a:endParaRPr", NS)
    if end_rpr is None or end_rpr.get("sz") is None:
        return None
    try:
        return round(int(end_rpr.get("sz")) / 100, 2)
    except (TypeError, ValueError):
        return None


def _paragraph_block_gap_pt(paragraph: dict, preceding_size_pt: float | None = None) -> float:
    """Vertical gap from an empty paragraph kept in the shape before splitting."""
    end_size = paragraph.get("end_size_pt")
    size_pt = max(
        float(end_size or 0.0),
        float(preceding_size_pt or 0.0),
        float(_paragraph_font_size_pt(paragraph.get("runs") or [], None, int(paragraph.get("level") or 0))),
    )
    line_ratio = float(paragraph.get("line_spacing_ratio") or 1.0)
    if paragraph.get("line_height_applicable") and paragraph.get("line_height_pt") is not None:
        gap = round(float(paragraph["line_height_pt"]), 2)
    elif paragraph.get("line_height_applicable") is False:
        gap = round(size_pt, 2)
    else:
        gap = round(size_pt * line_ratio, 2)
    space_before = float(paragraph.get("space_before_pt") or 0.0)
    space_after = float(paragraph.get("space_after_pt") or 0.0)
    return round(gap + space_before + space_after, 2)


def _text_line_segments(paragraphs: list[dict], *, skip_metrics: bool = False) -> list[dict]:
    segments: list[dict] = []
    pending_gap_pt = 0.0

    for paragraph in paragraphs:
        alignment = paragraph["alignment"]
        if paragraph.get("spacer_only"):
            preceding_size = segments[-1]["typography"].get("size_pt") if segments else None
            pending_gap_pt += _paragraph_block_gap_pt(paragraph, preceding_size)
            continue

        if paragraph.get("bullet"):
            text = paragraph.get("text") or ""
            if text:
                spacing = _segment_spacing_fields(paragraph)
                if segments and pending_gap_pt:
                    spacing["space_before_pt"] = round(
                        float(spacing.get("space_before_pt") or 0.0) + pending_gap_pt,
                        2,
                    )
                    pending_gap_pt = 0.0
                segments.append({
                    "text": text,
                    "typography": _typography_from_runs(paragraph["runs"], alignment, paragraph),
                    "alignment": alignment,
                    **spacing,
                    "bullet": paragraph["bullet"],
                })
            continue

        if not skip_metrics and paragraph_is_metric(paragraph):
            spacing = _segment_spacing_fields(paragraph)
            if segments and pending_gap_pt:
                spacing["space_before_pt"] = round(
                    float(spacing.get("space_before_pt") or 0.0) + pending_gap_pt,
                    2,
                )
                pending_gap_pt = 0.0
            segments.append({
                "text": paragraph_metric_display_text(paragraph),
                "typography": _typography_from_runs(paragraph["runs"], alignment, paragraph),
                "alignment": alignment,
                **spacing,
            })
            continue

        line_groups = _line_groups_from_runs(paragraph["runs"])
        if not line_groups:
            preceding_size = segments[-1]["typography"].get("size_pt") if segments else None
            pending_gap_pt += _paragraph_block_gap_pt(paragraph, preceding_size)
            continue

        grouped_segments: list[list[list[dict]]] = []
        current_groups = [line_groups[0]]
        current_sig = _run_geometry_signature(line_groups[0][0])

        for group in line_groups[1:]:
            sig = _run_geometry_signature(group[0])
            if sig == current_sig:
                current_groups.append(group)
            else:
                grouped_segments.append(current_groups)
                current_groups = [group]
                current_sig = sig
        grouped_segments.append(current_groups)

        for group_index, groups in enumerate(grouped_segments):
            lines = [_line_group_text(group) for group in groups]
            text = "\n".join(line for line in lines if line)
            if not text:
                continue
            all_runs = [run for group in groups for run in group]
            spacing = _segment_spacing_fields(paragraph)
            inherited_before = float(spacing.get("space_before_pt") or 0.0)
            if group_index == 0 and segments and pending_gap_pt:
                inherited_before += pending_gap_pt
                pending_gap_pt = 0.0
            if inherited_before:
                spacing["space_before_pt"] = round(inherited_before, 2)
            segments.append({
                "text": text,
                "typography": _typography_from_runs(all_runs, alignment, paragraph),
                "alignment": alignment,
                **spacing,
            })

    merged: list[dict] = []
    for segment in segments:
        if (
            merged
            and not merged[-1].get("bullet")
            and not segment.get("bullet")
            and _geometry_style_signature(merged[-1]["typography"])
            == _geometry_style_signature(segment["typography"])
        ):
            merged[-1]["text"] = f"{merged[-1]['text']}\n{segment['text']}"
            continue
        merged.append(segment)
    return merged


def _segments_need_split(segments: list[dict]) -> bool:
    if len(segments) <= 1:
        return False
    if segments_form_metric(segments):
        return False
    if any(segment.get("bullet") for segment in segments):
        return True
    signatures = {_geometry_style_signature(segment["typography"]) for segment in segments}
    return len(signatures) > 1


def _serialize_run_style(rpr, theme_map: dict, theme_fonts: dict[str, str | None]) -> dict:
    values: dict[str, Any] = {
        "family": "Arial",
        "bold": False,
        "italic": False,
        "color": None,
    }
    if rpr is not None:
        latin = rpr.find("a:latin", NS)
        if latin is not None and latin.get("typeface"):
            values["family"] = latin.get("typeface")
        size_raw = rpr.get("sz")
        if size_raw is not None:
            try:
                values["size_pt"] = round(int(size_raw) / 100, 2)
            except (TypeError, ValueError):
                pass
        values["bold"] = rpr.get("b") in {"1", "true", "True"}
        values["italic"] = rpr.get("i") in {"1", "true", "True"}
        if rpr.get("u") is not None:
            values["underline"] = rpr.get("u")
        elif rpr.find("a:u", NS) is not None:
            values["underline"] = rpr.find("a:u", NS).get("val") or "sng"
        strike = rpr.get("strike")
        if strike is not None:
            values["strike"] = strike not in {"noStrike", "none", "0", "false", "False"}
        elif rpr.find("a:strike", NS) is not None:
            values["strike"] = True
        solid = rpr.find("a:solidFill", NS)
        if solid is not None and len(solid):
            parsed = _parse_color_node(solid[0], theme_map)
            if parsed:
                values["color"] = parsed.get("color")
                if parsed.get("alpha") is not None and parsed.get("alpha") < 0.999:
                    values["alpha"] = parsed.get("alpha")
    family = values["family"]
    if family in theme_fonts and theme_fonts[family]:
        values["family"] = theme_fonts[family]
    if "size_pt" not in values:
        values["size_pt"] = 14
    return values


def _extract_field_text(fld) -> str:
    parts = []
    for text_node in fld.findall(".//a:t", NS):
        if text_node.text:
            parts.append(text_node.text)
    return "".join(parts)


def _paragraph_runs(
    paragraph,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    level_styles: dict[int, dict] | None = None,
) -> list[dict]:
    runs: list[dict] = []
    for child in paragraph:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "r":
            text_node = child.find("a:t", NS)
            text = text_node.text if text_node is not None else ""
            if not text:
                continue
            rpr = child.find("a:rPr", NS)
            if level_styles is not None:
                style = effective_run_typography(level_styles, paragraph, rpr, theme_map, theme_fonts)
            else:
                style = _serialize_run_style(rpr, theme_map, theme_fonts)
            runs.append({"text": text, **style})
        elif tag == "br":
            runs.append({"break": "line"})
        elif tag == "fld":
            text = _extract_field_text(child)
            if not text:
                continue
            rpr = child.find("a:rPr", NS)
            if level_styles is not None:
                style = effective_run_typography(level_styles, paragraph, rpr, theme_map, theme_fonts)
            else:
                style = _serialize_run_style(rpr, theme_map, theme_fonts)
            runs.append({"text": text, **style})
    return runs


def _paragraph_text(runs: list[dict]) -> str:
    parts: list[str] = []
    for run in runs:
        if run.get("break") == "line":
            parts.append("\n")
        elif run.get("text"):
            parts.append(run["text"])
    text = "".join(parts).strip()
    return _strip_bullet_placeholder(text)


def _strip_bullet_placeholder(text: str) -> str:
    return text.lstrip("\u200b\ufeff").strip()


def _paragraph_margins(ppr) -> dict[str, float | int]:
    spacing: dict[str, float | int] = {"margin_left_pt": 0.0, "indent_pt": 0.0, "level": 0}
    if ppr is None:
        return spacing
    if ppr.get("lvl") is not None:
        try:
            spacing["level"] = int(ppr.get("lvl"))
        except ValueError:
            pass
    for attribute, key in [("marL", "margin_left_pt"), ("indent", "indent_pt")]:
        if ppr.get(attribute) is None:
            continue
        try:
            spacing[key] = round(int(ppr.get(attribute)) / EMU_PER_PT, 2)
        except ValueError:
            continue
    return spacing


def _paragraph_style_sources(ppr, bodies, level: int, package=None, slide_part=None, shape=None):
    if ppr is not None:
        yield ppr
    for body in bodies:
        list_ppr = _list_level_ppr(body, level)
        if list_ppr is not None:
            yield list_ppr
        def_ppr = body.find("a:lstStyle/a:defPPr", NS)
        if def_ppr is not None:
            yield def_ppr
    tx_style_ppr = _tx_style_level_ppr(package, slide_part, shape, level)
    if tx_style_ppr is not None:
        yield tx_style_ppr
    default_ppr = _default_text_style_level_ppr(package, level)
    if default_ppr is not None:
        yield default_ppr


def _first_paragraph_child(ppr, bodies, level: int, package, slide_part, shape, tag: str):
    for source in _paragraph_style_sources(ppr, bodies, level, package, slide_part, shape):
        node = source.find(f"a:{tag}", NS)
        if node is not None:
            return node
    return None


def _parse_line_spacing(node, size_pt: float | None) -> dict[str, float | str | bool]:
    """Parse a:pPr/a:lnSpc.

    spcPct/spcPts describe paragraph line spacing in OOXML. For large single-line
    display text Google Slides often exports tiny ratios (~16%) that do not match
    the visual cap-height; those are kept for diagnostics but not applied to render.
    """
    if node is None or not size_pt:
        return {}
    pct = node.find("a:spcPct", NS)
    if pct is not None and pct.get("val") is not None:
        try:
            ratio = int(pct.get("val")) / 100000
            line_height_pt = round(size_pt * ratio, 2)
            applicable = line_height_applicable(ratio, size_pt=size_pt)
            result: dict[str, float | str | bool] = {
                "line_spacing_ratio": round(ratio, 3),
                "line_spacing_unit": "ratio",
                "line_height_applicable": applicable,
            }
            if applicable:
                result["line_height_pt"] = line_height_pt
            return result
        except ValueError:
            return {}
    pts = node.find("a:spcPts", NS)
    if pts is not None and pts.get("val") is not None:
        try:
            line_height_pt = round(int(pts.get("val")) / 100, 2)
            ratio = round(line_height_pt / size_pt, 3)
            applicable = line_height_applicable(ratio, size_pt=size_pt, line_height_pt=line_height_pt)
            result = {
                "line_spacing_ratio": ratio,
                "line_spacing_unit": "pt",
                "line_height_applicable": applicable,
            }
            if applicable:
                result["line_height_pt"] = line_height_pt
            return result
        except ValueError:
            return {}
    return {}


def _parse_line_spacing_ratio(node, size_pt: float | None = None) -> float | None:
    parsed = _parse_line_spacing(node, size_pt)
    ratio = parsed.get("line_spacing_ratio")
    return float(ratio) if ratio is not None else None


def _parse_space_amount(node, size_pt: float | None) -> tuple[float | None, float | None]:
    """Return (points, lines). lines is set only for spcPct values."""
    if node is None:
        return None, None
    pct = node.find("a:spcPct", NS)
    if pct is not None and pct.get("val") is not None:
        try:
            lines = int(pct.get("val")) / 100000
            points = round(size_pt * lines, 2) if size_pt else None
            return points, round(lines, 3)
        except ValueError:
            return None, None
    pts = node.find("a:spcPts", NS)
    if pts is not None and pts.get("val") is not None:
        try:
            return round(int(pts.get("val")) / 100, 2), None
        except ValueError:
            return None, None
    return None, None


def _effective_space_before_pt(
    space_before_pt: float | None,
    space_before_lines: float | None,
    size_pt: float | None,
    *,
    has_bullet: bool = False,
) -> float:
    if space_before_lines is not None and size_pt:
        return round(size_pt * space_before_lines, 2)
    if space_before_pt is not None and space_before_pt > 0:
        if has_bullet and size_pt:
            # Bullet lists: small spcPts values mean "one line before" (= font size).
            return round(size_pt, 2)
        return round(space_before_pt, 2)
    return float(space_before_pt or 0.0)


def _paragraph_font_size_pt(runs: list[dict], level_styles: dict[int, dict] | None, level: int) -> float:
    sizes = [float(run["size_pt"]) for run in runs if run.get("size_pt")]
    if sizes:
        return max(sizes)
    level_style = (level_styles or {}).get(level + 1) or (level_styles or {}).get(1) or {}
    if level_style.get("size_pt"):
        return float(level_style["size_pt"])
    return 14.0


def _resolve_paragraph_spacing(
    ppr,
    bodies,
    level: int,
    size_pt: float,
    package=None,
    slide_part: str | None = None,
    shape=None,
) -> dict[str, float | int]:
    spacing = _paragraph_margins(ppr)
    ln_spc = _first_paragraph_child(ppr, bodies, level, package, slide_part, shape, "lnSpc")
    spc_bef = _first_paragraph_child(ppr, bodies, level, package, slide_part, shape, "spcBef")
    spc_aft = _first_paragraph_child(ppr, bodies, level, package, slide_part, shape, "spcAft")

    spacing.update(_parse_line_spacing(ln_spc, size_pt))

    before_pt, before_lines = _parse_space_amount(spc_bef, size_pt)
    after_pt, after_lines = _parse_space_amount(spc_aft, size_pt)
    has_bullet = not _paragraph_has_bu_none(ppr, bodies, level) and (
        _bullet_property_node(ppr, bodies, level, "buChar") is not None
        or _bullet_property_node(ppr, bodies, level, "buAutoNum") is not None
    )
    if before_pt is not None or before_lines is not None:
        spacing["space_before_pt"] = _effective_space_before_pt(
            before_pt,
            before_lines,
            size_pt,
            has_bullet=has_bullet,
        )
        if before_lines is not None:
            spacing["space_before_lines"] = before_lines
    if after_pt is not None or after_lines is not None:
        spacing["space_after_pt"] = after_pt if after_lines is None else round(size_pt * after_lines, 2)
        if after_lines is not None:
            spacing["space_after_lines"] = after_lines
    return spacing


def _paragraph_spacing_payload(
    source: dict | None,
    *,
    include_hanging_indent: bool = True,
) -> dict[str, float | int] | None:
    if not source:
        return None
    margin_left = float(source.get("margin_left_pt") or 0.0) if include_hanging_indent else 0.0
    indent = float(source.get("indent_pt") or 0.0) if include_hanging_indent else 0.0
    level = int(source.get("level") or 0) if include_hanging_indent else 0
    space_before = float(source.get("space_before_pt") or 0.0)
    space_after = float(source.get("space_after_pt") or 0.0)
    line_spacing_ratio = source.get("line_spacing_ratio")
    line_height_pt = source.get("line_height_pt")
    line_height_applicable_flag = source.get("line_height_applicable")
    if (
        not margin_left
        and not indent
        and not level
        and not space_before
        and not space_after
        and line_spacing_ratio is None
        and line_height_pt is None
    ):
        return None
    payload: dict[str, float | int] = {}
    if margin_left:
        payload["margin_left"] = margin_left
    if indent:
        payload["indent"] = indent
    if level:
        payload["level"] = level
    if space_before:
        payload["space_before"] = space_before
    if space_after:
        payload["space_after"] = space_after
    if line_spacing_ratio is not None:
        payload["line_spacing_ratio"] = line_spacing_ratio
    if line_height_pt is not None:
        payload["line_height_pt"] = line_height_pt
    if line_height_applicable_flag is not None:
        payload["line_height_applicable"] = line_height_applicable_flag
    line_spacing_unit = source.get("line_spacing_unit")
    if line_spacing_unit:
        payload["line_spacing_unit"] = line_spacing_unit
    return payload or None


def _bullet_payload(source: dict | None) -> dict | None:
    bullet = source.get("bullet") if source else None
    return dict(bullet) if bullet else None


def _paragraph_uses_monospace_font(paragraph: dict) -> bool:
    runs = paragraph.get("runs") or []
    for run in runs:
        family = (run.get("family") or "").lower()
        if any(token in family for token in ("consolas", "courier", "mono", "menlo")):
            return True
    return False


def _text_paragraphs_payload(paragraphs: list[dict]) -> list[dict] | None:
    content = [paragraph for paragraph in paragraphs if paragraph.get("text") and not paragraph.get("spacer_only")]
    if len(content) <= 1:
        return None
    blocks: list[dict] = []
    for paragraph in content:
        spacing = _paragraph_spacing_payload(
            paragraph,
            include_hanging_indent=bool(paragraph.get("bullet")),
        )
        if spacing and _paragraph_uses_monospace_font(paragraph):
            spacing = dict(spacing)
            spacing.pop("space_before", None)
            spacing.pop("space_after", None)
        block = {"text": paragraph["text"]}
        if spacing:
            block["paragraph_spacing_pt"] = spacing
        blocks.append(block)
    return blocks


def _part_related_to(package: PPTXPackage, source: str, relation_type: str) -> str | None:
    rels = posixpath.join(posixpath.dirname(source), "_rels", posixpath.basename(source) + ".rels")
    if not package.exists(rels):
        return None
    for relation in package.xml(rels).findall("r:Relationship", REL_NS):
        if relation.get("Type") != relation_type or relation.get("TargetMode") == "External":
            continue
        target = relation.get("Target")
        if not target:
            continue
        if target.startswith("/"):
            return posixpath.normpath(target.lstrip("/"))
        return posixpath.normpath(posixpath.join(posixpath.dirname(source), target))
    return None


def _list_style_bodies(package: PPTXPackage | None, slide_part: str | None, shape) -> list:
    bodies = []
    slide_body = shape.find("p:txBody", NS)
    if slide_body is not None:
        bodies.append(slide_body)
    if package is None or not slide_part:
        return bodies
    layout = _part_related_to(package, slide_part, LAYOUT_REL)
    master = _part_related_to(package, layout, MASTER_REL) if layout else None
    layout_shape = None
    master_shape = None
    if layout:
        layout_shape = _match_placeholder(_text_shapes(package.xml(layout)), shape)
    if master:
        master_shape = _match_placeholder(_text_shapes(package.xml(master)), layout_shape if layout_shape is not None else shape)
    for matched in (layout_shape, master_shape):
        if matched is None:
            continue
        body = matched.find("p:txBody", NS)
        if body is not None:
            bodies.append(body)
    return bodies


def _list_level_ppr(body, level: int):
    lst = body.find("a:lstStyle", NS)
    if lst is None:
        return None
    return lst.find(f"a:lvl{level + 1}pPr", NS)


def _bullet_property_node(ppr, bodies, level: int, tag: str):
    if ppr is not None:
        node = ppr.find(f"a:{tag}", NS)
        if node is not None:
            return node
    for body in bodies:
        list_ppr = _list_level_ppr(body, level)
        if list_ppr is not None:
            node = list_ppr.find(f"a:{tag}", NS)
            if node is not None:
                return node
        def_ppr = body.find("a:lstStyle/a:defPPr", NS)
        if def_ppr is not None:
            node = def_ppr.find(f"a:{tag}", NS)
            if node is not None:
                return node
    return None


def _paragraph_has_bu_none(ppr, bodies, level: int) -> bool:
    if ppr is not None and ppr.find("a:buNone", NS) is not None:
        return True
    for body in bodies:
        list_ppr = _list_level_ppr(body, level)
        if list_ppr is not None and list_ppr.find("a:buNone", NS) is not None and ppr is not None:
            for tag in ("buChar", "buAutoNum", "buBlip"):
                if ppr.find(f"a:{tag}", NS) is not None:
                    return False
            return True
    return False


def _parse_bullet_size_pt(ppr, bodies, level: int) -> float | None:
    sources = [ppr] if ppr is not None else []
    for body in bodies:
        list_ppr = _list_level_ppr(body, level)
        if list_ppr is not None:
            sources.append(list_ppr)
        def_ppr = body.find("a:lstStyle/a:defPPr", NS)
        if def_ppr is not None:
            sources.append(def_ppr)
    for source in sources:
        if source is None:
            continue
        size_pts = source.find("a:buSzPts", NS)
        if size_pts is not None and size_pts.get("val") is not None:
            try:
                return round(int(size_pts.get("val")) / 100, 2)
            except ValueError:
                pass
        size_pct = source.find("a:buSzPct", NS)
        if size_pct is not None and size_pct.get("val") is not None:
            try:
                return round(int(size_pct.get("val")) / 1000, 2)
            except ValueError:
                pass
    return None


def _parse_bullet_font(ppr, bodies, level: int, theme_fonts: dict[str, str | None]) -> str | None:
    font_node = _bullet_property_node(ppr, bodies, level, "buFont")
    if font_node is None:
        return None
    family = font_node.get("typeface")
    if not family:
        return None
    return theme_fonts.get(family) or family


def _placeholder_text_style_category(shape) -> str:
    placeholder = shape.find(".//p:ph", NS) if shape is not None else None
    kind = placeholder.get("type", "obj") if placeholder is not None else "obj"
    if kind in {"title", "ctrTitle"}:
        return "titleStyle"
    if kind in {"body", "subTitle"}:
        return "bodyStyle"
    return "otherStyle"


def _tx_style_level_ppr(package: PPTXPackage | None, slide_part: str | None, shape, level: int):
    if package is None or not slide_part or shape is None:
        return None
    layout = _part_related_to(package, slide_part, LAYOUT_REL)
    master = _part_related_to(package, layout, MASTER_REL) if layout else None
    if not master:
        return None
    tx_styles = package.xml(master).find("p:txStyles", NS)
    if tx_styles is None:
        return None
    style = tx_styles.find(f"p:{_placeholder_text_style_category(shape)}", NS)
    if style is None:
        return None
    return style.find(f"a:lvl{level + 1}pPr", NS)


def _default_text_style_level_ppr(package: PPTXPackage | None, level: int):
    if package is None:
        return None
    if not package.exists("ppt/presentation.xml"):
        return None
    default_style = package.xml("ppt/presentation.xml").find("p:defaultTextStyle", NS)
    if default_style is None:
        return None
    return default_style.find(f"a:lvl{level + 1}pPr", NS)


def _bullet_color_sources(ppr, bodies, level: int, package=None, slide_part=None, shape=None):
    if ppr is not None and ppr.find("a:buClr", NS) is not None:
        yield ppr
    for body in bodies:
        list_ppr = _list_level_ppr(body, level)
        if list_ppr is not None and list_ppr.find("a:buClr", NS) is not None:
            yield list_ppr
        def_ppr = body.find("a:lstStyle/a:defPPr", NS)
        if def_ppr is not None and def_ppr.find("a:buClr", NS) is not None:
            yield def_ppr
    tx_style_ppr = _tx_style_level_ppr(package, slide_part, shape, level)
    if tx_style_ppr is not None and tx_style_ppr.find("a:buClr", NS) is not None:
        yield tx_style_ppr
    default_ppr = _default_text_style_level_ppr(package, level)
    if default_ppr is not None and default_ppr.find("a:buClr", NS) is not None:
        yield default_ppr


def _parse_bullet_color(
    ppr,
    bodies,
    level: int,
    theme_map: dict,
    package=None,
    slide_part=None,
    shape=None,
) -> str | None:
    for source in _bullet_color_sources(ppr, bodies, level, package, slide_part, shape):
        color_node = source.find("a:buClr", NS)
        if color_node is None:
            continue
        for child in color_node:
            parsed = _parse_color_node(child, theme_map)
            if parsed:
                return parsed.get("color")
    return None


_AUTO_NUM_LABELS = {
    "arabicPeriod": "{n}.",
    "arabicParenR": "{n})",
    "arabicParenBoth": "({n})",
    "romanUcPeriod": "{R}.",
    "romanLcPeriod": "{r}.",
    "alphaUcPeriod": "{A}.",
    "alphaLcPeriod": "{a}.",
}


def _format_auto_number(num_type: str, index: int) -> str:
    template = _AUTO_NUM_LABELS.get(num_type, "{n}.")
    label = template.replace("{n}", str(index))
    if "{R}" in label or "{r}" in label:
        roman = _to_roman(index)
        label = label.replace("{R}", roman).replace("{r}", roman.lower())
    if "{A}" in label or "{a}" in label:
        alpha = _to_alpha(index)
        label = label.replace("{A}", alpha).replace("{a}", alpha.lower())
    return label


def _to_roman(value: int) -> str:
    pairs = [
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"),
        (100, "C"), (90, "XC"), (50, "L"), (40, "XL"),
        (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    ]
    result = []
    remaining = value
    for number, numeral in pairs:
        while remaining >= number:
            result.append(numeral)
            remaining -= number
    return "".join(result) or "I"


def _to_alpha(value: int) -> str:
    result = []
    current = value
    while current > 0:
        current -= 1
        result.append(chr(ord("A") + (current % 26)))
        current //= 26
    return "".join(reversed(result)) or "A"


def _parse_paragraph_bullet(
    ppr,
    bodies,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    level: int,
    package=None,
    slide_part=None,
    shape=None,
) -> dict | None:
    if _paragraph_has_bu_none(ppr, bodies, level):
        return None

    char_node = _bullet_property_node(ppr, bodies, level, "buChar")
    if char_node is not None and char_node.get("char"):
        payload: dict[str, Any] = {
            "kind": "char",
            "char": char_node.get("char"),
        }
    else:
        auto_node = _bullet_property_node(ppr, bodies, level, "buAutoNum")
        if auto_node is None:
            return None
        num_type = auto_node.get("type") or "arabicPeriod"
        payload = {
            "kind": "auto",
            "num_type": num_type,
            "start_at": int(auto_node.get("startAt", 1) or 1),
        }

    size_pt = _parse_bullet_size_pt(ppr, bodies, level)
    if size_pt is not None:
        payload["size_pt"] = size_pt
    font = _parse_bullet_font(ppr, bodies, level, theme_fonts)
    if font:
        payload["font"] = font
    color = _parse_bullet_color(ppr, bodies, level, theme_map, package, slide_part, shape)
    if color:
        payload["color"] = color
    return payload


def _assign_auto_bullet_labels(paragraphs: list[dict]) -> None:
    counters: dict[tuple[int, str], int] = {}
    for paragraph in paragraphs:
        bullet = paragraph.get("bullet")
        if not bullet or bullet.get("kind") != "auto":
            continue
        level = int(paragraph.get("level") or 0)
        num_type = bullet.get("num_type") or "arabicPeriod"
        key = (level, num_type)
        start_at = int(bullet.get("start_at") or 1)
        counters[key] = counters.get(key, start_at - 1) + 1
        index = counters[key]
        bullet["index"] = index
        bullet["label"] = _format_auto_number(num_type, index)


def _body_insets_payload(body_props: dict) -> dict[str, float] | None:
    if not body_props:
        return None
    insets = {
        "left": float(body_props.get("left_inset_pt") or 0.0),
        "right": float(body_props.get("right_inset_pt") or 0.0),
        "top": float(body_props.get("top_inset_pt") or 0.0),
        "bottom": float(body_props.get("bottom_inset_pt") or 0.0),
    }
    # Google Slides body placeholders: lIns=0 with other insets still present — ignore the block.
    if insets["left"] == 0.0 and insets["right"] > 0:
        return None
    if not any(insets.values()):
        return None
    return insets


def _extract_text_paragraphs(
    body,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    level_styles: dict[int, dict] | None = None,
    list_bodies: list | None = None,
    package=None,
    slide_part: str | None = None,
    shape=None,
) -> list[dict]:
    bodies = list_bodies or [body]
    paragraphs: list[dict] = []
    for paragraph in body.findall("a:p", NS):
        ppr = paragraph.find("a:pPr", NS)
        alignment = ppr.get("algn") if ppr is not None and ppr.get("algn") else "l"
        level = 0
        if ppr is not None and ppr.get("lvl") is not None:
            try:
                level = int(ppr.get("lvl"))
            except ValueError:
                level = 0
        runs = _paragraph_runs(paragraph, theme_map, theme_fonts, level_styles)
        size_pt = _paragraph_font_size_pt(runs, level_styles, level)
        spacing = _resolve_paragraph_spacing(
            ppr,
            bodies,
            level,
            size_pt,
            package,
            slide_part,
            shape,
        )
        text = _paragraph_text(runs)
        end_size_pt = _paragraph_end_size_pt(paragraph)
        if not text and not any(run.get("break") for run in runs):
            paragraphs.append({
                "alignment": alignment,
                "runs": runs,
                "text": "",
                "spacer_only": True,
                **({"end_size_pt": end_size_pt} if end_size_pt else {}),
                **spacing,
            })
            continue
        bullet = _parse_paragraph_bullet(
            ppr,
            bodies,
            theme_map,
            theme_fonts,
            int(spacing.get("level") or 0),
            package,
            slide_part,
            shape,
        )
        paragraphs.append({
            "alignment": alignment,
            "runs": runs,
            "text": text,
            **spacing,
            **({"bullet": bullet} if bullet else {}),
        })
    _assign_auto_bullet_labels(paragraphs)
    return paragraphs


def _flatten_text_runs(paragraphs: list[dict]) -> list[dict]:
    flat: list[dict] = []
    for index, paragraph in enumerate(paragraphs):
        if index > 0:
            flat.append({"break": "paragraph"})
        flat.extend(paragraph["runs"])
    return flat


def _paragraphs_to_text(paragraphs: list[dict]) -> str:
    lines = [paragraph["text"] for paragraph in paragraphs if paragraph.get("text")]
    return "\n".join(lines)


def _extract_text_content(body) -> str:
    paragraphs = _extract_text_paragraphs(body, {}, {})
    return _paragraphs_to_text(paragraphs)


def _summarize_text_typography(text_runs: list[dict], paragraphs: list[dict]) -> dict:
    alignment = paragraphs[0]["alignment"] if paragraphs else "l"
    weighted: Counter = Counter()
    for run in text_runs:
        if run.get("break") or not run.get("text"):
            continue
        key = (run.get("family"), run.get("size_pt"), run.get("bold"), run.get("color"), run.get("alpha"))
        weighted[key] += len(run["text"])
    if not weighted:
        return {
            "family": "Arial",
            "size_pt": 14,
            "bold": False,
            "color": None,
            "alignment": alignment,
        }
    (family, size_pt, bold, color, alpha), _ = weighted.most_common(1)[0]
    typography = {
        "family": family or "Arial",
        "size_pt": size_pt or 14,
        "bold": bool(bold),
        "color": color,
        "alignment": alignment,
    }
    if alpha is not None and alpha < 0.999:
        typography["alpha"] = alpha
    return typography


def _extract_text_typography(body, theme_map: dict, theme_fonts: dict[str, str | None]) -> dict:
    paragraphs = _extract_text_paragraphs(body, theme_map, theme_fonts)
    return _summarize_text_typography(_flatten_text_runs(paragraphs), paragraphs)


def _graphic_frame_element(
    package: PPTXPackage,
    part: str,
    frame,
    slide_width_emu: float,
    slide_height_emu: float,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    z_index: int,
    parent_matrix: dict | None,
) -> dict | None:
    xfrm = frame.find("p:xfrm", NS)
    if xfrm is None:
        return None
    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    if off is None or ext is None:
        return None
    x = _emu(off.get("x"))
    y = _emu(off.get("y"))
    width = _emu(ext.get("cx"))
    height = _emu(ext.get("cy"))
    if parent_matrix:
        scale_x = parent_matrix["ext_x"] / parent_matrix["ch_ext_x"]
        scale_y = parent_matrix["ext_y"] / parent_matrix["ch_ext_y"]
        x = parent_matrix["off_x"] + (x - parent_matrix["ch_off_x"]) * scale_x
        y = parent_matrix["off_y"] + (y - parent_matrix["ch_off_y"]) * scale_y
        width *= scale_x
        height *= scale_y
    geometry_pt, geometry_norm = _geometry_from_transform((x, y, width, height), slide_width_emu, slide_height_emu)
    name_node = frame.find("p:nvGraphicFramePr/p:cNvPr", NS)

    graphic_data = frame.find("a:graphic/a:graphicData", NS)
    uri = graphic_data.get("uri") if graphic_data is not None else ""
    kind = "graphic"
    payload: dict[str, Any] = {}
    if uri == TABLE_URI and graphic_data is not None:
        kind = "table"
        table = graphic_data.find("a:tbl", NS)
        payload = parse_table_element(table, theme_map, theme_fonts, package=package)
    elif uri == CHART_URI:
        kind = "chart"
        payload = parse_chart_element(package, part, graphic_data, theme_map)
    elif uri == DIAGRAM_URI:
        kind = "diagram"
        payload = parse_diagram_element(package, part, graphic_data)

    element_geometry_pt = geometry_pt
    element_geometry_norm = geometry_norm
    if kind == "table" and payload.get("table"):
        element_geometry_pt, element_geometry_norm = apply_table_intrinsic_geometry(
            geometry_pt,
            geometry_norm,
            payload["table"],
            slide_width_emu=slide_width_emu,
            slide_height_emu=slide_height_emu,
        )

    return {
        "element_id": _slide_content_element_id(part, f"slide_{kind}_{z_index}"),
        "kind": kind,
        "source_scope": "slide",
        "z_index": z_index,
        "name": name_node.get("name") if name_node is not None else None,
        "geometry_pt": element_geometry_pt,
        "geometry_norm": element_geometry_norm,
        **payload,
    }
