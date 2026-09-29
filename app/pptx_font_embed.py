"""Embed font binaries into an editable PPTX package."""

from __future__ import annotations

import io
import zipfile
from typing import Iterable

from lxml import etree

from .font_registry import STYLE_SLOTS, EmbeddedFontFamily

P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
FONT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"


def _next_relationship_id(rels_root: etree._Element) -> str:
    used: set[int] = set()
    for rel in rels_root.findall(f"{{{PKG_REL_NS}}}Relationship"):
        rel_id = rel.get("Id") or ""
        if rel_id.startswith("rId") and rel_id[3:].isdigit():
            used.add(int(rel_id[3:]))
    next_id = max(used, default=0) + 1
    return f"rId{next_id}"


def _ensure_fntdata_default(content_types: etree._Element) -> None:
    for default in content_types.findall(f"{{{CT_NS}}}Default"):
        if default.get("Extension") == "fntdata":
            return
    default = etree.SubElement(content_types, f"{{{CT_NS}}}Default")
    default.set("Extension", "fntdata")
    default.set("ContentType", "application/x-fontdata")


def _remove_existing_embedded_fonts(presentation: etree._Element, rels_root: etree._Element) -> None:
    font_targets: set[str] = set()
    for rel in rels_root.findall(f"{{{PKG_REL_NS}}}Relationship"):
        if rel.get("Type") == FONT_REL_TYPE:
            target = rel.get("Target") or ""
            font_targets.add(f"ppt/{target}")
            rels_root.remove(rel)

    existing = presentation.find(f"{{{P_NS}}}embeddedFontLst")
    if existing is not None:
        presentation.remove(existing)

    return None


def _insert_embedded_font_list(presentation: etree._Element, font_list: etree._Element) -> None:
    notes_size = presentation.find(f"{{{P_NS}}}notesSz")
    if notes_size is not None:
        index = list(presentation).index(notes_size) + 1
        presentation.insert(index, font_list)
        return
    default_style = presentation.find(f"{{{P_NS}}}defaultTextStyle")
    if default_style is not None:
        index = list(presentation).index(default_style)
        presentation.insert(index, font_list)
        return
    presentation.append(font_list)


def embed_fonts_in_pptx(pptx_bytes: bytes, families: Iterable[EmbeddedFontFamily]) -> bytes:
    families = [family for family in families if family.faces]
    if not families:
        return pptx_bytes

    input_buffer = io.BytesIO(pptx_bytes)
    output_buffer = io.BytesIO()

    with zipfile.ZipFile(input_buffer, "r") as source:
        names = source.namelist()
        presentation = etree.fromstring(source.read("ppt/presentation.xml"))
        rels_root = etree.fromstring(source.read("ppt/_rels/presentation.xml.rels"))
        content_types = etree.fromstring(source.read("[Content_Types].xml"))

        _remove_existing_embedded_fonts(presentation, rels_root)
        _ensure_fntdata_default(content_types)

        font_list = etree.Element(f"{{{P_NS}}}embeddedFontLst")
        font_parts: dict[str, bytes] = {}
        font_index = 1

        for family in families:
            embedded_font = etree.SubElement(font_list, f"{{{P_NS}}}embeddedFont")
            font_node = etree.SubElement(embedded_font, f"{{{P_NS}}}font")
            font_node.set("typeface", family.typeface)

            slots_added = 0
            for slot in STYLE_SLOTS:
                face = family.faces.get(slot)
                if face is None:
                    continue
                arcname = f"ppt/fonts/font{font_index}.fntdata"
                font_parts[arcname] = face.path.read_bytes()
                rel_id = _next_relationship_id(rels_root)
                relationship = etree.SubElement(rels_root, f"{{{PKG_REL_NS}}}Relationship")
                relationship.set("Id", rel_id)
                relationship.set("Type", FONT_REL_TYPE)
                relationship.set("Target", arcname.replace("ppt/", ""))
                slot_node = etree.SubElement(embedded_font, f"{{{P_NS}}}{slot}")
                slot_node.set(f"{{{R_NS}}}id", rel_id)
                font_index += 1
                slots_added += 1

            if slots_added == 0:
                font_list.remove(embedded_font)

        if len(font_list) == 0:
            return pptx_bytes

        _insert_embedded_font_list(presentation, font_list)
        presentation.set("embedTrueTypeFonts", "1")
        presentation.set("saveSubsetFonts", "0")

        patched = {
            "ppt/presentation.xml": etree.tostring(
                presentation,
                xml_declaration=True,
                encoding="UTF-8",
                standalone=True,
            ),
            "ppt/_rels/presentation.xml.rels": etree.tostring(
                rels_root,
                xml_declaration=True,
                encoding="UTF-8",
                standalone=True,
            ),
            "[Content_Types].xml": etree.tostring(
                content_types,
                xml_declaration=True,
                encoding="UTF-8",
                standalone=True,
            ),
        }

        with zipfile.ZipFile(output_buffer, "w", zipfile.ZIP_DEFLATED) as target:
            old_font_parts = {
                name
                for name in names
                if name.startswith("ppt/fonts/") and name.endswith(".fntdata")
            }
            for name in names:
                if name in font_parts or name in old_font_parts:
                    continue
                target.writestr(name, patched.get(name, source.read(name)))
            for arcname, payload in font_parts.items():
                target.writestr(arcname, payload, compress_type=zipfile.ZIP_STORED)

    return output_buffer.getvalue()
