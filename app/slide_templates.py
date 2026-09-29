"""Extract content-editable slide templates grouped by slide layout."""

from __future__ import annotations

import posixpath
import re
from collections import Counter, defaultdict

from .colors import _build_theme_map, _normalize_hex
from .fill_styles import parse_gradient_fill, parse_solid_fill, resolve_color_node
from .pptx import PPTXPackage
from .slide_geometry import geometry_coverage, shape_geometry, slide_size_pt
from .template_colors import (
    apply_slot_text_colors,
    build_background_image_text_stats,
    build_template_color_profile,
)
from .template_layers import build_template_render

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
IMAGE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
LAYOUT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
MASTER_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
THEME_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"

EDITABLE_PLACEHOLDER_TYPES = frozenset({"title", "ctrTitle", "subTitle", "body", "obj"})
SYSTEM_PLACEHOLDER_TYPES = frozenset({"ftr", "hdr", "dt", "sldNum"})
ROLE_LABELS = {
    "title": "Заголовок",
    "ctrTitle": "Заголовок",
    "subTitle": "Подзаголовок",
    "body": "Текст",
    "obj": "Контент",
}


def extract_slide_templates(
    package: PPTXPackage,
    theme: dict,
    text_slots: dict | None,
    assets: dict | None,
    colors: dict | None,
    slide_size: tuple[float, float] | None = None,
) -> dict:
    slide_size = slide_size or slide_size_pt(package)
    if not slide_size:
        return {"templates": [], "summary": {"template_count": 0, "layout_count": 0}}

    theme_map = _build_theme_map(theme)
    theme_maps_by_source = _build_theme_maps_by_source(theme)

    layouts = _layout_parts(package)
    slides = _slide_parts(package)

    slide_by_number = {
        number: slide
        for slide in slides
        if (number := _part_number(slide)) is not None
    }

    slide_layout = {slide: _related_part(package, slide, LAYOUT_REL) for slide in slides}
    layout_master = {layout: _related_part(package, layout, MASTER_REL) for layout in layouts}
    master_theme = {
        master: _related_part(package, master, THEME_REL)
        for master in set(layout_master.values())
        if master
    }

    layout_slides: dict[str, list[int]] = defaultdict(list)
    for slide, layout in slide_layout.items():
        if not layout:
            continue

        number = _part_number(slide)
        if number is not None:
            layout_slides[layout].append(number)

    layout_slots = _layout_template_slots(text_slots or {}, slide_size)
    media_by_filename = {
        item["filename"]: item for item in (assets or {}).get("media_files", [])
    }
    context_palettes = (colors or {}).get("context_palettes", {})

    layout_image_index = _build_layout_image_index(
        package,
        layouts,
        layout_master,
        layout_slides,
        slide_by_number,
        slide_size,
        theme_map,
        theme_maps_by_source,
        master_theme,
        media_by_filename,
    )

    background_image_text_stats = build_background_image_text_stats(
        text_slots,
        layout_image_index,
    )

    templates = []
    for index, layout_source in enumerate(layouts, start=1):
        slide_numbers = sorted(layout_slides.get(layout_source, []))
        if not slide_numbers:
            continue

        editable_slots = layout_slots.get(layout_source, [])
        if not editable_slots:
            continue

        slide_sources = [
            slide_by_number[number]
            for number in slide_numbers
            if number in slide_by_number
        ]

        layout_name = _layout_name(package, layout_source)
        master_source = layout_master.get(layout_source)
        local_theme_map = _theme_map_for_master(
            theme_map,
            theme_maps_by_source,
            master_theme,
            master_source,
        )

        background = _extract_background(
            package,
            layout_source,
            master_source,
            slide_sources,
            slide_size,
            local_theme_map,
            slide_numbers,
            media_by_filename,
        )

        render = build_template_render(
            package,
            layout_source,
            layout_master.get(layout_source),
            slide_size,
            theme,
        )

        template_colors = build_template_color_profile(
            background=background,
            render=render,
            editable_slots=editable_slots,
            context_palettes=context_palettes,
            theme_map=local_theme_map,
            layout_source=layout_source,
            text_slots=text_slots,
            background_image_text_stats=background_image_text_stats,
        )

        apply_slot_text_colors(editable_slots, template_colors.get("text_styles", {}))
        capabilities = _capabilities(editable_slots)

        templates.append({
            "template_id": f"tmpl_{index:03d}",
            "layout_source": layout_source,
            "layout_name": layout_name,
            "layout_file": posixpath.basename(layout_source),
            "slide_numbers": slide_numbers,
            "slide_count": len(slide_numbers),
            "preview_slide": slide_numbers[0],
            "editable_slots": editable_slots,
            "editable_slot_count": len(editable_slots),
            "capabilities": capabilities,
            "background": background,
            "colors": template_colors,
            "render": render,
        })

    templates.sort(key=lambda item: (-item["slide_count"], item["layout_name"], item["template_id"]))

    used_layouts = len({item["layout_source"] for item in templates})

    return {
        "templates": templates,
        "summary": {
            "template_count": len(templates),
            "layout_count": used_layouts,
            "editable_layouts": used_layouts,
        },
    }


def _layout_parts(package: PPTXPackage) -> list[str]:
    return sorted(
        part for part in package.list("ppt/slideLayouts/")
        if re.search(r"slideLayout\d+\.xml$", part)
    )


def _slide_parts(package: PPTXPackage) -> list[str]:
    return sorted(
        part for part in package.list("ppt/slides/")
        if re.search(r"slide\d+\.xml$", part)
    )


def _part_number(part: str) -> int | None:
    match = re.search(r"(\d+)\.xml$", part)
    return int(match.group(1)) if match else None


def _related_part(package: PPTXPackage, source: str, relation_type: str) -> str | None:
    rels = posixpath.join(
        posixpath.dirname(source),
        "_rels",
        posixpath.basename(source) + ".rels",
    )

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


def _layout_name(package: PPTXPackage, layout_source: str) -> str:
    root = package.xml(layout_source)
    c_sld = root.find("p:cSld", NS)

    if c_sld is not None and c_sld.get("name"):
        return c_sld.get("name")

    return posixpath.basename(layout_source)


def _layout_template_slots(text_slots: dict, slide_size: tuple[float, float]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    width_pt, height_pt = slide_size

    for slot in text_slots.get("templates", []):
        if slot.get("source_type") != "layout":
            continue

        if not slot.get("visible_on_slide", True):
            continue

        if not _is_editable_slot(slot):
            continue

        geometry = slot.get("geometry") or {}
        placeholder_type = slot.get("placeholder_type") or "obj"
        level = (slot.get("levels") or [{}])[0]
        slot_body = slot.get("body") or {}

        paragraph_spacing_pt = _paragraph_spacing_from_level(level)
        body_insets_pt = _body_insets_from_slot(slot_body)

        slot_payload = {
            "shape_id": slot.get("shape_id"),
            "name": slot.get("name"),
            "role": _slot_role(placeholder_type),
            "placeholder_type": placeholder_type,
            "kind": slot.get("kind"),
            "geometry_pt": geometry,
            "geometry_norm": _normalize_geometry(geometry, width_pt, height_pt),
            "typography": {
                "family": level.get("family"),
                "size_pt": level.get("size_pt"),
                "bold": level.get("bold"),
                "line_height_pt": level.get("line_height_pt"),
                "line_height_ratio": level.get("line_spacing") if level.get("line_spacing_unit") == "ratio" else None,
                "alignment": level.get("alignment"),
                "color": level.get("color"),
                "color_scheme": level.get("color_scheme"),
            },
            "empty": slot.get("empty", True),
            "slide_coverage": slot.get("slide_coverage"),
        }

        if paragraph_spacing_pt:
            slot_payload["paragraph_spacing_pt"] = paragraph_spacing_pt

        if body_insets_pt:
            slot_payload["body_insets_pt"] = body_insets_pt

        if level.get("bullet_kind"):
            slot_payload["bullet_kind"] = level.get("bullet_kind")

        grouped[slot["source"]].append(slot_payload)

    for layout_source, slots in grouped.items():
        slots.sort(key=lambda item: (item["geometry_norm"]["y"], item["geometry_norm"]["x"]))

    return grouped


def _is_editable_slot(slot: dict) -> bool:
    placeholder_type = slot.get("placeholder_type")

    if placeholder_type in SYSTEM_PLACEHOLDER_TYPES:
        return False

    if slot.get("kind") == "placeholder" and placeholder_type in EDITABLE_PLACEHOLDER_TYPES:
        return True

    if slot.get("kind") == "text_box":
        return True

    return False


def _slot_role(placeholder_type: str) -> str:
    if placeholder_type in {"title", "ctrTitle"}:
        return "title"

    if placeholder_type == "subTitle":
        return "subtitle"

    if placeholder_type == "body":
        return "body"

    return "content"


def _body_insets_from_slot(body: dict | None) -> dict[str, float] | None:
    if not body:
        return None

    mapping = {
        "left": body.get("left_inset_pt"),
        "right": body.get("right_inset_pt"),
        "top": body.get("top_inset_pt"),
        "bottom": body.get("bottom_inset_pt"),
    }

    insets = {key: value for key, value in mapping.items() if value is not None}
    return insets or None


def _paragraph_spacing_from_level(level: dict) -> dict[str, float] | None:
    spacing: dict[str, float] = {}

    if level.get("line_spacing") is not None and level.get("line_spacing_unit") == "ratio":
        spacing["line_spacing_ratio"] = round(float(level["line_spacing"]), 3)

    if level.get("space_before_pt"):
        spacing["space_before"] = round(float(level["space_before_pt"]), 2)

    if level.get("space_after_pt"):
        spacing["space_after"] = round(float(level["space_after_pt"]), 2)

    return spacing or None


def _normalize_geometry(geometry: dict, width_pt: float, height_pt: float) -> dict:
    if not geometry or width_pt <= 0 or height_pt <= 0:
        return {"x": 0, "y": 0, "width": 0, "height": 0}

    return {
        "x": round(geometry.get("x_pt", 0) / width_pt, 4),
        "y": round(geometry.get("y_pt", 0) / height_pt, 4),
        "width": round(geometry.get("width_pt", 0) / width_pt, 4),
        "height": round(geometry.get("height_pt", 0) / height_pt, 4),
    }


def _capabilities(editable_slots: list[dict]) -> list[str]:
    roles = {slot["role"] for slot in editable_slots}
    capabilities = []

    if "title" in roles:
        capabilities.append("title")

    if "subtitle" in roles:
        capabilities.append("subtitle")

    if "body" in roles:
        capabilities.extend(["paragraph", "list"])

    if "content" in roles:
        capabilities.append("content")

    return capabilities


def _build_theme_maps_by_source(theme: dict) -> dict[str, dict]:
    result: dict[str, dict] = {}

    for item in theme.get("themes", []):
        source = item.get("source")
        if not source:
            continue

        theme_colors = item.get("colors", {})
        theme_map: dict[str, str] = {}

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


def _theme_map_for_master(
    fallback_theme_map: dict,
    theme_maps_by_source: dict[str, dict],
    master_theme: dict[str, str | None],
    master_source: str | None,
) -> dict:
    if not master_source:
        return fallback_theme_map

    theme_source = master_theme.get(master_source)
    if not theme_source:
        return fallback_theme_map

    return theme_maps_by_source.get(theme_source) or fallback_theme_map


def _build_layout_image_index(
    package: PPTXPackage,
    layouts: list[str],
    layout_master: dict[str, str | None],
    layout_slides: dict[str, list[int]],
    slide_by_number: dict[int, str],
    slide_size: tuple[float, float],
    theme_map: dict,
    theme_maps_by_source: dict[str, dict],
    master_theme: dict[str, str | None],
    media_by_filename: dict,
) -> dict[str, str]:
    index: dict[str, str] = {}

    for layout_source in layouts:
        slide_numbers = layout_slides.get(layout_source, [])

        slide_sources = [
            slide_by_number[number]
            for number in slide_numbers
            if number in slide_by_number
        ]

        master_source = layout_master.get(layout_source)
        local_theme_map = _theme_map_for_master(
            theme_map,
            theme_maps_by_source,
            master_theme,
            master_source,
        )

        background = _extract_background(
            package,
            layout_source,
            master_source,
            slide_sources,
            slide_size,
            local_theme_map,
            slide_numbers,
            media_by_filename,
        )

        image_key = background.get("primary_image")
        if image_key:
            index[layout_source] = image_key

    return index


def _extract_background(
    package: PPTXPackage,
    layout_source: str,
    master_source: str | None,
    slide_sources: list[str],
    slide_size: tuple[float, float],
    theme_map: dict,
    slide_numbers: list[int],
    media_by_filename: dict,
) -> dict:
    """
    Resolve template background.

    For template/layout analysis, the layout background is primary because it
    belongs to the design system. Slide backgrounds are used only when the
    layout has no visible background fill.

    Order:
    1. explicit visible layout background
    2. explicit visible backgrounds on real slides using this layout
    3. explicit visible master background
    4. no fill
    """

    fill = _read_visible_background_fill(
        package,
        layout_source,
        theme_map,
        source="layout",
        source_part=layout_source,
    )

    if fill is None:
        fill = _most_common_slide_background_fill(
            package,
            slide_sources,
            theme_map,
        )

    if fill is None and master_source:
        fill = _read_visible_background_fill(
            package,
            master_source,
            theme_map,
            source="master",
            source_part=master_source,
        )

    images = []
    seen = set()

    for part in [layout_source, master_source]:
        if not part:
            continue

        for image in _read_background_images(package, part, slide_size):
            key = image["filename"]
            if key in seen:
                continue

            seen.add(key)
            images.append(image)

    for image in _slide_background_images(slide_numbers, media_by_filename):
        key = image["filename"]
        if key in seen:
            continue

        seen.add(key)
        images.append(image)

    images.sort(
        key=lambda item: (
            -item.get("likelihood", 0),
            -item.get("coverage", 0),
            item["filename"],
        )
    )

    return {
        "fill": fill,
        "images": images,
        "primary_image": images[0]["filename"] if images else None,
    }


def _most_common_slide_background_fill(
    package: PPTXPackage,
    slide_sources: list[str],
    theme_map: dict,
) -> dict | None:
    """
    Find explicit visible backgrounds on real slides and select the most common one.

    Invisible backgrounds such as noFill / alpha=0 are ignored because they
    should not mask layout or master backgrounds.
    """

    buckets: dict[tuple, dict] = {}

    for slide_source in slide_sources:
        fill = _read_background_fill(package, slide_source, theme_map)

        if not _is_visible_background_fill(fill):
            continue

        key = _background_fill_key(fill)

        if key not in buckets:
            buckets[key] = {
                "fill": fill,
                "count": 0,
                "source_parts": [],
            }

        buckets[key]["count"] += 1
        buckets[key]["source_parts"].append(slide_source)

    if not buckets:
        return None

    winner = sorted(
        buckets.values(),
        key=lambda item: (
            -item["count"],
            item["source_parts"][0],
        ),
    )[0]

    return {
        **winner["fill"],
        "source": "slide",
        "source_part": winner["source_parts"][0],
        "source_parts": winner["source_parts"],
        "occurrences": winner["count"],
    }


def _background_fill_key(fill: dict) -> tuple:
    kind = fill.get("kind") or fill.get("type")

    if kind in {"solid", None}:
        return (
            "solid",
            fill.get("color"),
            round(float(fill.get("alpha", 1.0)), 4),
            fill.get("scheme"),
            fill.get("background_ref"),
        )

    if kind in {"linear_gradient", "radial_gradient"}:
        stops = tuple(
            (
                round(float(stop.get("position", 0)), 4),
                stop.get("color"),
                round(float(stop.get("alpha", 1.0)), 4),
            )
            for stop in fill.get("stops") or []
        )

        return (
            kind,
            round(float(fill.get("angle_deg") or 0), 2),
            fill.get("path"),
            stops,
        )

    if kind == "image" or fill.get("type") == "image":
        image = fill.get("image") or {}
        return (
            "image",
            image.get("filename"),
            fill.get("color"),
            round(float(fill.get("alpha", 1.0)), 4),
        )

    return (
        str(kind),
        fill.get("color"),
        round(float(fill.get("alpha", 1.0)), 4),
    )


def _read_background_fill(package: PPTXPackage, part: str, theme_map: dict) -> dict | None:
    root = package.xml(part)

    c_sld = root.find("p:cSld", NS)
    if c_sld is None:
        return None

    bg = c_sld.find("p:bg", NS)
    if bg is None:
        return None

    bg_ref = bg.find("p:bgRef", NS)
    if bg_ref is not None:
        parsed = _read_background_ref(bg_ref, theme_map)
        if parsed is not None:
            return parsed

    bg_pr = bg.find("p:bgPr", NS)
    if bg_pr is None:
        return None

    for fill in bg_pr:
        tag = fill.tag.rsplit("}", 1)[-1]

        if tag == "noFill":
            return {
                "kind": "none",
                "alpha": 0.0,
            }

        if tag == "solidFill":
            return parse_solid_fill(fill, theme_map)

        if tag == "gradFill":
            return parse_gradient_fill(fill, theme_map)

        if tag == "blipFill":
            color = None

            for child in fill.iter():
                if child.tag.rsplit("}", 1)[-1] in {
                    "schemeClr",
                    "srgbClr",
                    "sysClr",
                    "scrgbClr",
                }:
                    color = resolve_color_node(child, theme_map)
                    break

            image = _resolve_blip_image(package, part, fill)

            payload = {
                "kind": "image",
                "type": "image",
                "source_part": part,
            }

            if color:
                payload.update(color)

            if image:
                payload["image"] = image

            return payload

    return None



def _read_visible_background_fill(
    package: PPTXPackage,
    part: str,
    theme_map: dict,
    *,
    source: str,
    source_part: str,
) -> dict | None:
    fill = _read_background_fill(package, part, theme_map)

    if not _is_visible_background_fill(fill):
        return None

    return {
        **fill,
        "source": source,
        "source_part": source_part,
    }


def _is_visible_background_fill(fill: dict | None) -> bool:
    if not fill:
        return False

    kind = fill.get("kind") or fill.get("type")

    if kind == "none":
        return False

    try:
        alpha = float(fill.get("alpha", 1.0))
    except (TypeError, ValueError):
        alpha = 1.0

    if alpha <= 0:
        return False

    if kind in {"solid", None}:
        return bool(fill.get("color"))

    if kind in {"linear_gradient", "radial_gradient"}:
        return bool(fill.get("stops"))

    if kind == "image" or fill.get("type") == "image":
        return bool(fill.get("image") or fill.get("color"))

    return bool(fill.get("color"))


def _read_background_ref(bg_ref, theme_map: dict) -> dict | None:
    """
    Parse p:bgRef.

    Example:
    <p:bgRef idx="1001">
      <a:schemeClr val="bg1"/>
    </p:bgRef>
    """

    for child in bg_ref:
        tag = child.tag.rsplit("}", 1)[-1]

        if tag not in {
            "schemeClr",
            "srgbClr",
            "sysClr",
            "scrgbClr",
        }:
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


def _parse_color_node(node, theme_map: dict) -> dict | None:
    return resolve_color_node(node, theme_map)


def _resolve_blip_image(package: PPTXPackage, part: str, fill_node) -> dict | None:
    blip = fill_node.find("a:blip", NS)
    if blip is None:
        return None

    embed = blip.get(f"{{{DOC_REL_NS}}}embed")
    if not embed:
        return None

    media_part = _related_image_part(package, part, embed)
    if not media_part:
        return None

    filename = posixpath.basename(media_part)
    return {
        "filename": filename,
        "source_part": part,
        "layer": "background_fill",
    }


def _related_image_part(package: PPTXPackage, part: str, relationship_id: str) -> str | None:
    rels = posixpath.join(
        posixpath.dirname(part),
        "_rels",
        posixpath.basename(part) + ".rels",
    )

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


def _read_background_images(
    package: PPTXPackage,
    part: str,
    slide_size: tuple[float, float],
) -> list[dict]:
    root = package.xml(part)
    images = []

    for pic in root.findall(".//p:pic", NS):
        geometry = shape_geometry(pic)
        if geometry is None:
            continue

        coverage = geometry_coverage(geometry, slide_size)
        if coverage < 0.55:
            continue

        blip = pic.find(".//a:blip", NS)
        if blip is None:
            continue

        embed = blip.get(f"{{{DOC_REL_NS}}}embed")
        if not embed:
            continue

        media_part = _related_image_part(package, part, embed)
        if not media_part:
            continue

        filename = posixpath.basename(media_part)
        name_node = pic.find(".//p:cNvPr", NS)

        images.append({
            "filename": filename,
            "source_part": part,
            "layer": "layout_picture",
            "coverage": coverage,
            "likelihood": min(0.99, 0.7 + coverage * 0.25),
            "label": name_node.get("name") if name_node is not None else filename,
        })

    return images


def _slide_background_images(slide_numbers: list[int], media_by_filename: dict) -> list[dict]:
    slide_set = set(slide_numbers)
    scored = []

    for asset in media_by_filename.values():
        overlap = slide_set.intersection(asset.get("slide_numbers") or [])
        if not overlap:
            continue

        best_source = None
        best_coverage = 0.0

        for source in asset.get("sources", []):
            if source.get("part", "").startswith("ppt/slides/"):
                coverage = source.get("placement", {}).get("coverage", 0)

                if coverage > best_coverage:
                    best_coverage = coverage
                    best_source = source

        likelihood = asset.get("background_likelihood") or 0

        if likelihood < 0.7 and best_coverage < 0.75:
            continue

        scored.append({
            "filename": asset["filename"],
            "source_part": (best_source or {}).get("part", "slides"),
            "layer": "slide_background",
            "coverage": max(best_coverage, likelihood),
            "likelihood": max(likelihood, min(0.95, 0.65 + best_coverage * 0.3)),
            "label": asset.get("filename"),
            "slide_numbers": sorted(overlap),
        })

    return sorted(
        scored,
        key=lambda item: (
            -item["likelihood"],
            -len(item["slide_numbers"]),
        ),
    )
