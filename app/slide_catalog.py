"""Build a canonical catalog of all slides with template background and content elements."""

from __future__ import annotations

import copy
import posixpath
import re
from collections import Counter

from .pptx import PPTXPackage
from .slide_geometry import slide_size_pt
from .template_layers import (
    apply_slide_background_override,
    build_slide_content_layers,
    build_template_render,
)

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
LAYOUT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
MASTER_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"


def extract_slide_catalog(
    package: PPTXPackage,
    theme: dict,
    slide_templates: dict | None,
    slide_size: tuple[float, float] | None = None,
) -> dict:
    slide_size = slide_size or slide_size_pt(package)
    if not slide_size:
        return {"slides": [], "summary": {"slide_count": 0}}

    templates = (slide_templates or {}).get("templates", [])
    template_by_layout = {item["layout_source"]: item for item in templates}
    layout_meta = {
        item["layout_source"]: {
            "layout_name": item.get("layout_name"),
            "template_id": item.get("template_id"),
        }
        for item in templates
    }

    layouts = _layout_parts(package)
    presentation_order = _presentation_slide_order(package)
    layout_master = {
        layout: _related_part(package, layout, MASTER_REL)
        for layout in layouts
    }
    layout_names = {
        layout: _layout_name(package, layout)
        for layout in layouts
    }

    slides = []
    kind_totals: Counter = Counter()

    for slide_part in _slide_parts(package):
        slide_number = _part_number(slide_part)
        if slide_number is None:
            continue
        layout_source = _related_part(package, slide_part, LAYOUT_REL)
        master_source = layout_master.get(layout_source or "")
        template = template_by_layout.get(layout_source or "")

        if template and template.get("render"):
            render = copy.deepcopy(template["render"])
        elif layout_source:
            render = build_template_render(
                package,
                layout_source,
                master_source,
                slide_size,
                theme,
            )
        else:
            render = {
                "slide_size_pt": {"width": slide_size[0], "height": slide_size[1]},
                "background_color": None,
                "layers": [],
            }

        render = apply_slide_background_override(
            package,
            slide_part,
            render,
            slide_size,
            theme,
        )

        content_elements = build_slide_content_layers(
            package,
            slide_part,
            slide_size,
            theme,
        )
        element_summary = dict(Counter(element.get("kind", "unknown") for element in content_elements))
        kind_totals.update(element_summary)

        meta = layout_meta.get(layout_source or "", {})
        slides.append({
            "slide_number": slide_number,
            "presentation_order": presentation_order.get(slide_part),
            "slide_source": slide_part,
            "layout_source": layout_source,
            "layout_name": meta.get("layout_name") or layout_names.get(layout_source or ""),
            "layout_file": posixpath.basename(layout_source) if layout_source else None,
            "template_id": meta.get("template_id"),
            "has_template_profile": template is not None,
            "render": render,
            "content_elements": content_elements,
            "element_summary": element_summary,
            "element_count": len(content_elements),
        })

    slides.sort(key=lambda item: item["slide_number"])
    return {
        "slides": slides,
        "summary": {
            "slide_count": len(slides),
            "layout_count": len({slide["layout_source"] for slide in slides if slide.get("layout_source")}),
            "template_linked_slides": sum(1 for slide in slides if slide.get("template_id")),
            "element_totals": dict(kind_totals),
        },
    }


def _slide_parts(package: PPTXPackage) -> list[str]:
    return sorted(
        part for part in package.list("ppt/slides/")
        if re.search(r"slide\d+\.xml$", part)
    )


def _presentation_slide_order(package: PPTXPackage) -> dict[str, int]:
    """Map slide parts to their true order in ppt/presentation.xml.

    Slide part filenames are identifiers, not presentation order. Keep the
    existing slide_number stable for report references and expose the ordinal
    separately for logic that depends on first/last position.
    """
    presentation = "ppt/presentation.xml"
    relationships = "ppt/_rels/presentation.xml.rels"
    if not package.exists(presentation) or not package.exists(relationships):
        return {}

    relation_targets = {}
    for relation in package.xml(relationships).findall("r:Relationship", REL_NS):
        relation_type = relation.get("Type") or ""
        if not relation_type.endswith("/slide") or relation.get("TargetMode") == "External":
            continue
        relation_id = relation.get("Id")
        target = relation.get("Target")
        if not relation_id or not target:
            continue
        if target.startswith("/"):
            part = posixpath.normpath(target.lstrip("/"))
        else:
            part = posixpath.normpath(posixpath.join("ppt", target))
        relation_targets[relation_id] = part

    root = package.xml(presentation)
    slide_ids = root.findall("p:sldIdLst/p:sldId", NS)
    result = {}
    for order, slide_id in enumerate(slide_ids, start=1):
        relation_id = slide_id.get("{%s}id" % DOC_REL_NS)
        part = relation_targets.get(relation_id)
        if part:
            result[part] = order
    return result


def _layout_parts(package: PPTXPackage) -> list[str]:
    return sorted(
        part for part in package.list("ppt/slideLayouts/")
        if re.search(r"slideLayout\d+\.xml$", part)
    )


def _part_number(part: str) -> int | None:
    match = re.search(r"(\d+)\.xml$", part)
    return int(match.group(1)) if match else None


def _related_part(package: PPTXPackage, source: str, relation_type: str) -> str | None:
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


def _layout_name(package: PPTXPackage, layout_source: str) -> str:
    root = package.xml(layout_source)
    c_sld = root.find("p:cSld", NS)
    if c_sld is not None and c_sld.get("name"):
        return c_sld.get("name")
    return posixpath.basename(layout_source)
