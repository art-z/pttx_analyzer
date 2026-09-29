"""Resolve ppt/tableStyles.xml conditional formatting for table cells."""

from __future__ import annotations

import copy
import json
from typing import Any

from .fill_styles import parse_solid_fill, resolve_color_node

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
TABLE_STYLES_PART = "ppt/tableStyles.xml"

INVISIBLE_TABLE_BORDER = {
    "width_pt": 0.0,
    "color": {"kind": "none", "alpha": 0.0},
    "visible": False,
}


def is_invisible_table_border(stroke: dict[str, Any] | None) -> bool:
    if not stroke:
        return True
    if stroke.get("visible") is False:
        return True
    color = stroke.get("color")
    if isinstance(color, dict):
        if color.get("kind") == "none":
            return True
        if float(color.get("alpha", 1.0)) <= 0:
            return True
    return False

STYLE_PART_TAGS = (
    "wholeTbl",
    "band1H",
    "band2H",
    "band1V",
    "band2V",
    "lastCol",
    "firstCol",
    "lastRow",
    "seCell",
    "swCell",
    "firstRow",
    "neCell",
    "nwCell",
)

STYLE_RULE_TOKEN_ALIASES = {
    "firstRow": "first_row_cell",
    "lastRow": "last_row_cell",
    "firstCol": "first_col_cell",
    "lastCol": "last_col_cell",
    "band1H": "band1_row_cell",
    "band2H": "band2_row_cell",
    "band1V": "band1_col_cell",
    "band2V": "band2_col_cell",
    "wholeTbl": "whole_cell",
    "nwCell": "northwest_cell",
    "neCell": "northeast_cell",
    "swCell": "southwest_cell",
    "seCell": "southeast_cell",
}

STYLE_PART_MERGE_ORDER = (
    "wholeTbl",
    "band1H",
    "band2H",
    "band1V",
    "band2V",
    "firstRow",
    "lastRow",
    "firstCol",
    "lastCol",
    "nwCell",
    "neCell",
    "swCell",
    "seCell",
)


def _flag_enabled(node, attribute: str, default: bool = False) -> bool:
    if node is None:
        return default
    raw = node.get(attribute)
    if raw is None:
        return default
    return raw not in {"0", "false", "False", "off", "Off"}


def parse_table_condition_flags(tbl_pr) -> dict[str, bool]:
    return {
        "first_row": _flag_enabled(tbl_pr, "firstRow", default=True),
        "last_row": _flag_enabled(tbl_pr, "lastRow", default=False),
        "first_col": _flag_enabled(tbl_pr, "firstCol", default=False),
        "last_col": _flag_enabled(tbl_pr, "lastCol", default=False),
        "band_row": _flag_enabled(tbl_pr, "bandRow", default=False),
        "band_col": _flag_enabled(tbl_pr, "bandCol", default=False),
    }


def cell_style_part_names(
    flags: dict[str, bool],
    row: int,
    col: int,
    row_count: int,
    col_count: int,
) -> list[str]:
    is_first_row = flags.get("first_row") and row == 0
    is_last_row = flags.get("last_row") and row == row_count - 1
    is_first_col = flags.get("first_col") and col == 0
    is_last_col = flags.get("last_col") and col == col_count - 1
    parts: list[str] = []
    if is_first_row and is_first_col:
        parts.append("nwCell")
    if is_first_row and is_last_col:
        parts.append("neCell")
    if is_last_row and is_first_col:
        parts.append("swCell")
    if is_last_row and is_last_col:
        parts.append("seCell")
    if is_first_row:
        parts.append("firstRow")
    if is_last_row:
        parts.append("lastRow")
    if is_first_col:
        parts.append("firstCol")
    if is_last_col:
        parts.append("lastCol")
    if flags.get("band_row") and not is_first_row and not is_last_row:
        ordinal = row - (1 if flags.get("first_row") else 0)
        parts.append("band2H" if ordinal % 2 else "band1H")
    if flags.get("band_col") and not is_first_col and not is_last_col:
        ordinal = col - (1 if flags.get("first_col") else 0)
        parts.append("band2V" if ordinal % 2 else "band1V")
    parts.append("wholeTbl")
    return parts


def merge_cell_styles(base: dict[str, Any] | None, overlay: dict[str, Any] | None) -> dict[str, Any]:
    if not overlay:
        return dict(base or {})
    result = dict(base or {})
    for key, value in overlay.items():
        if not value:
            continue
        if key == "typography" and isinstance(value, dict):
            merged_typography = dict(result.get("typography") or {})
            for typo_key, typo_value in value.items():
                if typo_value is not None:
                    merged_typography[typo_key] = typo_value
            if merged_typography.get("color") is None and (result.get("typography") or {}).get("color"):
                merged_typography["color"] = result["typography"]["color"]
            if merged_typography:
                result["typography"] = merged_typography
            continue
        if key == "borders" and isinstance(value, dict):
            merged = dict(result.get("borders") or {})
            for side, stroke in value.items():
                if is_invisible_table_border(stroke):
                    merged[side] = dict(INVISIBLE_TABLE_BORDER)
                else:
                    merged[side] = stroke
            if merged:
                result["borders"] = merged
            else:
                result.pop("borders", None)
        else:
            result[key] = value
    return result


def _parse_tc_tx_style(node, theme_map: dict, theme_fonts: dict[str, str | None]) -> dict[str, Any] | None:
    if node is None:
        return None
    typography: dict[str, Any] = {}
    if node.get("b") in {"1", "on", "true", "True"}:
        typography["bold"] = True
    elif node.get("b") in {"0", "off", "false", "False"}:
        typography["bold"] = False
    font_ref = node.find("a:fontRef", NS)
    if font_ref is not None:
        for child in font_ref:
            parsed = resolve_color_node(child, theme_map)
            if parsed:
                typography["color"] = parsed["color"]
                if parsed.get("alpha", 1.0) < 0.999:
                    typography["alpha"] = parsed["alpha"]
                break
    if not typography:
        return None
    if not typography.get("family") and theme_fonts.get("+mn-lt"):
        typography["family"] = theme_fonts["+mn-lt"]
    return typography


def _parse_table_tc_borders(tc_style, theme_map: dict) -> dict[str, Any] | None:
    from .graphic_elements import parse_shape_stroke_from_line

    tc_bdr = tc_style.find("a:tcBdr", NS)
    if tc_bdr is None:
        return None
    borders: dict[str, Any] = {}
    for side, tag in (("left", "left"), ("right", "right"), ("top", "top"), ("bottom", "bottom")):
        wrapper = tc_bdr.find(f"a:{tag}", NS)
        if wrapper is None:
            continue
        line = wrapper.find("a:ln", NS)
        if line is None:
            continue
        parsed = parse_shape_stroke_from_line(line, theme_map)
        if parsed:
            borders[side] = parsed
    return borders or None


def _parse_table_part_style(part, theme_map: dict, theme_fonts: dict[str, str | None]) -> dict[str, Any]:
    from .graphic_elements import _parse_properties_fill

    style: dict[str, Any] = {}
    tc_style = part.find("a:tcStyle", NS)
    if tc_style is not None:
        fill_wrapper = tc_style.find("a:fill", NS)
        fill_node = fill_wrapper if fill_wrapper is not None else tc_style
        fill = _parse_properties_fill(fill_node, theme_map)
        if fill:
            style["fill"] = fill
        borders = _parse_table_tc_borders(tc_style, theme_map)
        if borders:
            style["borders"] = borders
    tc_tx = part.find("a:tcTxStyle", NS)
    typography = _parse_tc_tx_style(tc_tx, theme_map, theme_fonts)
    if typography:
        style["typography"] = typography
    return style


def load_table_style_registry(package, theme_map: dict, theme_fonts: dict[str, str | None]) -> dict[str, dict[str, dict]]:
    if package is None or not package.exists(TABLE_STYLES_PART):
        return {}
    root = package.xml(TABLE_STYLES_PART)
    registry: dict[str, dict[str, dict]] = {}
    for tbl_style in root.findall("a:tblStyle", NS):
        style_id = tbl_style.get("styleId")
        if not style_id:
            continue
        parts: dict[str, dict] = {}
        for tag in STYLE_PART_TAGS:
            part = tbl_style.find(f"a:{tag}", NS)
            if part is None:
                continue
            parsed = _parse_table_part_style(part, theme_map, theme_fonts)
            if parsed:
                parts[tag] = parsed
        registry[style_id] = parts
    return registry


def resolve_cell_style_from_table_style(
    registry: dict[str, dict[str, dict]],
    style_id: str | None,
    flags: dict[str, bool],
    row: int,
    col: int,
    row_count: int,
    col_count: int,
) -> dict[str, Any]:
    if not style_id or style_id not in registry:
        return {}
    parts = registry[style_id]
    applicable = set(cell_style_part_names(flags, row, col, row_count, col_count))
    merged: dict[str, Any] = {}
    for part_name in STYLE_PART_MERGE_ORDER:
        if part_name not in applicable:
            continue
        part_style = parts.get(part_name)
        if part_style:
            merged = merge_cell_styles(merged, part_style)
    return merged


def style_rules_for_table(registry: dict[str, dict[str, dict]], style_id: str | None) -> dict[str, dict[str, Any]]:
    if not style_id:
        return {}
    return dict(registry.get(style_id) or {})


def style_tokens_from_rules(
    rules: dict[str, dict[str, Any]],
    *,
    header_cell: dict[str, Any] | None = None,
    body_cell: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tokens: dict[str, Any] = {}
    for rule_key, token_key in STYLE_RULE_TOKEN_ALIASES.items():
        if rules.get(rule_key):
            tokens[token_key] = rules[rule_key]
    if header_cell:
        tokens.setdefault("header_cell", header_cell)
    elif rules.get("firstRow"):
        tokens["header_cell"] = rules["firstRow"]
    if body_cell:
        tokens.setdefault("body_cell", body_cell)
    elif rules.get("band1H"):
        tokens["body_cell"] = rules["band1H"]
    elif rules.get("wholeTbl"):
        tokens["body_cell"] = rules["wholeTbl"]
    return tokens


def _merge_anchor_col(
    merged_cells: list[dict[str, int]] | None,
    row: int,
    col: int,
) -> int | None:
    for merge in merged_cells or []:
        anchor_row = merge.get("row", 0)
        anchor_col = merge.get("col", 0)
        row_span = merge.get("row_span", 1)
        col_span = merge.get("col_span", 1)
        if row < anchor_row or row >= anchor_row + row_span:
            continue
        if col < anchor_col or col >= anchor_col + col_span:
            continue
        if row == anchor_row and col == anchor_col:
            return None
        return anchor_col
    return None


def _previous_filled_col(preview_row: list[str] | None, col: int) -> int | None:
    if col <= 0 or not preview_row:
        return None
    for prev_col in range(col - 1, -1, -1):
        if prev_col < len(preview_row) and str(preview_row[prev_col] or "").strip():
            return prev_col
    return None


def _style_anchor_col(
    *,
    merged_cells: list[dict[str, int]] | None,
    preview: list[list[str]],
    row: int,
    col: int,
    has_direct_style: bool,
) -> int | None:
    anchor_col = _merge_anchor_col(merged_cells, row, col)
    if anchor_col is not None:
        return anchor_col
    if has_direct_style or col <= 0:
        return None
    preview_row = preview[row] if row < len(preview) else []
    if col >= len(preview_row) or str(preview_row[col] or "").strip():
        return None
    return _previous_filled_col(preview_row, col)


def _typography_color(style: dict[str, Any] | None) -> str | None:
    if not style:
        return None
    typography = style.get("typography") or {}
    color = typography.get("color")
    return str(color) if color else None


def _typography_from_cell_text_entry(entry: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(entry, dict):
        return {}
    text = str(entry.get("text") or "").strip()
    if not text:
        return {}
    typography = dict(entry.get("typography") or {})
    if _is_transparent_typography(typography):
        return {}
    return typography


def row_typography_from_cell_text(
    cell_text_grid: list[list[dict[str, Any] | None]] | None,
    row_index: int,
) -> dict[str, Any]:
    if not cell_text_grid or row_index < 0 or row_index >= len(cell_text_grid):
        return {}
    typography: dict[str, Any] = {}
    for entry in cell_text_grid[row_index] or []:
        cell_typography = _typography_from_cell_text_entry(entry)
        for field in TYPOGRAPHY_FIELDS:
            if field not in typography and cell_typography.get(field) is not None:
                typography[field] = cell_typography[field]
    return typography


def _is_transparent_typography(typography: dict[str, Any] | None) -> bool:
    if not typography:
        return False
    if typography.get("alpha") == 0 or typography.get("opacity") == 0:
        return True
    color = typography.get("color")
    if isinstance(color, dict) and color.get("alpha") == 0:
        return True
    if isinstance(color, str) and color.lower() == "transparent":
        return True
    return False


def _cell_has_visible_text(
    preview: list[list[str]] | None,
    row_index: int,
    col_index: int,
    *,
    cell_text_grid: list[list[dict[str, Any] | None]] | None = None,
) -> bool:
    if cell_text_grid and row_index < len(cell_text_grid):
        row = cell_text_grid[row_index] or []
        if col_index < len(row) and row[col_index] is not None:
            entry = row[col_index]
            if isinstance(entry, dict):
                text = str(entry.get("text") or "").strip()
                if not text:
                    return False
                return not _is_transparent_typography(entry.get("typography"))
            return bool(str(entry).strip())
    if preview and row_index < len(preview):
        row = preview[row_index] or []
        if col_index < len(row):
            return bool(str(row[col_index] or "").strip())
    return False


TYPOGRAPHY_FIELDS = ("color", "size_pt", "family", "bold", "alignment")


def _row_typography_from_text_cells(
    style_grid: list[list[dict[str, Any] | None]],
    row_index: int,
    *,
    flags: dict[str, bool],
    col_count: int,
    preview: list[list[str]] | None,
    cell_text_grid: list[list[dict[str, Any] | None]] | None,
    skip_first_col: bool = False,
    skip_last_col: bool = False,
) -> dict[str, Any]:
    if row_index < 0 or row_index >= len(style_grid):
        return {}
    body_col = 1 if col_count > 2 else 0
    accent_col = col_count - 1
    skip_last_col = skip_last_col or bool(flags.get("last_col"))
    if not skip_last_col and col_count > 1:
        body_sample = style_grid[0][body_col] if style_grid[0] and len(style_grid[0]) > body_col else None
        accent_sample = style_grid[0][accent_col] if style_grid[0] and len(style_grid[0]) > accent_col else None
        skip_last_col = bool(
            body_sample
            and accent_sample
            and json.dumps(body_sample.get("fill"), sort_keys=True)
            != json.dumps(accent_sample.get("fill"), sort_keys=True)
        )

    typography: dict[str, Any] = {}
    for col_index, cell in enumerate(style_grid[row_index] or []):
        if skip_first_col and col_index == 0:
            continue
        if skip_last_col and col_index == accent_col:
            continue
        if not _cell_has_visible_text(preview, row_index, col_index, cell_text_grid=cell_text_grid):
            continue
        cell_typography = (cell or {}).get("typography") or {}
        if not cell_typography and cell_text_grid and row_index < len(cell_text_grid):
            row_entries = cell_text_grid[row_index] or []
            if col_index < len(row_entries):
                entry = row_entries[col_index]
                if isinstance(entry, dict):
                    cell_typography = dict(entry.get("typography") or {})
        for field in TYPOGRAPHY_FIELDS:
            if field not in typography and cell_typography.get(field) is not None:
                typography[field] = cell_typography[field]
    return typography


def _is_accent_prefix_row(
    header_sample: dict[str, Any] | None,
    row_sample: dict[str, Any] | None,
    style_grid: list[list[dict[str, Any] | None]],
    *,
    flags: dict[str, bool],
) -> bool:
    if not flags.get("first_row") or not header_sample or not row_sample:
        return False
    if header_sample.get("fill") != row_sample.get("fill"):
        return False
    accent_color = _typography_color(row_sample)
    if not accent_color:
        return False
    body_colors = {
        color
        for row in style_grid[2:]
        for cell in row
        for color in [_typography_color(cell)]
        if color
    }
    return bool(body_colors) and accent_color not in body_colors


def _row_text_color(
    style_grid: list[list[dict[str, Any] | None]],
    row_index: int,
    *,
    flags: dict[str, bool],
    col_count: int,
    preview: list[list[str]] | None = None,
    cell_text_grid: list[list[dict[str, Any] | None]] | None = None,
    skip_first_col: bool = False,
    skip_last_col: bool = False,
) -> str | None:
    if row_index < 0 or row_index >= len(style_grid):
        return None
    body_col = 1 if col_count > 2 else 0
    accent_col = col_count - 1
    skip_last_col = skip_last_col or bool(flags.get("last_col"))
    if not skip_last_col and col_count > 1:
        body_sample = style_grid[0][body_col] if style_grid[0] and len(style_grid[0]) > body_col else None
        accent_sample = style_grid[0][accent_col] if style_grid[0] and len(style_grid[0]) > accent_col else None
        skip_last_col = bool(
            body_sample
            and accent_sample
            and json.dumps(body_sample.get("fill"), sort_keys=True)
            != json.dumps(accent_sample.get("fill"), sort_keys=True)
        )
    for col_index, cell in enumerate(style_grid[row_index] or []):
        if skip_first_col and col_index == 0:
            continue
        if skip_last_col and col_index == accent_col:
            continue
        if not _cell_has_visible_text(preview, row_index, col_index, cell_text_grid=cell_text_grid):
            continue
        if cell_text_grid and row_index < len(cell_text_grid):
            row_entries = cell_text_grid[row_index] or []
            if col_index < len(row_entries):
                entry = row_entries[col_index]
                if isinstance(entry, dict):
                    color = _typography_color(entry)
                    if color:
                        return color
        color = _typography_color(cell)
        if color:
            return color
    return None


def _infer_default_body_text_color(
    style_grid: list[list[dict[str, Any] | None]],
    *,
    style_rules: dict[str, dict[str, Any]],
    style_tokens: dict[str, Any],
    flags: dict[str, bool],
    row_count: int,
    col_count: int,
    theme_map: dict,
    prefix_len: int = 0,
    preview: list[list[str]] | None = None,
    cell_text_grid: list[list[dict[str, Any] | None]] | None = None,
) -> str:
    body_col = 1 if col_count > 2 else 0
    accent_col = col_count - 1
    body_sample = style_grid[0][body_col] if row_count and col_count > body_col else None
    accent_sample = style_grid[0][accent_col] if row_count and col_count else None
    skip_last_col = bool(
        flags.get("last_col")
        or (
            body_sample
            and accent_sample
            and json.dumps(body_sample.get("fill"), sort_keys=True)
            != json.dumps(accent_sample.get("fill"), sort_keys=True)
        )
    )

    counts: dict[str, int] = {}
    for row_index, row in enumerate(style_grid):
        if prefix_len > 0 and row_index < prefix_len:
            continue
        for col_index, cell in enumerate(row):
            if skip_last_col and col_index == accent_col:
                continue
            if not _cell_has_visible_text(preview, row_index, col_index, cell_text_grid=cell_text_grid):
                continue
            color = _typography_color(cell)
            if color:
                counts[color] = counts.get(color, 0) + 1
    if counts:
        return max(counts, key=counts.get)

    for token_key in ("band2_row_cell", "whole_cell", "header_cell", "first_row_cell", "body_cell"):
        color = _typography_color(style_tokens.get(token_key))
        if color:
            return color

    for rule_key in ("wholeTbl", "band1H", "band2H", "firstRow"):
        color = _typography_color(style_rules.get(rule_key))
        if color:
            return color

    return str(theme_map.get("tx1") or theme_map.get("dk1") or "#000000")


def list_blank_stub_cells(
    preview: list[list[str]] | None,
    cell_text_grid: list[list[dict[str, Any] | None]] | None,
    *,
    header_row: int | None = 0,
) -> list[list[int]]:
    """Header cells with no source text while the rest of the header has labels.

    Typical NW corner: ``['', 'Q1', 'Q2']``. Such cells are design stubs and must
    stay empty when playground/LLM data tries to fill them.
    """
    if header_row is None or header_row < 0:
        return []
    row_count = max(len(preview or []), len(cell_text_grid or []), header_row + 1)
    col_count = 0
    if preview and preview[0]:
        col_count = max(col_count, len(preview[0]))
    if cell_text_grid and header_row < len(cell_text_grid) and cell_text_grid[header_row]:
        col_count = max(col_count, len(cell_text_grid[header_row]))
    if col_count <= 1:
        return []

    def has_text(col_index: int) -> bool:
        if cell_text_grid and header_row < len(cell_text_grid):
            entry = (cell_text_grid[header_row] or [None] * col_count)[col_index] if col_index < col_count else None
            if isinstance(entry, dict):
                text = str(entry.get("text") or "").strip()
                if text and not _is_transparent_typography(entry.get("typography")):
                    return True
                if entry.get("text") is not None:
                    return False
        if preview and header_row < len(preview):
            return bool(str((preview[header_row] or [""])[col_index] if col_index < len(preview[header_row] or []) else "").strip())
        return False

    if not any(has_text(col) for col in range(col_count)):
        return []
    return [[header_row, col] for col in range(col_count) if not has_text(col)]


def complete_style_grid_typography(
    style_grid: list[list[dict[str, Any] | None]],
    *,
    style_rules: dict[str, dict[str, Any]],
    style_tokens: dict[str, Any],
    flags: dict[str, bool],
    row_count: int,
    col_count: int,
    theme_map: dict,
    preview: list[list[str]] | None = None,
    cell_text_grid: list[list[dict[str, Any] | None]] | None = None,
) -> list[list[dict[str, Any] | None]]:
    if not style_grid:
        return style_grid

    prefix_len = 1 if flags.get("first_row") else 0
    if prefix_len and row_count > 1:
        header_fill = (style_grid[0][0] or {}).get("fill")
        accent_fill = (style_grid[1][0] or {}).get("fill")
        if header_fill and accent_fill and header_fill == accent_fill:
            prefix_len = 2

    default_body_color = _infer_default_body_text_color(
        style_grid,
        style_rules=style_rules,
        style_tokens=style_tokens,
        flags=flags,
        row_count=row_count,
        col_count=col_count,
        theme_map=theme_map,
        prefix_len=prefix_len,
        preview=preview,
        cell_text_grid=cell_text_grid,
    )

    completed: list[list[dict[str, Any] | None]] = []
    for row_index, row in enumerate(style_grid):
        next_row: list[dict[str, Any] | None] = []
        for col_index, cell in enumerate(row):
            if cell is None:
                next_row.append(cell)
                continue

            if not _cell_has_visible_text(preview, row_index, col_index, cell_text_grid=cell_text_grid):
                next_cell = dict(cell)
                next_cell.pop("typography", None)
                next_row.append(next_cell)
                continue

            typography: dict[str, Any] = {}
            if cell_text_grid and row_index < len(cell_text_grid):
                row_entries = cell_text_grid[row_index] or []
                if col_index < len(row_entries) and isinstance(row_entries[col_index], dict):
                    text_typography = row_entries[col_index].get("typography") or {}
                    for field in TYPOGRAPHY_FIELDS:
                        if text_typography.get(field) is not None:
                            typography[field] = text_typography[field]

            skip_first_col = bool(flags.get("first_col") and col_index > 0)
            skip_last_col = bool(flags.get("last_col") and col_index < col_count - 1)
            row_typography = _row_typography_from_text_cells(
                style_grid,
                row_index,
                flags=flags,
                col_count=col_count,
                preview=preview,
                cell_text_grid=cell_text_grid,
                skip_first_col=skip_first_col,
                skip_last_col=skip_last_col,
            )
            cell_typography = dict(cell.get("typography") or {})
            for field in TYPOGRAPHY_FIELDS:
                if field not in typography and row_typography.get(field) is not None:
                    typography[field] = row_typography[field]
                if field not in typography and cell_typography.get(field) is not None:
                    typography[field] = cell_typography[field]

            if not typography.get("color"):
                color = _row_text_color(
                    style_grid,
                    row_index,
                    flags=flags,
                    col_count=col_count,
                    preview=preview,
                    cell_text_grid=cell_text_grid,
                    skip_first_col=skip_first_col,
                    skip_last_col=skip_last_col,
                )
                if not color:
                    part_names = set(cell_style_part_names(flags, row_index, col_index, row_count, col_count))
                    for part_name in reversed(STYLE_PART_MERGE_ORDER):
                        if part_name not in part_names:
                            continue
                        color = _typography_color(style_rules.get(part_name))
                        if color:
                            break

                if not color and flags.get("last_col") and col_index == col_count - 1:
                    color = (
                        _typography_color(style_rules.get("lastCol"))
                        or _typography_color(style_tokens.get("last_col_cell"))
                    )

                typography["color"] = color or default_body_color

            next_cell = dict(cell)
            next_cell["typography"] = typography
            next_row.append(next_cell)
        completed.append(next_row)

    return completed


def enrich_table_styles(
    *,
    package,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
    table_style_id: str | None,
    tbl_pr,
    row_count: int,
    col_count: int,
    cell_styles: list[dict[str, Any]],
    preview: list[list[str]],
    merged_cells: list[dict[str, int]] | None = None,
) -> tuple[dict[str, bool], list[list[dict[str, Any] | None]], dict[str, Any], dict[str, dict[str, Any]]]:
    flags = parse_table_condition_flags(tbl_pr)
    registry = load_table_style_registry(package, theme_map, theme_fonts)
    style_rules = style_rules_for_table(registry, table_style_id)

    style_grid: list[list[dict[str, Any] | None]] = []
    token_map: dict[str, dict[str, Any]] = {}

    for row_index in range(row_count):
        row_styles: list[dict[str, Any] | None] = []
        for col_index in range(col_count):
            direct = next(
                (item["style"] for item in cell_styles if item.get("row") == row_index and item.get("col") == col_index),
                None,
            )
            resolved = resolve_cell_style_from_table_style(
                registry,
                table_style_id,
                flags,
                row_index,
                col_index,
                row_count,
                col_count,
            )
            merged = merge_cell_styles(resolved, direct)
            anchor_col = _style_anchor_col(
                merged_cells=merged_cells,
                preview=preview,
                row=row_index,
                col=col_index,
                has_direct_style=direct is not None,
            )
            if anchor_col is not None and anchor_col < len(row_styles):
                anchor_style = row_styles[anchor_col]
                if anchor_style:
                    merged = copy.deepcopy(anchor_style)
            row_styles.append(merged or None)

            if row_index == 0 and flags.get("first_row"):
                token_map.setdefault("header_cell", merged)
            elif row_index == 1:
                header_sample = style_grid[0][0] if style_grid else None
                if not _is_accent_prefix_row(header_sample, merged, style_grid, flags=flags):
                    token_map.setdefault("body_cell", merged)
            elif row_index >= 2:
                token_map.setdefault("body_cell", merged)

            for part_name in cell_style_part_names(flags, row_index, col_index, row_count, col_count):
                token_key = STYLE_RULE_TOKEN_ALIASES.get(part_name)
                if token_key and merged:
                    token_map.setdefault(token_key, merged)

        style_grid.append(row_styles)

    return flags, style_grid, token_map, style_rules
