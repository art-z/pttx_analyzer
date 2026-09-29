"""Resolve catalog typography families to embeddable font files."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

FONT_ALIASES_FILE = "font-aliases.json"
STYLE_SLOTS = ("regular", "bold", "italic", "boldItalic")


@dataclass
class EmbeddedFontFace:
    slot: str
    path: Path


@dataclass
class EmbeddedFontFamily:
    typeface: str
    faces: dict[str, EmbeddedFontFace] = field(default_factory=dict)


def load_font_aliases(fonts_root: Path) -> dict[str, Any]:
    aliases_path = fonts_root / FONT_ALIASES_FILE
    if not aliases_path.is_file():
        return {}
    payload = json.loads(aliases_path.read_text(encoding="utf-8"))
    return dict(payload.get("aliases") or {})


def _looks_like_typography(value: dict[str, Any]) -> bool:
    if not value.get("family"):
        return False
    return any(key in value for key in ("size_pt", "bold", "italic", "color", "alignment"))


def iter_typography_nodes(report: dict[str, Any]) -> Iterator[dict[str, Any]]:
    stack: list[Any] = [report]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if _looks_like_typography(current):
                yield current
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def _style_keys(*, bold: bool, italic: bool) -> list[str]:
    if bold and italic:
        return ["boldItalic", "bolditalic", "bold_italic"]
    if bold:
        return ["bold", "demibold", "semibold", "medium"]
    if italic:
        return ["italic", "oblique"]
    return ["regular", "medium"]


def resolve_alias_font_path(
    alias: dict[str, Any],
    fonts_root: Path,
    *,
    bold: bool = False,
    italic: bool = False,
) -> Path | None:
    styles = alias.get("styles") or {}
    for key in _style_keys(bold=bold, italic=italic):
        relative = styles.get(key)
        if not relative:
            continue
        path = fonts_root / relative
        if path.is_file():
            return path
    fallback = styles.get("regular")
    if fallback:
        path = fonts_root / fallback
        if path.is_file():
            return path
    return None


def _slot_for_style(*, bold: bool, italic: bool) -> str:
    if bold and italic:
        return "boldItalic"
    if bold:
        return "bold"
    if italic:
        return "italic"
    return "regular"


def collect_embeddable_fonts(report: dict[str, Any], fonts_root: Path) -> list[EmbeddedFontFamily]:
    aliases = load_font_aliases(fonts_root)
    if not aliases:
        return []

    families: dict[str, EmbeddedFontFamily] = {}
    for typography in iter_typography_nodes(report):
        family = str(typography.get("family") or "").strip()
        if not family:
            continue
        alias = aliases.get(family)
        if not alias:
            continue

        bold = bool(typography.get("bold"))
        italic = bool(typography.get("italic"))
        slot = _slot_for_style(bold=bold, italic=italic)
        font_path = resolve_alias_font_path(alias, fonts_root, bold=bold, italic=italic)
        if font_path is None:
            continue

        entry = families.setdefault(family, EmbeddedFontFamily(typeface=family))
        entry.faces.setdefault(slot, EmbeddedFontFace(slot=slot, path=font_path))

    return [family for family in families.values() if family.faces]
