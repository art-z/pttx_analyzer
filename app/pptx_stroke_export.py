"""Apply catalog stroke metadata (including line arrow ends) to python-pptx shapes."""

from __future__ import annotations

from typing import Any

from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn


def _xml_attr(value: Any) -> str:
    text = str(value or "")
    return (
        text.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _arrow_end_attrs(end: dict[str, Any]) -> dict[str, str]:
    arrow_type = end.get("type")
    if not arrow_type or arrow_type == "none":
        return {}
    width = end.get("width") or end.get("length") or "med"
    length = end.get("length") or end.get("width") or width
    return {
        "type": _xml_attr(arrow_type),
        "w": _xml_attr(width),
        "len": _xml_attr(length),
    }


def _set_line_arrow_end(ln, tag: str, end: dict[str, Any] | None) -> None:
    qtag = qn(f"a:{tag}")
    existing = ln.find(qtag)
    if existing is not None:
        ln.remove(existing)
    attrs = _arrow_end_attrs(end or {})
    if not attrs:
        return
    attr_text = " ".join(f'{key}="{value}"' for key, value in attrs.items())
    node = parse_xml(f"<a:{tag} {nsdecls('a')} {attr_text}/>")
    ln.append(node)


def apply_line_arrow_ends(shape, stroke: dict[str, Any] | None) -> None:
    if not stroke:
        return
    head = stroke.get("head")
    tail = stroke.get("tail")
    if not head and not tail:
        return
    ln = shape.line._get_or_add_ln()
    _set_line_arrow_end(ln, "headEnd", head)
    _set_line_arrow_end(ln, "tailEnd", tail)
