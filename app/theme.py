from __future__ import annotations

import posixpath

from .pptx import PPTXPackage

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}

REL_NS = {
    "r": "http://schemas.openxmlformats.org/package/2006/relationships",
}

THEME_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"


def extract_theme(package: PPTXPackage) -> dict:
    """
    Extract all PPTX themes, but also mark which themes are actually used
    by slide masters.

    Important:
    PPTX files may contain old / unused / service themes. If we blindly use
    the first ppt/theme/theme*.xml, colors can be resolved through the wrong
    palette.
    """
    usage_by_theme = _theme_usage_by_masters(package)

    themes = []
    for part in package.list("ppt/theme/"):
        if not part.endswith(".xml"):
            continue

        root = package.xml(part)
        usage_count = usage_by_theme.get(part, 0)

        themes.append({
            "source": part,
            "name": root.get("name"),
            "colors": _extract_colors(root),
            "fonts": _extract_fonts(root),
            "usage_count": usage_count,
            "is_used_by_master": usage_count > 0,
        })

    themes.sort(
        key=lambda item: (
            -int(item.get("usage_count") or 0),
            item.get("source") or "",
        )
    )

    primary_theme_source = themes[0]["source"] if themes else None

    return {
        "primary_theme_source": primary_theme_source,
        "themes": themes,
    }


def _theme_usage_by_masters(package: PPTXPackage) -> dict[str, int]:
    """
    Count how many slide masters reference each theme.

    slideMaster*.xml normally has a relationship to ppt/theme/theme*.xml.
    That relationship is more reliable than taking the first theme file.
    """
    usage: dict[str, int] = {}

    for master_part in package.list("ppt/slideMasters/"):
        if not master_part.endswith(".xml"):
            continue

        theme_part = _related_theme_part(package, master_part)
        if not theme_part:
            continue

        usage[theme_part] = usage.get(theme_part, 0) + 1

    return usage


def _related_theme_part(package: PPTXPackage, source_part: str) -> str | None:
    rels_part = posixpath.join(
        posixpath.dirname(source_part),
        "_rels",
        posixpath.basename(source_part) + ".rels",
    )

    if not package.exists(rels_part):
        return None

    root = package.xml(rels_part)

    for rel in root.findall("r:Relationship", REL_NS):
        if rel.get("Type") != THEME_REL_TYPE:
            continue

        target = rel.get("Target")
        if not target:
            continue

        if target.startswith("/"):
            return posixpath.normpath(target.lstrip("/"))

        return posixpath.normpath(
            posixpath.join(posixpath.dirname(source_part), target)
        )

    return None


def _extract_colors(root) -> dict:
    result = {}
    clr_scheme = root.find(".//a:clrScheme", NS)
    if clr_scheme is None:
        return result

    for node in clr_scheme:
        key = _local_name(node.tag)
        if len(node) == 0:
            continue

        color = node[0]
        result[key] = {
            "type": _local_name(color.tag),
            "value": color.get("val") or color.get("lastClr"),
        }

    return result


def _extract_fonts(root) -> dict:
    font_scheme = root.find(".//a:fontScheme", NS)
    if font_scheme is None:
        return {}

    result = {"name": font_scheme.get("name")}

    major = font_scheme.find("a:majorFont", NS)
    minor = font_scheme.find("a:minorFont", NS)

    if major is not None:
        result["major"] = _font_group(major)

    if minor is not None:
        result["minor"] = _font_group(minor)

    return result


def _font_group(node) -> dict:
    result = {
        "latin": None,
        "east_asian": None,
        "complex_script": None,
        "scripts": {},
    }

    latin = node.find("a:latin", NS)
    ea = node.find("a:ea", NS)
    cs = node.find("a:cs", NS)

    if latin is not None:
        result["latin"] = latin.get("typeface")

    if ea is not None:
        result["east_asian"] = ea.get("typeface")

    if cs is not None:
        result["complex_script"] = cs.get("typeface")

    for font in node.findall("a:font", NS):
        script = font.get("script")
        typeface = font.get("typeface")

        if script and typeface:
            result["scripts"][script] = typeface

    return result


def _local_name(tag: str) -> str:
    return tag.split("}")[-1]