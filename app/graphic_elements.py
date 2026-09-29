"""Parse table/chart/diagram graphic frames into DS-ready element payloads."""

from __future__ import annotations

import posixpath
from typing import Any

from .fill_styles import parse_gradient_fill, parse_solid_fill, primary_fill_color, resolve_color_node
from .table_styles import (
    STYLE_RULE_TOKEN_ALIASES,
    complete_style_grid_typography,
    enrich_table_styles,
    list_blank_stub_cells,
    row_typography_from_cell_text,
    style_tokens_from_rules,
)

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "dgm": "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CHART_REL = f"{DOC_REL_NS}/chart"
DIAGRAM_DATA_REL = f"{DOC_REL_NS}/diagramData"
EMU_PER_PT = 12700

CHART_TYPE_TAGS = {
    "areaChart": "area",
    "area3DChart": "area",
    "barChart": "bar",
    "bar3DChart": "bar",
    "lineChart": "line",
    "line3DChart": "line",
    "pieChart": "pie",
    "pie3DChart": "pie",
    "doughnutChart": "doughnut",
    "scatterChart": "scatter",
    "bubbleChart": "bubble",
    "radarChart": "radar",
    "stockChart": "stock",
    "surfaceChart": "surface",
    "ofPieChart": "pie",
}


def _extend_horizontal_merge(
    merged_cells: list[dict[str, int]],
    row_index: int,
    col_index: int,
    grid_span: int,
) -> None:
    left_merge = next(
        (
            item
            for item in reversed(merged_cells)
            if item.get("row") == row_index and item.get("col", 0) + item.get("col_span", 1) == col_index
        ),
        None,
    )
    if left_merge is not None:
        left_merge["col_span"] = left_merge.get("col_span", 1) + grid_span
        return
    if col_index > 0:
        merged_cells.append({
            "row": row_index,
            "col": col_index - grid_span,
            "row_span": 1,
            "col_span": grid_span + 1,
        })


def _infer_horizontal_merges(
    preview: list[list[str]],
    merged_cells: list[dict[str, int]],
) -> list[dict[str, int]]:
    """Infer hMerge when trailing cells are empty but PPTX lacks hMerge markers."""
    covered: set[tuple[int, int]] = set()
    result = list(merged_cells)
    for merge in merged_cells:
        row = merge.get("row", 0)
        col = merge.get("col", 0)
        span = merge.get("col_span", 1)
        for offset in range(span):
            covered.add((row, col + offset))

    for row_index, row in enumerate(preview):
        col_index = 0
        while col_index < len(row):
            if (row_index, col_index) in covered:
                col_index += 1
                continue
            if not str(row[col_index] or "").strip():
                col_index += 1
                continue
            end = col_index + 1
            while end < len(row) and not str(row[end] or "").strip() and (row_index, end) not in covered:
                end += 1
            span = end - col_index
            if span > 1:
                result.append({
                    "row": row_index,
                    "col": col_index,
                    "row_span": 1,
                    "col_span": span,
                    "inferred": True,
                })
                for offset in range(span):
                    covered.add((row_index, col_index + offset))
            col_index = end if span > 1 else col_index + 1
    return result


def parse_table_element(
    table,
    theme_map: dict,
    theme_fonts: dict[str, str | None] | None = None,
    *,
    package=None,
    preview_text_limit: int = 120,
) -> dict[str, Any]:
    row_nodes = table.findall("a:tr", NS) if table is not None else []
    tbl_pr = table.find("a:tblPr", NS) if table is not None else None
    style_id_node = tbl_pr.find("a:tableStyleId", NS) if tbl_pr is not None else None

    column_widths_pt = [
        round(int(col.get("w", 0)) / EMU_PER_PT, 2)
        for col in table.findall("a:tblGrid/a:gridCol", NS)
    ] if table is not None else []

    col_count = len(column_widths_pt)
    preview: list[list[str]] = []
    row_heights_pt: list[float] = []
    merged_cells: list[dict[str, int]] = []
    cell_styles: list[dict[str, Any]] = []
    cell_text_entries: list[dict[str, Any]] = []

    for row_index, row in enumerate(row_nodes):
        row_height = row.get("h")
        if row_height is not None:
            try:
                row_heights_pt.append(round(int(row_height) / EMU_PER_PT, 2))
            except ValueError:
                pass

        cells: list[str] = []
        row_text: dict[int, str] = {}
        col_index = 0
        for cell in row.findall("a:tc", NS):
            tc_pr = cell.find("a:tcPr", NS)
            grid_span = 1
            row_span = 1
            if tc_pr is not None:
                try:
                    grid_span = max(int(tc_pr.get("gridSpan", 1) or 1), 1)
                except ValueError:
                    grid_span = 1
                if tc_pr.get("rowSpan") is not None:
                    try:
                        row_span = max(int(tc_pr.get("rowSpan", 1) or 1), 1)
                    except ValueError:
                        row_span = 1
                elif tc_pr.get("vMerge") is not None:
                    col_index += grid_span
                    continue
                elif tc_pr.get("hMerge") is not None:
                    _extend_horizontal_merge(merged_cells, row_index, col_index, grid_span)
                    col_index += grid_span
                    continue

            body = cell.find("a:txBody", NS)
            text = _extract_text_content(body) if body is not None else ""
            row_text[col_index] = text[:preview_text_limit]
            cell_content = _parse_table_cell_text(body, theme_map, theme_fonts or {})
            if cell_content:
                cell_text_entries.append({
                    "row": row_index,
                    "col": col_index,
                    "content": cell_content,
                })
            cell_styles.append({
                "row": row_index,
                "col": col_index,
                "style": _parse_table_cell_style(cell, theme_map, theme_fonts or {}),
            })
            if grid_span > 1 or row_span > 1:
                merged_cells.append({
                    "row": row_index,
                    "col": col_index,
                    "row_span": row_span,
                    "col_span": grid_span,
                })
            col_index += grid_span

        col_count = max(col_count, col_index)
        preview.append([row_text.get(col, "") for col in range(col_index)])

    merged_cells = _infer_horizontal_merges(preview, merged_cells)

    row_count = len(row_nodes)
    if row_heights_pt and len(row_heights_pt) < row_count:
        fallback = row_heights_pt[-1]
        while len(row_heights_pt) < row_count:
            row_heights_pt.append(fallback)

    cell_text_grid: list[list[dict[str, Any] | None]] = [
        [None for _ in range(col_count)]
        for _ in range(row_count)
    ]
    for item in cell_text_entries:
        row_index = item.get("row", 0)
        col_index = item.get("col", 0)
        if 0 <= row_index < row_count and 0 <= col_index < col_count:
            cell_text_grid[row_index][col_index] = item.get("content")

    style_id = style_id_node.text if style_id_node is not None and style_id_node.text else None
    flags, style_grid, token_map, style_rules = enrich_table_styles(
        package=package,
        theme_map=theme_map,
        theme_fonts=theme_fonts or {},
        table_style_id=style_id,
        tbl_pr=tbl_pr,
        row_count=row_count,
        col_count=col_count,
        cell_styles=cell_styles,
        preview=preview,
        merged_cells=merged_cells,
    )

    header_row = 0 if flags.get("first_row") and row_count else None
    header_cell = token_map.get("header_cell") or token_map.get("first_row_cell") or _pick_cell_style(cell_styles, row=0)
    body_cell = (
        token_map.get("body_cell")
        or token_map.get("band1_row_cell")
        or token_map.get("whole_cell")
        or _pick_cell_style(cell_styles, row=1)
        or _pick_cell_style(cell_styles, row=0)
    )

    style_tokens = style_tokens_from_rules(
        style_rules,
        header_cell=header_cell,
        body_cell=body_cell,
    )
    for key in STYLE_RULE_TOKEN_ALIASES.values():
        if token_map.get(key) and key not in style_tokens:
            style_tokens[key] = token_map[key]
    if header_cell and body_cell:
        style_tokens["border"] = _shared_border_tokens(header_cell, body_cell)

    style_grid = complete_style_grid_typography(
        style_grid,
        style_rules=style_rules,
        style_tokens=style_tokens,
        flags=flags,
        row_count=row_count,
        col_count=col_count,
        theme_map=theme_map,
        preview=preview,
        cell_text_grid=cell_text_grid,
    )

    row_sizing = detect_table_row_sizing_mode(
        row_heights_pt,
        cell_text_grid,
        style_grid,
        row_count,
    )

    layout_width_pt = round(sum(column_widths_pt), 2) if column_widths_pt else None
    table_payload = {
        "table_style_id": style_id,
        "column_widths_pt": column_widths_pt,
        "layout_width_pt": layout_width_pt,
        "row_heights_pt": row_heights_pt,
        "structure": {
            "header_row": header_row,
            "merged_cells": merged_cells,
            "flags": flags,
            "row_sizing": row_sizing,
            "blank_stub_cells": list_blank_stub_cells(
                preview,
                cell_text_grid,
                header_row=header_row if header_row is not None else 0,
            ),
        },
        "style_tokens": style_tokens,
        "style_rules": style_rules,
        "cell_styles": style_grid,
        "cell_text": cell_text_grid,
        "content_model": {
            "kind": "grid",
            "columns": col_count,
            "rows": row_count,
            "cell_fields": ["value"],
            "layout_width_pt": layout_width_pt,
            "column_weights_from": "column_widths_pt",
        },
        "data_preview": {
            "rows": preview,
        },
    }

    component = build_graphic_component_meta(
        kind="table",
        slot_role="table",
        variant_signature=_table_variant_signature(table_payload),
    )

    return {
        "rows": len(row_nodes),
        "cols": col_count,
        "preview": preview,
        "table": table_payload,
        "component": component,
    }


TABLE_DIM_ABS_TOLERANCE_PT = 1.0
TABLE_DIM_REL_TOLERANCE = 0.015
ROW_SIZING_FIXED = "fixed"
ROW_SIZING_FIT_CONTENT = "fit_content"


def dimensions_close(
    left: float | None,
    right: float | None,
    *,
    abs_pt: float = TABLE_DIM_ABS_TOLERANCE_PT,
    rel: float = TABLE_DIM_REL_TOLERANCE,
) -> bool:
    if left is None or right is None:
        return False
    diff = abs(float(left) - float(right))
    scale = max(abs(float(left)), abs(float(right)), 1.0)
    return diff <= abs_pt or diff / scale <= rel


def table_intrinsic_width_pt(column_widths_pt: list[float] | None) -> float | None:
    width_pt = round(sum(column_widths_pt or []), 2)
    if width_pt <= 0:
        return None
    return width_pt


def table_intrinsic_height_pt(
    row_heights_pt: list[float] | None,
    row_count: int | None = None,
) -> float | None:
    heights = list(row_heights_pt or [])
    if not heights:
        return None
    target_rows = row_count or len(heights)
    if target_rows <= 0:
        return None
    if len(heights) < target_rows:
        heights.extend([heights[-1]] * (target_rows - len(heights)))
    heights = heights[:target_rows]
    total = round(sum(heights), 2)
    return total if total > 0 else None


def _spacing_before_after_pt(spacing: dict[str, Any] | None) -> tuple[float, float]:
    if not spacing:
        return 0.0, 0.0
    before = spacing.get("space_before")
    if before is None:
        before = spacing.get("space_before_pt")
    after = spacing.get("space_after")
    if after is None:
        after = spacing.get("space_after_pt")
    return float(before or 0.0), float(after or 0.0)


def _segment_block_height_pt(segment: dict[str, Any]) -> float:
    text = segment.get("text") or ""
    lines = max(1, len(text.split("\n"))) if str(text).strip() else 1
    typography = segment.get("typography") or {}
    spacing = segment.get("paragraph_spacing_pt") or {}
    size_pt = float(typography.get("size_pt") or 12.0)
    ratio = float(
        spacing.get("line_spacing_ratio")
        or typography.get("line_height_ratio")
        or typography.get("pptx_line_spacing_ratio")
        or 1.0
    )
    line_height_pt = spacing.get("line_height_pt")
    if line_height_pt is None:
        line_height_pt = round(size_pt * ratio, 2)
    before, after = _spacing_before_after_pt(spacing)
    return round(float(before) + float(line_height_pt) * lines + float(after), 2)


def estimate_cell_content_height_pt(
    cell_content: dict[str, Any] | None,
    cell_style: dict[str, Any] | None,
) -> float:
    if not cell_content:
        return 0.0

    padding = (cell_style or {}).get("padding_pt") or {}
    vertical_padding = float(padding.get("top") or 0.0) + float(padding.get("bottom") or 0.0)
    total = vertical_padding

    segments = cell_content.get("text_segments")
    if segments:
        for segment in segments:
            total += _segment_block_height_pt(segment)
        return round(total, 2)

    text = cell_content.get("text") or ""
    lines = max(1, len(text.split("\n"))) if str(text).strip() else 0
    if lines <= 0:
        return round(vertical_padding, 2)

    typography = cell_content.get("typography") or (cell_style or {}).get("typography") or {}
    spacing = cell_content.get("paragraph_spacing_pt") or {}
    total += _segment_block_height_pt({
        "text": text,
        "typography": typography,
        "paragraph_spacing_pt": spacing,
    })
    return round(total, 2)


def table_content_row_heights_pt(
    cell_text: list[list[dict[str, Any] | None]],
    cell_styles: list[list[dict[str, Any] | None]],
    row_count: int,
) -> list[float]:
    if row_count <= 0:
        return []
    row_totals: list[float] = []
    for row_index in range(row_count):
        row_cells = cell_text[row_index] if row_index < len(cell_text) else []
        style_row = cell_styles[row_index] if row_index < len(cell_styles) else []
        row_height = 0.0
        for col_index, cell_content in enumerate(row_cells):
            if not cell_content:
                continue
            style = style_row[col_index] if col_index < len(style_row) else None
            row_height = max(row_height, estimate_cell_content_height_pt(cell_content, style))
        row_totals.append(round(row_height, 2))
    return row_totals


def detect_table_row_sizing_mode(
    row_heights_pt: list[float] | None,
    cell_text: list[list[dict[str, Any] | None]],
    cell_styles: list[list[dict[str, Any] | None]],
    row_count: int,
) -> dict[str, Any]:
    """Detect fixed row heights (design) vs rows sized to fit cell contents."""
    normalized: list[float] = []
    if row_heights_pt:
        normalized = list(row_heights_pt[:row_count])
        if len(normalized) < row_count and normalized:
            normalized.extend([normalized[-1]] * (row_count - len(normalized)))

    if not normalized:
        return {"mode": ROW_SIZING_FIT_CONTENT, "reason": "missing_row_heights"}

    content_rows = table_content_row_heights_pt(cell_text, cell_styles, row_count)
    unique_heights = {round(value, 2) for value in normalized}
    if len(unique_heights) == 1 and len(normalized) >= 2:
        return {
            "mode": ROW_SIZING_FIXED,
            "reason": "uniform_row_heights",
            "uniform_row_height_pt": normalized[0],
        }

    if content_rows:
        matches = 0
        exceeds = 0
        compared = 0
        for row_height, content_height in zip(normalized, content_rows):
            if content_height <= 0:
                continue
            compared += 1
            if dimensions_close(row_height, content_height, abs_pt=2.5, rel=0.18):
                matches += 1
            elif row_height > content_height + 2.0:
                exceeds += 1

        if compared > 0:
            if matches >= max(exceeds, 1) and matches >= compared * 0.55:
                return {
                    "mode": ROW_SIZING_FIT_CONTENT,
                    "reason": "row_heights_track_content",
                    "matched_rows": matches,
                    "compared_rows": compared,
                }
            if exceeds > matches and exceeds >= compared * 0.5:
                return {
                    "mode": ROW_SIZING_FIXED,
                    "reason": "row_heights_exceed_content",
                    "fixed_rows": exceeds,
                    "compared_rows": compared,
                }

    grid_sum = round(sum(normalized), 2)
    content_sum = round(sum(content_rows), 2) if content_rows else 0.0
    if content_sum > 0 and dimensions_close(grid_sum, content_sum, abs_pt=4.0, rel=0.08):
        return {
            "mode": ROW_SIZING_FIT_CONTENT,
            "reason": "total_height_matches_content",
            "grid_sum_pt": grid_sum,
            "content_sum_pt": content_sum,
        }

    return {"mode": ROW_SIZING_FIXED, "reason": "default_fixed_grid", "grid_sum_pt": grid_sum}


def refine_table_row_sizing_with_frame(
    table_payload: dict[str, Any],
    frame_height_pt: float | None,
) -> dict[str, Any]:
    """Re-evaluate row sizing once the graphic frame height is known."""
    row_count = int((table_payload.get("content_model") or {}).get("rows") or 0)
    if row_count <= 0:
        row_count = len(table_payload.get("row_heights_pt") or [])

    row_heights = list(table_payload.get("row_heights_pt") or [])
    normalized = row_heights[:row_count]
    if len(normalized) < row_count and normalized:
        normalized.extend([normalized[-1]] * (row_count - len(normalized)))

    grid_sum = table_intrinsic_height_pt(row_heights, row_count)
    if not frame_height_pt or not grid_sum:
        return dict((table_payload.get("structure") or {}).get("row_sizing") or {})

    if dimensions_close(frame_height_pt, grid_sum):
        unique_heights = {round(value, 2) for value in normalized}
        if len(unique_heights) == 1 and len(normalized) >= 2:
            return {
                "mode": ROW_SIZING_FIXED,
                "reason": "frame_matches_uniform_row_grid",
                "uniform_row_height_pt": normalized[0],
                "frame_height_pt": frame_height_pt,
                "grid_sum_pt": grid_sum,
            }
        return {
            "mode": ROW_SIZING_FIXED,
            "reason": "frame_matches_row_grid",
            "frame_height_pt": frame_height_pt,
            "grid_sum_pt": grid_sum,
        }

    if frame_height_pt > grid_sum + TABLE_DIM_ABS_TOLERANCE_PT:
        return {
            "mode": ROW_SIZING_FIT_CONTENT,
            "reason": "frame_exceeds_row_grid",
            "frame_height_pt": frame_height_pt,
            "grid_sum_pt": grid_sum,
            "extra_height_pt": round(frame_height_pt - grid_sum, 2),
        }

    return dict((table_payload.get("structure") or {}).get("row_sizing") or {})


def table_content_height_pt(
    cell_text: list[list[dict[str, Any] | None]],
    cell_styles: list[list[dict[str, Any] | None]],
    row_count: int,
) -> float | None:
    row_totals = table_content_row_heights_pt(cell_text, cell_styles, row_count)
    total = round(sum(row_totals), 2)
    return total if total > 0 else None


def table_recalculated_height_pt(table_payload: dict[str, Any]) -> tuple[float | None, dict[str, Any]]:
    row_count = int((table_payload.get("content_model") or {}).get("rows") or 0)
    if row_count <= 0:
        row_count = len(table_payload.get("row_heights_pt") or [])

    sizing = (table_payload.get("structure") or {}).get("row_sizing") or {}
    mode = sizing.get("mode", ROW_SIZING_FIXED)

    grid_sum = table_intrinsic_height_pt(table_payload.get("row_heights_pt"), row_count)
    content_estimate = table_content_height_pt(
        table_payload.get("cell_text") or [],
        table_payload.get("cell_styles") or [],
        row_count,
    )
    meta: dict[str, Any] = {
        "grid_sum_pt": grid_sum,
        "content_estimate_pt": content_estimate,
        "row_sizing_mode": mode,
    }
    recalculated = grid_sum
    meta["recalculated_pt"] = recalculated
    return recalculated, meta


def _choose_reconciled_height_pt(
    frame_pt: float | None,
    recalculated_pt: float | None,
    *,
    row_sizing_mode: str,
    grid_sum_pt: float | None = None,
) -> tuple[float | None, bool]:
    if row_sizing_mode == ROW_SIZING_FIT_CONTENT:
        if frame_pt and frame_pt > 0:
            reconciled = bool(grid_sum_pt and not dimensions_close(frame_pt, grid_sum_pt))
            return frame_pt, reconciled
        return recalculated_pt, recalculated_pt is not None

    if frame_pt and frame_pt > 0:
        if grid_sum_pt and frame_pt >= grid_sum_pt - 0.5:
            reconciled = bool(grid_sum_pt and not dimensions_close(frame_pt, grid_sum_pt))
            return frame_pt, reconciled
        if recalculated_pt and recalculated_pt > 0:
            return recalculated_pt, bool(not dimensions_close(frame_pt, recalculated_pt))
        return frame_pt, False

    if recalculated_pt and recalculated_pt > 0:
        return recalculated_pt, True
    return grid_sum_pt, False


def _choose_reconciled_dimension(
    frame_pt: float | None,
    recalculated_pt: float | None,
) -> tuple[float | None, bool]:
    if recalculated_pt is None or recalculated_pt <= 0:
        return frame_pt, False
    if frame_pt is None or frame_pt <= 0:
        return recalculated_pt, True
    if dimensions_close(frame_pt, recalculated_pt):
        return frame_pt, False
    return recalculated_pt, True


def apply_table_intrinsic_geometry(
    geometry_pt: dict[str, float],
    geometry_norm: dict[str, float],
    table_payload: dict[str, Any] | None,
    *,
    slide_width_emu: float,
    slide_height_emu: float,
) -> tuple[dict[str, float], dict[str, float]]:
    if not table_payload:
        return geometry_pt, geometry_norm

    frame_width_pt = geometry_pt.get("width_pt")
    frame_height_pt = geometry_pt.get("height_pt")
    row_sizing = refine_table_row_sizing_with_frame(table_payload, frame_height_pt)
    if table_payload.get("structure") is not None:
        table_payload["structure"]["row_sizing"] = row_sizing
    row_sizing_mode = row_sizing.get("mode", ROW_SIZING_FIXED)
    recalculated_width_pt = table_intrinsic_width_pt(table_payload.get("column_widths_pt"))
    recalculated_height_pt, height_meta = table_recalculated_height_pt(table_payload)

    chosen_width_pt, width_reconciled = _choose_reconciled_dimension(
        frame_width_pt,
        recalculated_width_pt,
    )
    chosen_height_pt, height_reconciled = _choose_reconciled_height_pt(
        frame_height_pt,
        recalculated_height_pt,
        row_sizing_mode=row_sizing_mode,
        grid_sum_pt=height_meta.get("grid_sum_pt"),
    )

    slide_width_pt = slide_width_emu / EMU_PER_PT
    slide_height_pt = slide_height_emu / EMU_PER_PT
    updated_pt = dict(geometry_pt)
    updated_norm = dict(geometry_norm)

    if chosen_width_pt:
        updated_pt["width_pt"] = chosen_width_pt
        updated_norm["width"] = round(chosen_width_pt / slide_width_pt, 4) if slide_width_pt else geometry_norm.get("width", 0)
        table_payload["layout_width_pt"] = chosen_width_pt

    if chosen_height_pt:
        updated_pt["height_pt"] = chosen_height_pt
        updated_norm["height"] = round(chosen_height_pt / slide_height_pt, 4) if slide_height_pt else geometry_norm.get("height", 0)
        table_payload["layout_height_pt"] = chosen_height_pt
        table_payload["max_height_pt"] = chosen_height_pt

    table_payload["frame_width_pt"] = frame_width_pt
    table_payload["frame_height_pt"] = frame_height_pt
    table_payload["dimension_sources"] = {
        "width": {
            "frame_pt": frame_width_pt,
            "grid_sum_pt": recalculated_width_pt,
            "chosen_pt": chosen_width_pt,
            "reconciled": width_reconciled,
        },
        "height": {
            "frame_pt": frame_height_pt,
            **height_meta,
            "chosen_pt": chosen_height_pt,
            "reconciled": height_reconciled,
            "row_sizing": row_sizing,
        },
    }

    y_pt = geometry_pt.get("y_pt") or 0
    if slide_height_pt:
        table_payload["available_height_pt"] = round(max(slide_height_pt - y_pt, 0), 2)

    return updated_pt, updated_norm


def parse_chart_element(
    package,
    part: str,
    graphic_data,
    theme_map: dict,
) -> dict[str, Any]:
    chart_ref = graphic_data.find("c:chart", NS) if graphic_data is not None else None
    rel_id = chart_ref.get(f"{{{NS['r']}}}id") if chart_ref is not None else None
    chart_type = "chart"
    subtype: dict[str, Any] = {}
    series: list[dict[str, Any]] = []
    categories_preview: list[str] = []
    style_tokens: dict[str, Any] = {}

    if rel_id:
        chart_part = _related_part(package, part, rel_id, CHART_REL)
        if chart_part:
            chart_root = package.xml(chart_part)
            plot_area = chart_root.find("c:chart/c:plotArea", NS)
            if plot_area is not None:
                chart_type, chart_node = _chart_type_from_plot_area(plot_area)
                if chart_node is not None:
                    subtype = _chart_subtype(chart_node)
                    series = _chart_series(chart_node, theme_map)
                    categories_preview = _chart_categories_preview(chart_node)
                style_tokens = _chart_style_tokens(plot_area, chart_root, theme_map, series)

    chart_payload = {
        "type": chart_type,
        "subtype": subtype,
        "series": series,
        "categories_preview": categories_preview,
        "style_tokens": style_tokens,
    }
    component = build_graphic_component_meta(
        kind="chart",
        slot_role="chart",
        variant_signature=_chart_variant_signature(chart_payload),
    )

    return {
        "chart_type": chart_type,
        "chart": chart_payload,
        "component": component,
    }


def parse_diagram_element(
    package,
    part: str,
    graphic_data,
) -> dict[str, Any]:
    rel_ids = graphic_data.find("dgm:relIds", NS) if graphic_data is not None else None
    layout_id = rel_ids.get("dm") if rel_ids is not None else None
    diagram_part = None
    if rel_ids is not None:
        data_rel = rel_ids.get(f"{{{NS['r']}}}dm")
        if data_rel:
            diagram_part = _related_part(package, part, data_rel, DIAGRAM_DATA_REL)

    preview_texts: list[str] = []
    node_count = 0
    if diagram_part:
        diagram_root = package.xml(diagram_part)
        for text_node in diagram_root.findall(".//a:t", NS):
            text = (text_node.text or "").strip()
            if text:
                preview_texts.append(text[:48])
        node_count = len(diagram_root.findall(".//dgm:pt", NS)) or len(preview_texts)

    diagram_payload = {
        "diagram_type": "smartart",
        "layout_id": layout_id,
        "node_count": node_count,
        "preview_texts": preview_texts[:12],
    }
    component = build_graphic_component_meta(
        kind="diagram",
        slot_role="diagram",
        variant_signature=_diagram_variant_signature(diagram_payload),
    )

    return {
        "diagram_type": "smartart",
        "diagram": diagram_payload,
        "component": component,
    }


def build_graphic_component_meta(*, kind: str, slot_role: str, variant_signature: str) -> dict[str, Any]:
    ds_component = {
        "table": "DsTable",
        "chart": "DsChart",
        "diagram": "DsDiagram",
    }.get(kind, "DsGraphic")
    ds_binding: dict[str, Any] = {
        "component": ds_component,
        "props_from": ["style_tokens", "structure", "subtype"],
        "content_from": ["data_preview", "preview", "series", "categories_preview", "preview_texts"],
    }
    if kind == "table":
        ds_binding["props_from"] = [
            "style_tokens",
            "structure",
            "column_widths_pt",
            "row_heights_pt",
        ]
        ds_binding["content_model"] = {
            "fields": ["value"],
            "rows_from": "data_preview.rows",
        }
    return {
        "kind": kind,
        "slot_role": slot_role,
        "variant_signature": variant_signature,
        "ds_binding": ds_binding,
    }


def _parse_table_cell_text(
    body,
    theme_map: dict,
    theme_fonts: dict[str, str | None],
) -> dict[str, Any] | None:
    from .template_layers import (
        _bullet_payload,
        _extract_text_paragraphs,
        _flatten_text_runs,
        _paragraph_spacing_payload,
        _summarize_text_typography,
        _text_line_segments,
        _text_paragraphs_payload,
    )

    if body is None:
        return None

    paragraphs = _extract_text_paragraphs(
        body,
        theme_map,
        theme_fonts,
        None,
        list_bodies=[body],
    )
    segments = _text_line_segments(paragraphs, skip_metrics=True)
    if not segments:
        return None

    text = "\n".join(segment["text"] for segment in segments)
    first_segment = segments[0]
    text_paragraphs = _text_paragraphs_payload(paragraphs)
    typography = (
        first_segment["typography"]
        if len(segments) == 1
        else _summarize_text_typography(_flatten_text_runs(paragraphs), paragraphs)
    )

    payload: dict[str, Any] = {
        "text": text,
        "typography": typography,
    }
    if text_paragraphs:
        payload["text_paragraphs"] = text_paragraphs
    bullet = _bullet_payload(first_segment)
    if bullet:
        payload["bullet"] = bullet
    spacing = _paragraph_spacing_payload(
        first_segment,
        include_hanging_indent=not text_paragraphs,
    )
    if spacing:
        payload["paragraph_spacing_pt"] = spacing

    if len(segments) > 1:
        payload["text_segments"] = []
        for segment in segments:
            entry: dict[str, Any] = {
                "text": segment["text"],
                "typography": segment["typography"],
            }
            segment_bullet = _bullet_payload(segment)
            if segment_bullet:
                entry["bullet"] = segment_bullet
            segment_spacing = _paragraph_spacing_payload(segment)
            if segment_spacing:
                entry["paragraph_spacing_pt"] = segment_spacing
            payload["text_segments"].append(entry)

    return payload


def _parse_table_cell_style(cell, theme_map: dict, theme_fonts: dict[str, str | None]) -> dict[str, Any]:
    tc_pr = cell.find("a:tcPr", NS)
    body = cell.find("a:txBody", NS)
    style: dict[str, Any] = {}
    if tc_pr is not None:
        fill = _parse_properties_fill(tc_pr, theme_map)
        if fill:
            style["fill"] = fill
        padding = _cell_padding_pt(tc_pr)
        if padding:
            style["padding_pt"] = padding
        borders = _cell_borders(tc_pr, theme_map)
        if borders:
            style["borders"] = borders
        anchor = tc_pr.get("anchor")
        if anchor:
            style["vertical_anchor"] = anchor
    if body is not None:
        typography = _cell_typography(body, theme_map, theme_fonts)
        if typography:
            style["typography"] = typography
    return style


def _cell_typography(body, theme_map: dict, theme_fonts: dict[str, str | None]) -> dict[str, Any] | None:
    paragraph = body.find("a:p", NS)
    if paragraph is None:
        return None
    run = paragraph.find("a:r", NS)
    target = run if run is not None else paragraph.find("a:endParaRPr", NS)
    if target is None:
        return None
    r_pr = target.find("a:rPr", NS) if run is not None else target
    if r_pr is None and run is not None:
        r_pr = run
    if r_pr is None:
        return None

    typography: dict[str, Any] = {}
    latin = r_pr.find("a:latin", NS)
    if latin is not None and latin.get("typeface"):
        typography["family"] = latin.get("typeface")
    elif theme_fonts.get("+mn-lt"):
        typography["family"] = theme_fonts["+mn-lt"]
    else:
        typography["family"] = "Arial"

    size_raw = r_pr.get("sz")
    if size_raw is not None:
        try:
            typography["size_pt"] = round(int(size_raw) / 100, 2)
        except ValueError:
            pass
    typography["bold"] = r_pr.get("b") in {"1", "true", "True"}

    p_pr = paragraph.find("a:pPr", NS)
    if p_pr is not None and p_pr.get("algn"):
        typography["alignment"] = p_pr.get("algn")

    color_node = r_pr.find("a:solidFill", NS)
    if color_node is not None:
        for child in color_node:
            parsed = resolve_color_node(child, theme_map)
            if parsed:
                typography["color"] = parsed["color"]
                if parsed.get("alpha", 1.0) < 0.999:
                    typography["alpha"] = parsed["alpha"]
                break
    return typography or None


def _cell_padding_pt(tc_pr) -> dict[str, float] | None:
    padding: dict[str, float] = {}
    for key, attr in (("top", "marT"), ("bottom", "marB"), ("left", "marL"), ("right", "marR")):
        raw = tc_pr.get(attr)
        if raw is None:
            continue
        try:
            padding[key] = round(int(raw) / EMU_PER_PT, 2)
        except ValueError:
            continue
    return padding or None


def _line_is_explicitly_invisible(line, theme_map: dict) -> bool:
    if line.find("a:noFill", NS) is not None:
        return True
    solid = line.find("a:solidFill", NS)
    if solid is not None:
        color = parse_solid_fill(solid, theme_map)
        if color and color.get("alpha", 1.0) <= 0:
            return True
    return False


def _cell_borders(tc_pr, theme_map: dict) -> dict[str, Any] | None:
    from .table_styles import INVISIBLE_TABLE_BORDER

    borders: dict[str, Any] = {}
    for side, tag in (("left", "a:lnL"), ("right", "a:lnR"), ("top", "a:lnT"), ("bottom", "a:lnB")):
        line = tc_pr.find(tag, NS)
        if line is None:
            continue
        parsed = parse_shape_stroke_from_line(line, theme_map)
        if parsed:
            borders[side] = parsed
        elif _line_is_explicitly_invisible(line, theme_map):
            borders[side] = dict(INVISIBLE_TABLE_BORDER)
    return borders or None


def parse_shape_stroke_from_line(line, theme_map: dict) -> dict[str, Any] | None:
    if line.find("a:noFill", NS) is not None:
        return None
    color = None
    solid = line.find("a:solidFill", NS)
    if solid is not None:
        color = parse_solid_fill(solid, theme_map)
    if color and color.get("alpha", 1.0) <= 0:
        return None
    if color is None:
        return None
    width_raw = line.get("w")
    width_pt = 0.75
    if width_raw is not None:
        try:
            width_pt = round(int(width_raw) / EMU_PER_PT, 2)
        except ValueError:
            pass
    dash_node = line.find("a:prstDash", NS)
    return {
        "width_pt": width_pt,
        "color": color,
        "dash": dash_node.get("val") if dash_node is not None else "solid",
    }


def _parse_properties_fill(node, theme_map: dict) -> dict[str, Any] | None:
    for child in node:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "noFill":
            return {"kind": "none", "alpha": 0.0}
        if tag == "solidFill":
            return parse_solid_fill(child, theme_map)
        if tag == "gradFill":
            return parse_gradient_fill(child, theme_map)
    return None


def _pick_cell_style(cell_styles: list[dict[str, Any]], *, row: int) -> dict[str, Any] | None:
    for item in cell_styles:
        if item.get("row") == row and item.get("style"):
            return item["style"]
    return None


def _shared_border_tokens(*styles: dict[str, Any] | None) -> dict[str, Any] | None:
    for style in styles:
        if style and style.get("borders"):
            return style["borders"]
    return None


def _chart_type_from_plot_area(plot_area):
    for child in plot_area:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag in CHART_TYPE_TAGS:
            return CHART_TYPE_TAGS[tag], child
    return "chart", None


def _chart_subtype(chart_node) -> dict[str, Any]:
    subtype: dict[str, Any] = {}
    bar_dir = chart_node.find("c:barDir", NS)
    if bar_dir is not None and bar_dir.get("val"):
        subtype["direction"] = bar_dir.get("val")
    grouping = chart_node.find("c:grouping", NS)
    if grouping is not None and grouping.get("val"):
        subtype["grouping"] = grouping.get("val")
    return subtype


def _chart_series(chart_node, theme_map: dict) -> list[dict[str, Any]]:
    series_nodes = chart_node.findall("c:ser", NS)
    payload: list[dict[str, Any]] = []
    for index, ser in enumerate(series_nodes):
        name = _chart_series_name(ser)
        fill = None
        sp_pr = ser.find("c:spPr", NS)
        if sp_pr is not None:
            fill = _parse_properties_fill(sp_pr, theme_map)
        values_preview = _chart_values_preview(ser)
        item = {"index": index, "name": name}
        if fill:
            item["fill"] = fill
        if values_preview:
            item["values_preview"] = values_preview
        payload.append(item)
    return payload


def _chart_series_name(ser) -> str | None:
    tx = ser.find("c:tx", NS)
    if tx is None:
        return None
    value = tx.find(".//c:v", NS)
    if value is not None and value.text:
        return value.text.strip()
    return None


def _chart_values_preview(ser, limit: int = 6) -> list[float | str]:
    val = ser.find("c:val", NS)
    if val is None:
        return []
    values: list[float | str] = []
    for pt in val.findall(".//c:pt", NS):
        raw = pt.find("c:v", NS)
        if raw is None or raw.text is None:
            continue
        text = raw.text.strip()
        try:
            values.append(round(float(text), 4))
        except ValueError:
            values.append(text)
        if len(values) >= limit:
            break
    return values


def _chart_categories_preview(chart_node, limit: int = 6) -> list[str]:
    ser = chart_node.find("c:ser", NS)
    if ser is None:
        return []
    cat = ser.find("c:cat", NS)
    if cat is None:
        return []
    categories: list[str] = []
    for pt in cat.findall(".//c:pt", NS):
        raw = pt.find("c:v", NS)
        if raw is None or raw.text is None:
            continue
        categories.append(raw.text.strip()[:48])
        if len(categories) >= limit:
            break
    return categories


def _chart_style_tokens(plot_area, chart_root, theme_map: dict, series: list[dict[str, Any]]) -> dict[str, Any]:
    tokens: dict[str, Any] = {}
    palette = []
    for item in series:
        fill = item.get("fill") or {}
        color = primary_fill_color(fill) or fill.get("color")
        scheme = fill.get("scheme")
        if color or scheme:
            palette.append({"color": color, "scheme": scheme})
    if palette:
        tokens["series_palette"] = palette

    legend = chart_root.find("c:chart/c:legend", NS)
    if legend is not None:
        tokens["legend"] = {"visible": legend.find("c:delete", NS) is None or legend.find("c:delete", NS).get("val") not in {"1", "true", "True"}}

    plot_fill = _parse_properties_fill(plot_area, theme_map)
    if plot_fill:
        tokens["plot_area_fill"] = plot_fill
    return tokens


def _table_variant_signature(table_payload: dict[str, Any]) -> str:
    source = table_payload.get("source") or "native"
    style = table_payload.get("style_tokens") or {}
    structure = table_payload.get("structure") or {}
    header_row = structure.get("header_row")
    cell_text = table_payload.get("cell_text") or []

    header = style.get("header_cell") or {}
    body = style.get("body_cell") or {}
    header_fill = primary_fill_color(header.get("fill")) or "none"
    body_fill = primary_fill_color(body.get("fill")) or "none"

    header_row_index = header_row if isinstance(header_row, int) else 0
    body_row_index = header_row_index + 1 if isinstance(header_row, int) else 1
    header_typography = row_typography_from_cell_text(cell_text, header_row_index)
    body_typography = row_typography_from_cell_text(cell_text, body_row_index)
    if not header_typography:
        header_typography = (header.get("typography") or {})
    if not body_typography:
        body_typography = (body.get("typography") or {})

    return "|".join([
        "table",
        source,
        table_payload.get("table_style_id") or "default",
        str(header_row),
        header_fill,
        body_fill,
        str(header_typography.get("size_pt")),
        str(body_typography.get("size_pt")),
        header_typography.get("family") or "",
        body_typography.get("family") or "",
    ])


def _chart_variant_signature(chart_payload: dict[str, Any]) -> str:
    subtype = chart_payload.get("subtype") or {}
    palette = chart_payload.get("style_tokens", {}).get("series_palette") or []
    palette_sig = ",".join(
        item.get("scheme") or item.get("color") or "none"
        for item in palette
    )
    return "|".join([
        "chart",
        chart_payload.get("type") or "chart",
        subtype.get("direction") or "",
        subtype.get("grouping") or "",
        palette_sig,
    ])


def _diagram_variant_signature(diagram_payload: dict[str, Any]) -> str:
    return "|".join([
        "diagram",
        diagram_payload.get("diagram_type") or "smartart",
        diagram_payload.get("layout_id") or "",
        str(diagram_payload.get("node_count") or 0),
    ])


def _extract_text_content(body) -> str:
    parts: list[str] = []
    for paragraph in body.findall("a:p", NS):
        line_parts: list[str] = []
        for node in paragraph.iter():
            tag = node.tag.rsplit("}", 1)[-1]
            if tag == "t" and node.text:
                line_parts.append(node.text)
            elif tag == "tab":
                line_parts.append("\t")
            elif tag == "br":
                line_parts.append("\n")
        parts.append("".join(line_parts))
    return "\n".join(part for part in parts if part).strip()


def _related_part(package, part: str, relationship_id: str, rel_type: str) -> str | None:
    directory = posixpath.dirname(part)
    filename = posixpath.basename(part)
    rels_path = f"{directory}/_rels/{filename}.rels"
    try:
        rels = package.xml(rels_path)
    except Exception:
        return None
    for relation in rels.findall("r:Relationship", REL_NS):
        if relation.get("Id") != relationship_id or relation.get("Type") != rel_type:
            continue
        target = relation.get("Target")
        if not target:
            return None
        if target.startswith("/"):
            return target.lstrip("/")
        return posixpath.normpath(posixpath.join(directory, target))
    return None
