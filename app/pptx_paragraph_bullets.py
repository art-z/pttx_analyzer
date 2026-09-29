"""Apply catalog paragraph bullets and hanging indents to python-pptx paragraphs."""

from __future__ import annotations

from typing import Any

from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn

EMU_PER_PT = 12700


def pt_to_emu(value: float | int | None) -> int:
    return int(round(float(value or 0) * EMU_PER_PT))


def _hex_to_srgb(value: str | None) -> str | None:
    if not value or not isinstance(value, str):
        return None
    cleaned = value.strip().lstrip("#")
    return cleaned.upper() if len(cleaned) == 6 else None


def apply_paragraph_margins(paragraph, spacing: dict | None) -> None:
    spacing = spacing or {}
    margin_left = spacing.get("margin_left")
    if margin_left is None:
        margin_left = spacing.get("margin_left_pt")
    indent = spacing.get("indent")
    if indent is None:
        indent = spacing.get("indent_pt")
    if margin_left is None and indent is None:
        return
    p_pr = paragraph._p.get_or_add_pPr()
    if margin_left is not None:
        p_pr.set("marL", str(pt_to_emu(margin_left)))
    if indent is not None:
        p_pr.set("indent", str(pt_to_emu(indent)))


def _remove_bullet_nodes(p_pr) -> None:
    for tag in ("a:buNone", "a:buChar", "a:buAutoNum", "a:buClr", "a:buFont", "a:buSzPts", "a:buSzPct"):
        node = p_pr.find(qn(tag))
        if node is not None:
            p_pr.remove(node)


def apply_paragraph_bullet(paragraph, bullet: dict | None) -> None:
    if not bullet or bullet.get("kind") in {None, "none"}:
        return

    p_pr = paragraph._p.get_or_add_pPr()
    _remove_bullet_nodes(p_pr)

    kind = bullet.get("kind")
    if kind == "char" and bullet.get("char"):
        marker = parse_xml(f'<a:buChar {nsdecls("a")} char="{_xml_attr(bullet["char"])}"/>')
        p_pr.insert_element_before(marker, "a:defRPr")
    elif kind == "auto":
        num_type = bullet.get("num_type") or "arabicPeriod"
        start_at = int(bullet.get("start_at") or 1)
        marker = parse_xml(
            f'<a:buAutoNum {nsdecls("a")} type="{_xml_attr(num_type)}" startAt="{start_at}"/>'
        )
        p_pr.insert_element_before(marker, "a:defRPr")
    else:
        return

    size_pt = bullet.get("size_pt")
    if size_pt is not None:
        bu_size = parse_xml(
            f'<a:buSzPts {nsdecls("a")} val="{int(round(float(size_pt) * 100))}"/>'
        )
        p_pr.insert_element_before(bu_size, "a:defRPr")

    font = bullet.get("font")
    if font:
        bu_font = parse_xml(f'<a:buFont {nsdecls("a")} typeface="{_xml_attr(font)}"/>')
        p_pr.insert_element_before(bu_font, "a:defRPr")

    srgb = _hex_to_srgb(bullet.get("color"))
    if srgb:
        bu_color = parse_xml(
            f'<a:buClr {nsdecls("a")}><a:srgbClr val="{srgb}"/></a:buClr>'
        )
        p_pr.insert_element_before(bu_color, "a:defRPr")


def _xml_attr(value: Any) -> str:
    text = str(value or "")
    return (
        text.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
