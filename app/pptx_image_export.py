"""Export catalog images with crop, rotation, and clip masks."""

from __future__ import annotations

import re
from pathlib import Path

from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn

from .shape_mask import ROUND_CORNER_PRESETS, apply_mask_geometry

PRESET_MASK_KINDS = frozenset({"roundRect", "round1Rect", "round2SameRect", "round2DiagRect", "ellipse"})

_PATH_TOKEN_RE = re.compile(r"([MLCQZ])|(-?\d*\.?\d+(?:e[-+]?\d+)?)", re.IGNORECASE)
_CUST_GEOM_SCALE = 100_000
_UNIT_ELLIPSE_PATHS = frozenset(
    {
        "M 0.5 0.0 C 0.77614 0.0 1.0 0.22386 1.0 0.5 C 1.0 0.77614 0.77614 1.0 0.5 1.0 C 0.22386 1.0 0.0 0.77614 0.0 0.5 C 0.0 0.22386 0.22386 0.0 0.5 0.0 Z",
    }
)


def _normalize_path(path_data: str) -> str:
    return " ".join(path_data.upper().split())


def _path_is_unit_ellipse(path_data: str) -> bool:
    return _normalize_path(path_data) in _UNIT_ELLIPSE_PATHS


def _path_coord(value: str) -> int:
    return int(round(float(value) * _CUST_GEOM_SCALE))


def _path_pt_xml(x: str, y: str) -> str:
    return f'<a:pt x="{_path_coord(x)}" y="{_path_coord(y)}"/>'


def _cust_geom_xml_from_path(path_data: str) -> str:
    tokens = _PATH_TOKEN_RE.findall(path_data)
    flat: list[str] = []
    for command, number in tokens:
        if command:
            flat.append(command.upper())
        elif number:
            flat.append(number)

    parts: list[str] = []
    index = 0
    while index < len(flat):
        command = flat[index]
        index += 1
        if command == "M":
            parts.append(f"<a:moveTo>{_path_pt_xml(flat[index], flat[index + 1])}</a:moveTo>")
            index += 2
        elif command == "L":
            parts.append(f"<a:lnTo>{_path_pt_xml(flat[index], flat[index + 1])}</a:lnTo>")
            index += 2
        elif command == "C":
            parts.append(
                "<a:cubicBezTo>"
                f"{_path_pt_xml(flat[index], flat[index + 1])}"
                f"{_path_pt_xml(flat[index + 2], flat[index + 3])}"
                f"{_path_pt_xml(flat[index + 4], flat[index + 5])}"
                "</a:cubicBezTo>"
            )
            index += 6
        elif command == "Z":
            parts.append("<a:close/>")

    inner = "".join(parts)
    return (
        f"<a:custGeom {nsdecls('a')}>"
        f'<a:pathLst><a:path w="{_CUST_GEOM_SCALE}" h="{_CUST_GEOM_SCALE}">'
        f"{inner}</a:path></a:pathLst></a:custGeom>"
    )


def apply_cust_geom_path(shape, path_data: str) -> None:
    sp_pr = shape.element.spPr
    for tag in ("a:prstGeom", "a:custGeom"):
        existing = sp_pr.find(qn(tag))
        if existing is not None:
            sp_pr.remove(existing)
    sp_pr.insert(0, parse_xml(_cust_geom_xml_from_path(path_data)))


def _mask_adjustments_xml(mask: dict | None) -> str:
    if not mask:
        return ""
    parts: list[str] = []
    kind = mask.get("kind")
    if mask.get("adj1") is not None:
        value = int(round(float(mask["adj1"]) * 100_000))
        name = "adj" if kind in {"roundRect", "round1Rect"} else "adj1"
        parts.append(f'<a:gd name="{name}" fmla="val {value}"/>')
    if mask.get("adj2") is not None:
        value = int(round(float(mask["adj2"]) * 100_000))
        parts.append(f'<a:gd name="adj2" fmla="val {value}"/>')
    return "".join(parts)


def apply_picture_preset_geom(picture, preset: str, mask: dict | None = None) -> None:
    sp_pr = picture.element.spPr
    for tag in ("a:prstGeom", "a:custGeom"):
        existing = sp_pr.find(qn(tag))
        if existing is not None:
            sp_pr.remove(existing)
    adjustments = _mask_adjustments_xml(mask)
    av_lst = f"<a:avLst>{adjustments}</a:avLst>" if adjustments else "<a:avLst/>"
    sp_pr.insert(0, parse_xml(f'<a:prstGeom {nsdecls("a")} prst="{preset}">{av_lst}</a:prstGeom>'))


def apply_picture_mask(picture, mask: dict) -> None:
    path_data = mask.get("path") if mask.get("kind") == "path" else None
    if path_data and _path_is_unit_ellipse(path_data):
        apply_picture_preset_geom(picture, "ellipse")
        return
    if mask.get("kind") == "ellipse":
        apply_picture_preset_geom(picture, "ellipse")
        return
    if path_data:
        apply_cust_geom_path(picture, path_data)
        return
    preset = mask.get("kind")
    if preset in PRESET_MASK_KINDS:
        apply_picture_preset_geom(picture, preset if preset != "ellipse" else "ellipse", mask)


def _mask_has_visible_rounding(mask: dict, geometry_pt: dict | None) -> bool:
    kind = mask.get("kind")
    if kind == "ellipse":
        return True
    if kind == "path" and mask.get("path"):
        return True
    if kind not in ROUND_CORNER_PRESETS:
        return bool(kind and kind not in {"rect", "preset"})
    enriched = apply_mask_geometry(dict(mask), geometry_pt)
    radii = enriched.get("corner_radii_pt") or []
    return any(float(value or 0) > 0.01 for value in radii)


def image_needs_shape_mask(element: dict) -> bool:
    mask = element.get("mask") or {}
    return _mask_has_visible_rounding(mask, element.get("geometry_pt"))


def _export_picture(slide, asset_path: Path, left, top, width, height, crop, *, disable_shape_effects):
    picture = slide.shapes.add_picture(str(asset_path), left, top, width, height)
    disable_shape_effects(picture)
    if crop:
        picture.crop_left = float(crop.get("l") or 0)
        picture.crop_top = float(crop.get("t") or 0)
        picture.crop_right = float(crop.get("r") or 0)
        picture.crop_bottom = float(crop.get("b") or 0)
    return picture


def export_image(slide, element: dict, assets_dir: Path, *, disable_shape_effects) -> None:
    from .slides_pptx_builder import apply_catalog_transform, geometry_box

    asset = element.get("asset")
    if not asset:
        return
    asset_path = assets_dir / Path(asset).name
    if not asset_path.is_file():
        return

    left, top, width, height = geometry_box(element)
    if width <= 0 or height <= 0:
        return

    crop = element.get("crop") or {}
    mask = element.get("mask") or {}

    picture = _export_picture(
        slide,
        asset_path,
        left,
        top,
        width,
        height,
        crop,
        disable_shape_effects=disable_shape_effects,
    )
    if element.get("name"):
        picture.name = str(element["name"])
    if image_needs_shape_mask(element):
        apply_picture_mask(picture, mask)
    apply_catalog_transform(picture, element)
