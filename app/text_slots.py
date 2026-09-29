"""Recover text slots from presentation masters, layouts and slides.

A slot is a shape with a text body, even when every <a:t> is empty.  The
master/layout relationship chain supplies its default typography and bounds.
"""

import posixpath
import re
from collections import Counter

from .pptx import PPTXPackage
from .slide_geometry import geometry_coverage, is_shape_visible, is_within_slide, shape_geometry as _shape_geometry
from .colors import _build_theme_map, _normalize_hex
from .fill_styles import resolve_color_node
from .line_height import line_height_applicable

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/package/2006/relationships",
}
LAYOUT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
MASTER_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
THEME_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
TEXT_PLACEHOLDERS = {"title", "ctrTitle", "subTitle", "body", "obj", "ftr", "hdr", "dt", "sldNum"}
EMU_PER_PT = 12700


def extract_text_slots(package: PPTXPackage, theme: dict, slide_size=None, use_visible_slides=False) -> dict:
    theme_map = _build_theme_map(theme)
    masters = _parts(package, "ppt/slideMasters/slideMaster")
    layouts = _parts(package, "ppt/slideLayouts/slideLayout")
    slides = _parts(package, "ppt/slides/slide")
    roots = {part: package.xml(part) for part in masters + layouts + slides}
    layout_master = {part: _related_part(package, part, MASTER_REL) for part in layouts}
    slide_layout = {part: _related_part(package, part, LAYOUT_REL) for part in slides}
    slide_numbers = {part: _part_number(part) for part in slides}
    layout_slides = {part: sorted(slide_numbers[slide] for slide in slides if slide_layout[slide] == part) for part in layouts}
    master_slides = {
        part: sorted({number for layout in layouts if layout_master[layout] == part for number in layout_slides[layout]})
        for part in masters
    }
    fonts_by_master = {
        part: _theme_fonts(theme, _related_part(package, part, THEME_REL))
        for part in masters
    }

    shapes = {part: _text_shapes(root) for part, root in roots.items()}
    templates = []
    instances = []

    for part in masters + layouts:
        is_layout = part in layouts
        master = layout_master.get(part) if is_layout else part
        theme_fonts = fonts_by_master.get(master, _theme_fonts(theme))
        for shape in shapes[part]:
            parent = _match_placeholder(shapes.get(master, []), shape) if is_layout and master else None
            inherited = _base_styles(roots.get(master), shape, theme_fonts) if master else {}
            if parent is not None:
                inherited = _merge_levels(inherited, _local_levels(parent))
            levels = _resolve_level_colors(_merge_levels(inherited, _local_levels(shape)), theme_map)
            family_levels = _resolve_theme_fonts(levels, theme_fonts)
            geometry = _geometry(shape) or _geometry(parent)
            if not is_shape_visible(shape) or not is_within_slide(geometry, slide_size):
                continue
            template = _serialize_slot(
                shape, part, "layout" if is_layout else "master", family_levels,
                geometry, layout_slides.get(part, []) if is_layout else master_slides.get(part, []),
                body_properties={**_body_properties(parent), **_body_properties(shape)},
                inherited_from=master if parent is not None else None,
                slide_size=slide_size,
            )
            templates.append(template)

    for part in slides:
        layout = slide_layout[part]
        master = layout_master.get(layout)
        theme_fonts = fonts_by_master.get(master, _theme_fonts(theme))
        for shape in shapes[part]:
            layout_shape = _match_placeholder(shapes.get(layout, []), shape)
            master_shape = _match_placeholder(shapes.get(master, []), layout_shape if layout_shape is not None else shape)
            levels = _base_styles(roots.get(master), shape, theme_fonts) if master else {}
            if master_shape is not None:
                levels = _merge_levels(levels, _local_levels(master_shape))
            if layout_shape is not None:
                levels = _merge_levels(levels, _local_levels(layout_shape))
            levels = _resolve_theme_fonts(
                _resolve_level_colors(_merge_levels(levels, _local_levels(shape)), theme_map),
                theme_fonts,
            )
            geometry = _geometry(shape) or _geometry(layout_shape) or _geometry(master_shape)
            if use_visible_slides and (not is_shape_visible(shape) or not is_within_slide(geometry, slide_size)):
                continue
            instances.append(_serialize_slot(
                shape, part, "slide", levels, geometry, [slide_numbers[part]],
                body_properties={**_body_properties(master_shape), **_body_properties(layout_shape), **_body_properties(shape)},
                inherited_from=layout if layout_shape is not None else master if master_shape is not None else None,
                slide_size=slide_size,
                layout_source=layout,
            ))

    # Every level of every slot matters: lower bullet levels and slide overrides
    # can define sizes absent from the first level of a layout placeholder.
    template_counts = Counter()
    slide_counts = Counter()
    heights_by_style = {}
    heights_by_size = {}
    style_sources = [(instances, slide_counts)]
    if not use_visible_slides:
        style_sources.insert(0, (templates, template_counts))
    for slots, counter in style_sources:
        for slot in slots:
            if use_visible_slides and not slot.get("visible_on_slide", True):
                continue
            for level in slot["levels"]:
                if level.get("size_pt") is not None:
                    key = (level.get("family") or "Наследуется", level["size_pt"])
                    counter[key] += 1
                    height = level.get("line_height_pt")
                    if height is not None:
                        heights_by_style.setdefault(key, Counter())[height] += 1
                        heights_by_size.setdefault(level["size_pt"], Counter())[height] += 1
    scale_counts = slide_counts if use_visible_slides else template_counts + slide_counts
    slot_styles = []
    for (family, size), count in sorted(scale_counts.items(), key=lambda item: (-item[1], item[0][0], item[0][1])):
        exact_heights = heights_by_style.get((family, size), Counter())
        size_heights = heights_by_size.get(size, Counter())
        selected_heights = exact_heights or size_heights
        common_height = sorted(selected_heights.items(), key=lambda item: (-item[1], item[0]))[0][0] if selected_heights else None
        slot_styles.append({
            "family": family,
            "size_pt": size,
            "occurrences": count,
            "template_occurrences": template_counts[(family, size)],
            "slide_occurrences": slide_counts[(family, size)],
            "line_height_pt": common_height,
            "line_height_source": "font_size" if exact_heights else "size" if size_heights else None,
            "line_height_samples": selected_heights[common_height] if common_height is not None else 0,
            "line_height_variants": [
                {"height_pt": height, "occurrences": uses}
                for height, uses in sorted(selected_heights.items(), key=lambda item: (-item[1], item[0]))
            ],
        })
    return {
        "templates": templates,
        "slide_instances": instances,
        "slot_styles": slot_styles,
        "summary": {
            "template_slots": len(templates),
            "empty_template_slots": sum(slot["empty"] for slot in templates),
            "slide_slots": len(instances),
            "empty_slide_slots": sum(slot["empty"] for slot in instances),
            "uses_visible_slide_text": use_visible_slides,
        },
    }


def _parts(package, prefix):
    return [part for part in package.list(prefix) if re.search(r"\d+\.xml$", part) and "/_rels/" not in part]


def _part_number(part):
    match = re.search(r"(\d+)\.xml$", part)
    return int(match.group(1)) if match else None


def _related_part(package, source, relation_type):
    rels = posixpath.join(posixpath.dirname(source), "_rels", posixpath.basename(source) + ".rels")
    if not package.exists(rels):
        return None
    for relation in package.xml(rels).findall("r:Relationship", NS):
        if relation.get("Type") != relation_type or relation.get("TargetMode") == "External":
            continue
        target = relation.get("Target")
        if target:
            return posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(source), target))
    return None


def _text_shapes(root):
    if root is None:
        return []
    result = []
    for shape in root.findall(".//p:sp", NS):
        placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
        if shape.find("p:txBody", NS) is not None or (placeholder is not None and placeholder.get("type", "obj") in TEXT_PLACEHOLDERS):
            result.append(shape)
    return result


def _placeholder(shape):
    return shape.find("p:nvSpPr/p:nvPr/p:ph", NS) if shape is not None else None


def _match_placeholder(candidates, shape):
    placeholder = _placeholder(shape)
    if placeholder is None:
        return None
    kind = placeholder.get("type", "obj")
    idx = placeholder.get("idx", "0")
    matches = [candidate for candidate in candidates if _placeholder(candidate) is not None]
    for candidate in matches:
        other = _placeholder(candidate)
        if other.get("idx", "0") == idx and other.get("type", "obj") == kind:
            return candidate
    for candidate in matches:
        other = _placeholder(candidate)
        if other.get("idx", "0") == idx:
            return candidate
    for candidate in matches:
        if _placeholder(candidate).get("type", "obj") == kind:
            return candidate
    return None


def _base_styles(master_root, shape, theme_fonts):
    if master_root is None:
        return {}
    placeholder = _placeholder(shape)
    kind = placeholder.get("type", "obj") if placeholder is not None else "obj"
    category = "titleStyle" if kind in {"title", "ctrTitle"} else "bodyStyle" if kind in {"body", "subTitle"} else "otherStyle"
    tx_styles = master_root.find("p:txStyles", NS)
    style = tx_styles.find(f"p:{category}", NS) if tx_styles is not None else None
    levels = _levels_from_list(style)
    default_family = theme_fonts.get("+mj-lt" if category == "titleStyle" else "+mn-lt")
    if default_family:
        for values in levels.values():
            values.setdefault("family", default_family)
    return levels


def _local_levels(shape):
    if shape is None:
        return {}
    body = shape.find("p:txBody", NS)
    if body is None:
        return {}
    levels = _levels_from_list(body.find("a:lstStyle", NS))
    for paragraph in body.findall("a:p", NS):
        ppr = paragraph.find("a:pPr", NS)
        try:
            level = int(ppr.get("lvl", "0")) + 1 if ppr is not None else 1
        except ValueError:
            level = 1
        values = _paragraph_style(ppr)
        # endParaRPr can describe an empty paragraph's intended font/size.
        if not any((run.find("a:t", NS) is not None and (run.find("a:t", NS).text or "").strip()) for run in paragraph.findall("a:r", NS)):
            for run in paragraph.findall("a:r", NS):
                values.update(_run_style(run.find("a:rPr", NS)))
            values.update(_run_style(paragraph.find("a:endParaRPr", NS)))
        if values:
            levels[level] = {**levels.get(level, {}), **values}
    return levels


def _levels_from_list(style):
    if style is None:
        return {}
    levels = {}
    default = _paragraph_style(style.find("a:defPPr", NS))
    for level in range(1, 10):
        ppr = style.find(f"a:lvl{level}pPr", NS)
        values = {**default, **_paragraph_style(ppr)}
        if values:
            levels[level] = values
    return levels


def _paragraph_style(ppr):
    if ppr is None:
        return {}
    values = _run_style(ppr.find("a:defRPr", NS))
    if ppr.get("algn"):
        values["alignment"] = ppr.get("algn")
    spacing = ppr.find("a:lnSpc", NS)
    if spacing is not None and len(spacing):
        child = spacing[0]
        raw = child.get("val")
        if raw is not None:
            try:
                values["line_spacing"] = int(raw) / (100000 if child.tag.endswith("spcPct") else 100)
                values["line_spacing_unit"] = "ratio" if child.tag.endswith("spcPct") else "pt"
            except ValueError:
                pass
    for attribute, key in [("marL", "margin_left_pt"), ("indent", "indent_pt")]:
        raw = ppr.get(attribute)
        if raw is not None:
            try:
                values[key] = round(int(raw) / EMU_PER_PT, 2)
            except ValueError:
                pass
    for tag, key in [("spcBef", "space_before_pt"), ("spcAft", "space_after_pt")]:
        node = ppr.find(f"a:{tag}", NS)
        if node is None:
            continue
        pts = node.find("a:spcPts", NS)
        if pts is not None and pts.get("val") is not None:
            try:
                values[key] = round(int(pts.get("val")) / 100, 2)
            except ValueError:
                pass
    if ppr.find("a:buNone", NS) is not None:
        values["bullet_kind"] = "none"
    elif ppr.find("a:buChar", NS) is not None or ppr.find("a:buAutoNum", NS) is not None:
        values["bullet_kind"] = "char"
    return values


def _run_style(rpr):
    if rpr is None:
        return {}
    values = {}
    latin = rpr.find("a:latin", NS)
    if latin is not None and latin.get("typeface"):
        values["family"] = latin.get("typeface")
    for attribute, key, divisor in [("sz", "size_pt", 100), ("spc", "letter_spacing_pt", 100)]:
        raw = rpr.get(attribute)
        if raw is not None:
            try:
                values[key] = int(raw) / divisor
            except ValueError:
                pass
    for attribute, key in [("b", "bold"), ("i", "italic")]:
        if rpr.get(attribute) is not None:
            values[key] = rpr.get(attribute) in {"1", "true", "True"}
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
        parsed = resolve_color_node(solid[0], {}, placeholder_color=None)
        if parsed:
            values["color"] = parsed.get("color")
            if parsed.get("scheme"):
                values["color_scheme"] = parsed["scheme"]
            if parsed.get("alpha") is not None and parsed.get("alpha") < 0.999:
                values["alpha"] = parsed.get("alpha")
        else:
            color_node = solid[0]
            tag = color_node.tag.rsplit("}", 1)[-1]
            if tag == "schemeClr" and color_node.get("val"):
                values["color_scheme"] = color_node.get("val")
            elif tag == "srgbClr" and color_node.get("val"):
                values["color"] = _normalize_hex(color_node.get("val"))
            elif tag == "sysClr":
                raw = color_node.get("lastClr") or color_node.get("val")
                if raw:
                    values["color"] = _normalize_hex(raw)
    return values


def _resolve_level_colors(levels: dict, theme_map: dict) -> dict:
    result = {}
    for level, values in levels.items():
        resolved = values.copy()
        scheme = resolved.get("color_scheme")
        if scheme:
            resolved["color"] = theme_map.get(scheme) or resolved.get("color")
        result[level] = resolved
    return result


def _merge_levels(base, override):
    result = {level: values.copy() for level, values in base.items()}
    for level, values in override.items():
        result[level] = {**result.get(level, {}), **values}
    return result


def _theme_fonts(theme, source=None):
    themes = theme.get("themes", [])
    selected = next((item for item in themes if item.get("source") == source), None) if source else None
    fonts = (selected or themes[0]).get("fonts", {}) if themes else {}
    return {"+mj-lt": fonts.get("major", {}).get("latin"), "+mn-lt": fonts.get("minor", {}).get("latin")}


def _resolve_theme_fonts(levels, fonts):
    result = {}
    for level, values in levels.items():
        resolved = values.copy()
        family = resolved.get("family")
        if family in fonts and fonts[family]:
            resolved["family"] = fonts[family]
        result[level] = resolved
    return result


def _geometry(shape):
    return _shape_geometry(shape)


def _body_properties(shape):
    if shape is None:
        return {}
    body = shape.find("p:txBody/a:bodyPr", NS)
    if body is None:
        return {}
    values = {}
    for attribute, key in [("anchor", "vertical_anchor"), ("wrap", "wrap")]:
        if body.get(attribute) is not None:
            values[key] = body.get(attribute)
    for attribute, key in [("lIns", "left_inset_pt"), ("rIns", "right_inset_pt"),
                           ("tIns", "top_inset_pt"), ("bIns", "bottom_inset_pt")]:
        if body.get(attribute) is not None:
            try:
                values[key] = round(int(body.get(attribute)) / 12700, 2)
            except ValueError:
                pass
    return values


def _line_height(style):
    size = style.get("size_pt")
    spacing = style.get("line_spacing")
    if size is None or spacing is None:
        return None
    if style.get("line_spacing_unit") == "ratio":
        if not line_height_applicable(spacing, size_pt=size):
            return None
        return round(size * spacing, 2)
    if style.get("line_spacing_unit") == "pt":
        if not line_height_applicable(size_pt=size, line_height_pt=spacing):
            return None
        return round(spacing, 2)
    return None


def resolve_shape_text_levels(
    package: PPTXPackage,
    slide_part: str,
    shape,
    theme: dict,
    theme_map: dict | None = None,
) -> dict[int, dict]:
    """Merge master → layout → slide text styles for one shape (same chain as extract_text_slots)."""
    theme_map = theme_map or _build_theme_map(theme)
    layout = _related_part(package, slide_part, LAYOUT_REL)
    master = _related_part(package, layout, MASTER_REL) if layout else None
    theme_part = _related_part(package, master, THEME_REL) if master else None
    theme_fonts = _theme_fonts(theme, theme_part)

    roots = {}
    shapes = {}
    if master:
        roots[master] = package.xml(master)
        shapes[master] = _text_shapes(roots[master])
    if layout:
        roots[layout] = package.xml(layout)
        shapes[layout] = _text_shapes(roots[layout])

    layout_shape = _match_placeholder(shapes.get(layout, []), shape) if layout else None
    master_shape = (
        _match_placeholder(shapes.get(master, []), layout_shape if layout_shape is not None else shape)
        if master
        else None
    )

    levels = _base_styles(roots.get(master), shape, theme_fonts) if master else {}
    if master_shape is not None:
        levels = _merge_levels(levels, _local_levels(master_shape))
    if layout_shape is not None:
        levels = _merge_levels(levels, _local_levels(layout_shape))
    return _resolve_theme_fonts(
        _resolve_level_colors(_merge_levels(levels, _local_levels(shape)), theme_map),
        theme_fonts,
    )


def effective_run_typography(
    levels: dict[int, dict],
    paragraph,
    rpr,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
) -> dict:
    """Resolve final run typography including placeholder/lstStyle inheritance."""
    ppr = paragraph.find("a:pPr", NS)
    try:
        level = int(ppr.get("lvl", "0")) + 1 if ppr is not None else 1
    except ValueError:
        level = 1

    run_style = _run_style(rpr)
    merged = dict(levels.get(level) or levels.get(1) or {})
    merged.update(_paragraph_style(ppr))
    merged.update(run_style)

    if run_style.get("color_scheme"):
        merged["color"] = theme_map.get(run_style["color_scheme"])
    elif run_style.get("color"):
        merged["color"] = run_style["color"]
    elif merged.get("color_scheme") and not merged.get("color"):
        merged["color"] = theme_map.get(merged["color_scheme"])

    solid = rpr.find("a:solidFill", NS) if rpr is not None else None
    if solid is not None and len(solid):
        parsed = resolve_color_node(solid[0], theme_map)
        if parsed:
            merged["color"] = parsed.get("color")
            if parsed.get("alpha") is not None and parsed.get("alpha") < 0.999:
                merged["alpha"] = parsed.get("alpha")

    family = merged.get("family") or "Arial"
    if family in theme_fonts and theme_fonts[family]:
        family = theme_fonts[family]

    size_pt = merged.get("size_pt")
    typography = {
        "family": family,
        "size_pt": round(size_pt, 2) if size_pt is not None else 14,
        "bold": bool(merged.get("bold")),
        "italic": bool(merged.get("italic")),
        "color": merged.get("color"),
    }
    if merged.get("underline"):
        typography["underline"] = merged["underline"]
    if merged.get("strike"):
        typography["strike"] = bool(merged["strike"])
    if merged.get("alpha") is not None and merged.get("alpha") < 0.999:
        typography["alpha"] = merged.get("alpha")
    if not typography.get("color"):
        typography["color"] = theme_map.get("tx1") or theme_map.get("dk1")
    return typography


def _serialize_slot(shape, source, source_type, levels, geometry, slide_numbers, body_properties, inherited_from, slide_size=None, layout_source=None):
    placeholder = _placeholder(shape)
    identity = shape.find("p:nvSpPr/p:cNvPr", NS)
    body = shape.find("p:txBody", NS)
    text = "".join(node.text or "" for node in body.findall(".//a:t", NS)) if body is not None else ""
    visible_on_slide = is_within_slide(geometry, slide_size)
    return {
        "source": source,
        "source_type": source_type,
        "shape_id": identity.get("id") if identity is not None else None,
        "name": identity.get("name") if identity is not None else None,
        "kind": "placeholder" if placeholder is not None else "text_box" if shape.find("p:nvSpPr/p:cNvSpPr", NS) is not None and shape.find("p:nvSpPr/p:cNvSpPr", NS).get("txBox") == "1" else "shape_text",
        "placeholder_type": placeholder.get("type", "obj") if placeholder is not None else None,
        "placeholder_idx": placeholder.get("idx", "0") if placeholder is not None else None,
        "empty": not bool(text.strip()),
        "text_sample": text.strip()[:120],
        "geometry": geometry,
        "visible_on_slide": visible_on_slide,
        "slide_coverage": geometry_coverage(geometry, slide_size) if visible_on_slide else 0.0,
        "body": body_properties,
        "levels": [{"level": level, **values, "line_height_pt": _line_height(values)} for level, values in sorted(levels.items())],
        "slide_numbers": slide_numbers,
        "inherited_from": inherited_from,
        "layout_source": layout_source,
    }
