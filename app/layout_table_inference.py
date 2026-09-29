"""Infer DOM-renderable tables from slide shapes arranged in a row/column grid."""

from __future__ import annotations

import json
from collections import Counter
from statistics import median
from typing import Any

from .graphic_elements import (
    EMU_PER_PT,
    _infer_horizontal_merges,
    _table_variant_signature,
    apply_table_intrinsic_geometry,
    build_graphic_component_meta,
    detect_table_row_sizing_mode,
)
from .table_styles import (
    complete_style_grid_typography,
    _is_transparent_typography,
    list_blank_stub_cells,
    row_typography_from_cell_text,
)

MIN_ROWS = 2
MIN_COLS = 2
MIN_FILLED_CELLS = 6
MIN_FILL_RATIO = 0.85
ROW_CLUSTER_TOL_PT = 4.0
COL_CLUSTER_TOL_PT = 4.0
ASSIGN_Y_TOL_PT = 14.0
ASSIGN_X_TOL_PT = 24.0
HLINE_MAX_HEIGHT_PT = 2.5
HLINE_MIN_WIDTH_RATIO = 0.35
FRAME_EDGE_TOL_PT = 20.0
FRAME_MAX_SLIDE_AREA_RATIO = 0.88
TABLE_REGION_MARGIN_PT = 2.0
MAX_CELL_TEXT_LEN = 600
FRAME_CANDIDATE_KINDS = frozenset({"image", "fill", "shape", "graphic"})
FONT_SIZE_TOL_PT = 0.75
TITLE_PLACEHOLDER_TYPES = frozenset({"title", "ctrTitle", "subtitle", "subTitle"})
DEFAULT_BORDER = {"width_pt": 0.75, "color": "#CCCCCC", "dash": "solid"}


def apply_layout_table_inference(slides_catalog: dict | None, slide_size: tuple[float, float] | None) -> None:
    if not slides_catalog or not slide_size:
        return

    slide_width, slide_height = slide_size
    inferred_slides = 0

    for slide in slides_catalog.get("slides") or []:
        if infer_layout_table_on_slide(slide, slide_width, slide_height):
            inferred_slides += 1

    summary = slides_catalog.setdefault("summary", {})
    summary["inferred_table_slides"] = inferred_slides


def infer_layout_table_on_slide(slide: dict[str, Any], slide_width: float, slide_height: float) -> bool:
    elements = slide.get("content_elements") or []
    if any(element.get("kind") == "table" for element in elements):
        return False

    candidates = _grid_typography_candidates(elements)
    if len(candidates) < MIN_FILLED_CELLS:
        return False

    row_centers = _cluster_axis([element["geometry_pt"]["y_pt"] for element in candidates], ROW_CLUSTER_TOL_PT)
    col_centers = _cluster_axis([element["geometry_pt"]["x_pt"] for element in candidates], COL_CLUSTER_TOL_PT)
    if len(row_centers) < MIN_ROWS or len(col_centers) < MIN_COLS:
        return False

    row_count = len(row_centers)
    col_count = len(col_centers)
    matrix: list[list[dict[str, Any] | None]] = [[None for _ in range(col_count)] for _ in range(row_count)]
    duplicates = 0

    for element in candidates:
        geometry = element["geometry_pt"]
        row_index = _nearest_index(geometry["y_pt"], row_centers, ASSIGN_Y_TOL_PT)
        col_index = _nearest_index(geometry["x_pt"], col_centers, ASSIGN_X_TOL_PT)
        if row_index is None or col_index is None:
            continue
        if matrix[row_index][col_index] is not None:
            duplicates += 1
            continue
        matrix[row_index][col_index] = element

    filled = sum(1 for row in matrix for cell in row if cell is not None)
    if filled < MIN_FILLED_CELLS:
        return False

    fill_ratio = filled / (row_count * col_count)
    if fill_ratio < MIN_FILL_RATIO:
        return False
    if duplicates > max(2, filled * 0.05):
        return False

    if not _grid_is_regular(matrix, row_centers, col_centers):
        return False
    if not _matrix_has_uniform_font_size(matrix):
        return False
    if filled != len(candidates):
        return False

    preview = [[(matrix[r][c].get("text") or "")[:120] if matrix[r][c] else "" for c in range(col_count)] for r in range(row_count)]
    merged_cells = _infer_horizontal_merges(preview, [])
    column_widths_pt = _column_widths_pt(matrix, col_centers)
    row_heights_pt = _row_heights_pt(matrix, row_centers)
    grid_bbox = _grid_bbox_from_matrix(matrix)
    geometry_pt, geometry_norm = _table_geometry_from_bbox(grid_bbox, slide_width, slide_height)

    frame_element, frame_source = _find_table_frame(
        elements,
        grid_bbox,
        member_z=min(element.get("z_index", 0) for row in matrix for element in row if element is not None),
        slide_width=slide_width,
        slide_height=slide_height,
    )
    frame_padding_pt: dict[str, float] | None = None
    if frame_element is not None:
        frame_padding_pt = _frame_padding_pt(frame_element["geometry_pt"], grid_bbox)

    hline_bounds = _hline_search_bounds(grid_bbox, frame_element["geometry_pt"] if frame_element else None)
    if not _slide_structure_is_clean(elements, matrix, candidates, hline_bounds, frame_element, grid_bbox):
        return False

    cell_text: list[list[dict[str, Any] | None]] = [[None for _ in range(col_count)] for _ in range(row_count)]
    cell_styles: list[list[dict[str, Any] | None]] = [[None for _ in range(col_count)] for _ in range(row_count)]
    for row_index, row in enumerate(matrix):
        for col_index, element in enumerate(row):
            if element is None:
                continue
            cell_text[row_index][col_index] = _cell_text_from_element(element)
            cell_styles[row_index][col_index] = _cell_style_from_element(element)

    hlines = _table_hlines(elements, hline_bounds)
    _apply_hline_borders(cell_styles, matrix, hlines)

    header_row = _detect_header_row(matrix, preview)
    flags = {
        "first_row": header_row == 0,
        "first_col": _has_first_col_labels(matrix, preview),
        "last_col": _has_last_col_typography_accent(cell_text, row_count, col_count),
        "last_row": False,
        "band_row": False,
        "band_col": False,
    }
    cell_styles = complete_style_grid_typography(
        cell_styles,
        style_rules={},
        style_tokens={},
        flags=flags,
        row_count=row_count,
        col_count=col_count,
        theme_map={"tx1": "#000000"},
        preview=preview,
        cell_text_grid=cell_text,
    )
    style_tokens = _style_tokens_from_grid(cell_styles, header_row)
    row_sizing = detect_table_row_sizing_mode(row_heights_pt, cell_text, cell_styles, row_count)

    layout_width_pt = round(sum(column_widths_pt), 2)
    table_payload: dict[str, Any] = {
        "source": "inferred_grid",
        "frame_source": frame_source,
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
                cell_text,
                header_row=header_row if header_row is not None else 0,
            ),
        },
        "style_tokens": style_tokens,
        "style_rules": {},
        "cell_styles": cell_styles,
        "cell_text": cell_text,
        "content_model": {
            "kind": "grid",
            "columns": col_count,
            "rows": row_count,
            "cell_fields": ["value"],
            "layout_width_pt": layout_width_pt,
            "column_weights_from": "column_widths_pt",
        },
        "data_preview": {"rows": preview},
    }
    if frame_element is not None:
        table_payload["inferred_frame"] = {
            "element_id": frame_element.get("element_id"),
            "kind": frame_element.get("kind"),
        }
    if frame_padding_pt is not None:
        table_payload["frame_padding_pt"] = frame_padding_pt
        table_payload["padding_pt"] = frame_padding_pt

    slide_width_emu = slide_width * EMU_PER_PT
    slide_height_emu = slide_height * EMU_PER_PT
    geometry_pt, geometry_norm = apply_table_intrinsic_geometry(
        geometry_pt,
        geometry_norm,
        table_payload,
        slide_width_emu=slide_width_emu,
        slide_height_emu=slide_height_emu,
    )
    if frame_element is not None and frame_padding_pt is not None:
        geometry_pt, geometry_norm = _apply_frame_outer_geometry(
            frame_element["geometry_pt"],
            frame_padding_pt,
            table_payload,
            row_heights_pt,
            slide_width,
            slide_height,
        )

    consumed_ids = {
        element["element_id"]
        for row in matrix for element in row if element is not None
    }
    consumed_ids.update(line["element_id"] for line in hlines)

    member_z = min(element.get("z_index", 0) for row in matrix for element in row if element is not None)
    table_element = {
        "element_id": f"inferred_table_slide_{slide.get('slide_number')}",
        "kind": "table",
        "source_scope": "inferred_grid",
        "z_index": member_z,
        "name": "Inferred layout table",
        "geometry_pt": geometry_pt,
        "geometry_norm": geometry_norm,
        "rows": row_count,
        "cols": col_count,
        "preview": preview,
        "table": table_payload,
        "component": build_graphic_component_meta(
            kind="table",
            slot_role="table",
            variant_signature=_table_variant_signature(table_payload),
        ),
        "inference": {
            "confidence": round(min(0.99, 0.55 + fill_ratio * 0.4), 3),
            "filled_cells": filled,
            "total_cells": row_count * col_count,
            "consumed_element_ids": sorted(consumed_ids),
            "hline_count": len(hlines),
            "typography_size_pt": _dominant_font_size_pt(candidates),
            "frame_source": frame_source,
            "frame_element_id": frame_element.get("element_id") if frame_element else None,
            "frame_padding_pt": frame_padding_pt,
            "grid_bbox_pt": grid_bbox,
        },
    }

    remaining = [element for element in elements if element.get("element_id") not in consumed_ids]
    remaining.append(table_element)
    remaining.sort(key=lambda item: item.get("z_index", 0))

    slide["content_elements"] = remaining
    slide["element_count"] = len(remaining)
    slide["element_summary"] = _summarize_elements(remaining)
    slide["inferred_table"] = {
        "rows": row_count,
        "cols": col_count,
        "filled_cells": filled,
        "confidence": table_element["inference"]["confidence"],
    }
    return True


def _is_simple_table_cell(element: dict[str, Any]) -> bool:
    if element.get("kind") != "text":
        return False
    if element.get("split_from_shape"):
        return False
    if element.get("text_group_id"):
        return False
    if element.get("placeholder_type") in TITLE_PLACEHOLDER_TYPES:
        return False
    text = element.get("text") or ""
    if len(text) > MAX_CELL_TEXT_LEN:
        return False
    paragraphs = element.get("text_paragraphs") or []
    if len(paragraphs) > 4:
        return False
    return True


def _font_size_pt(element: dict[str, Any]) -> float | None:
    size = (element.get("typography") or {}).get("size_pt")
    if size is None:
        return None
    try:
        return round(float(size), 2)
    except (TypeError, ValueError):
        return None


def _dominant_font_size_pt(elements: list[dict[str, Any]]) -> float | None:
    sizes = [_font_size_pt(element) for element in elements]
    sizes = [size for size in sizes if size is not None]
    if not sizes:
        return None
    return Counter(sizes).most_common(1)[0][0]


def _matches_dominant_font_size(element: dict[str, Any], dominant_size_pt: float | None) -> bool:
    if dominant_size_pt is None:
        return True
    size = _font_size_pt(element)
    if size is None:
        return False
    return abs(size - dominant_size_pt) <= FONT_SIZE_TOL_PT


def _has_strict_dominant_font_size(elements: list[dict[str, Any]]) -> bool:
    sizes = [_font_size_pt(element) for element in elements]
    sizes = [size for size in sizes if size is not None]
    if not sizes:
        return False
    ranked = Counter(sizes).most_common(2)
    if len(ranked) == 1:
        return True
    return ranked[0][1] > ranked[1][1]


def _grid_typography_candidates(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    simple = [element for element in elements if _is_simple_table_cell(element)]
    if len(simple) < MIN_FILLED_CELLS:
        return []
    if not _has_strict_dominant_font_size(simple):
        return []

    dominant_size_pt = _dominant_font_size_pt(simple)
    if dominant_size_pt is None:
        return []

    matched = [
        element for element in simple
        if _matches_dominant_font_size(element, dominant_size_pt)
    ]
    return matched if len(matched) >= MIN_FILLED_CELLS else []


def _matrix_has_uniform_font_size(matrix: list[list[dict[str, Any] | None]]) -> bool:
    cells = [cell for row in matrix for cell in row if cell is not None]
    if not cells:
        return False
    dominant_size_pt = _dominant_font_size_pt(cells)
    if dominant_size_pt is None:
        return False
    return all(_matches_dominant_font_size(cell, dominant_size_pt) for cell in cells)


def _cluster_axis(values: list[float], tolerance: float) -> list[float]:
    if not values:
        return []
    ordered = sorted(values)
    clusters: list[list[float]] = [[ordered[0]]]
    for value in ordered[1:]:
        if value - clusters[-1][-1] <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [round(float(median(cluster)), 2) for cluster in clusters]


def _nearest_index(value: float, centers: list[float], tolerance: float) -> int | None:
    best_index = None
    best_distance = tolerance + 1
    for index, center in enumerate(centers):
        distance = abs(value - center)
        if distance <= tolerance and distance < best_distance:
            best_distance = distance
            best_index = index
    return best_index


def _grid_is_regular(
    matrix: list[list[dict[str, Any] | None]],
    row_centers: list[float],
    col_centers: list[float],
) -> bool:
    row_gaps = [row_centers[index + 1] - row_centers[index] for index in range(len(row_centers) - 1)]
    col_gaps = [col_centers[index + 1] - col_centers[index] for index in range(len(col_centers) - 1)]
    if len(row_gaps) >= 2 and not _gaps_mostly_regular(row_gaps, rel=0.4, abs_pt=8.0):
        return False
    if len(col_gaps) >= 2 and not _gaps_mostly_regular(col_gaps, rel=0.45, abs_pt=12.0):
        return False

    filled_rows = sum(1 for row in matrix if any(cell is not None for cell in row))
    filled_cols = sum(
        1 for col_index in range(len(matrix[0]))
        if any(row[col_index] is not None for row in matrix)
    )
    return filled_rows >= MIN_ROWS and filled_cols >= MIN_COLS


def _gaps_mostly_regular(values: list[float], *, rel: float, abs_pt: float) -> bool:
    if len(values) < 2:
        return True
    med = float(median(values))
    trimmed = sorted(values, key=lambda value: abs(value - med))
    core = trimmed[: max(2, len(trimmed) - 1)]
    return _values_regular(core, rel=rel, abs_pt=abs_pt)


def _values_regular(values: list[float], *, rel: float, abs_pt: float) -> bool:
    if len(values) < 2:
        return True
    med = float(median(values))
    if med <= 0:
        return False
    return all(abs(value - med) <= max(abs_pt, med * rel) for value in values)


def _column_widths_pt(
    matrix: list[list[dict[str, Any] | None]],
    col_centers: list[float],
) -> list[float]:
    widths: list[float] = []
    for col_index in range(len(col_centers)):
        cells = [row[col_index] for row in matrix if row[col_index] is not None]
        if cells:
            left = min(cell["geometry_pt"]["x_pt"] for cell in cells)
            right = max(cell["geometry_pt"]["x_pt"] + cell["geometry_pt"]["width_pt"] for cell in cells)
            widths.append(round(max(right - left, 1.0), 2))
            continue
        if col_index + 1 < len(col_centers):
            widths.append(round(max(col_centers[col_index + 1] - col_centers[col_index], 1.0), 2))
        elif widths:
            widths.append(widths[-1])
        else:
            widths.append(1.0)
    return widths


def _row_heights_pt(
    matrix: list[list[dict[str, Any] | None]],
    row_centers: list[float],
) -> list[float]:
    heights: list[float] = []
    for row_index in range(len(row_centers)):
        cells = [cell for cell in matrix[row_index] if cell is not None]
        if row_index + 1 < len(row_centers):
            heights.append(round(row_centers[row_index + 1] - row_centers[row_index], 2))
            continue
        if cells:
            top = min(cell["geometry_pt"]["y_pt"] for cell in cells)
            bottom = max(cell["geometry_pt"]["y_pt"] + cell["geometry_pt"]["height_pt"] for cell in cells)
            heights.append(round(max(bottom - top, 1.0), 2))
            continue
        heights.append(heights[-1] if heights else 1.0)
    return heights


def _allowed_table_element_ids(
    elements: list[dict[str, Any]],
    matrix: list[list[dict[str, Any] | None]],
    hline_bounds: dict[str, float],
    frame_element: dict[str, Any] | None,
) -> set[str]:
    allowed = {
        cell["element_id"]
        for row in matrix for cell in row if cell is not None
    }
    for element in elements:
        if element.get("placeholder_type") in TITLE_PLACEHOLDER_TYPES:
            allowed.add(element["element_id"])
    if frame_element is not None and frame_element.get("element_id"):
        allowed.add(frame_element["element_id"])
    for line in _table_hlines(elements, hline_bounds):
        allowed.add(line["element_id"])
    return allowed


def _geometry_intersects_region(
    geometry: dict[str, Any],
    region: dict[str, float],
    *,
    margin_pt: float = TABLE_REGION_MARGIN_PT,
) -> bool:
    left = float(geometry.get("x_pt") or 0)
    top = float(geometry.get("y_pt") or 0)
    right = left + float(geometry.get("width_pt") or 0)
    bottom = top + float(geometry.get("height_pt") or 0)
    region_left = region["left_pt"] - margin_pt
    region_top = region["top_pt"] - margin_pt
    region_right = region["right_pt"] + margin_pt
    region_bottom = region["bottom_pt"] + margin_pt
    return not (right < region_left or left > region_right or bottom < region_top or top > region_bottom)


def _slide_structure_is_clean(
    elements: list[dict[str, Any]],
    matrix: list[list[dict[str, Any] | None]],
    candidates: list[dict[str, Any]],
    hline_bounds: dict[str, float],
    frame_element: dict[str, Any] | None,
    grid_bbox: dict[str, float],
) -> bool:
    allowed_ids = _allowed_table_element_ids(elements, matrix, hline_bounds, frame_element)
    grid_region = {
        "left_pt": grid_bbox["left_pt"],
        "top_pt": grid_bbox["top_pt"],
        "right_pt": grid_bbox["right_pt"],
        "bottom_pt": grid_bbox["bottom_pt"],
    }

    for element in elements:
        if element.get("element_id") in allowed_ids:
            continue
        geometry = element.get("geometry_pt") or {}
        if not _geometry_intersects_region(geometry, grid_region):
            continue
        return False
    return True


def _grid_bbox_from_matrix(matrix: list[list[dict[str, Any] | None]]) -> dict[str, float]:
    cells = [cell for row in matrix for cell in row if cell is not None]
    left = min(cell["geometry_pt"]["x_pt"] for cell in cells)
    top = min(cell["geometry_pt"]["y_pt"] for cell in cells)
    right = max(cell["geometry_pt"]["x_pt"] + cell["geometry_pt"]["width_pt"] for cell in cells)
    bottom = max(cell["geometry_pt"]["y_pt"] + cell["geometry_pt"]["height_pt"] for cell in cells)
    return {
        "left_pt": round(left, 2),
        "top_pt": round(top, 2),
        "right_pt": round(right, 2),
        "bottom_pt": round(bottom, 2),
        "width_pt": round(right - left, 2),
        "height_pt": round(bottom - top, 2),
    }


def _table_geometry_from_bbox(
    grid_bbox: dict[str, float],
    slide_width: float,
    slide_height: float,
) -> tuple[dict[str, float], dict[str, float]]:
    return _geometry_from_frame(
        {
            "x_pt": grid_bbox["left_pt"],
            "y_pt": grid_bbox["top_pt"],
            "width_pt": grid_bbox["width_pt"],
            "height_pt": grid_bbox["height_pt"],
        },
        slide_width,
        slide_height,
    )


def _geometry_from_frame(
    frame_geometry: dict[str, float],
    slide_width: float,
    slide_height: float,
) -> tuple[dict[str, float], dict[str, float]]:
    left = round(float(frame_geometry["x_pt"]), 2)
    top = round(float(frame_geometry["y_pt"]), 2)
    width = round(float(frame_geometry["width_pt"]), 2)
    height = round(float(frame_geometry["height_pt"]), 2)
    geometry_pt = {
        "x_pt": left,
        "y_pt": top,
        "width_pt": width,
        "height_pt": height,
    }
    geometry_norm = {
        "x": round(left / slide_width, 4) if slide_width else 0,
        "y": round(top / slide_height, 4) if slide_height else 0,
        "width": round(width / slide_width, 4) if slide_width else 0,
        "height": round(height / slide_height, 4) if slide_height else 0,
    }
    return geometry_pt, geometry_norm


def _frame_padding_pt(
    frame_geometry: dict[str, float],
    grid_bbox: dict[str, float],
) -> dict[str, float]:
    frame_left = float(frame_geometry["x_pt"])
    frame_top = float(frame_geometry["y_pt"])
    frame_right = frame_left + float(frame_geometry["width_pt"])
    frame_bottom = frame_top + float(frame_geometry["height_pt"])
    padding = {
        "left": round(grid_bbox["left_pt"] - frame_left, 2),
        "top": round(grid_bbox["top_pt"] - frame_top, 2),
        "right": round(frame_right - grid_bbox["right_pt"], 2),
        "bottom": round(frame_bottom - grid_bbox["bottom_pt"], 2),
    }
    return {key: max(value, 0.0) for key, value in padding.items()}


def _apply_frame_outer_geometry(
    frame_geometry: dict[str, float],
    frame_padding_pt: dict[str, float],
    table_payload: dict[str, Any],
    row_heights_pt: list[float],
    slide_width: float,
    slide_height: float,
) -> tuple[dict[str, float], dict[str, float]]:
    content_width_pt = round(sum(table_payload.get("column_widths_pt") or []), 2)
    content_height_pt = round(sum(row_heights_pt), 2)
    outer_geometry_pt, outer_geometry_norm = _geometry_from_frame(
        frame_geometry,
        slide_width,
        slide_height,
    )

    padding_top = float(frame_padding_pt.get("top") or 0)
    padding_bottom = float(frame_padding_pt.get("bottom") or 0)
    target_content_height_pt = round(
        float(outer_geometry_pt["height_pt"]) - padding_top - padding_bottom,
        2,
    )
    target_content_height_pt = max(target_content_height_pt, content_height_pt, 1.0)

    table_payload["padding_pt"] = frame_padding_pt
    table_payload["frame_padding_pt"] = frame_padding_pt
    table_payload["layout_width_pt"] = content_width_pt
    table_payload["layout_height_pt"] = target_content_height_pt
    table_payload["content_width_pt"] = content_width_pt
    table_payload["content_height_pt"] = content_height_pt
    table_payload["target_content_height_pt"] = target_content_height_pt
    table_payload["frame_width_pt"] = outer_geometry_pt["width_pt"]
    table_payload["frame_height_pt"] = outer_geometry_pt["height_pt"]
    if table_payload.get("structure") is not None:
        table_payload["structure"]["row_sizing"] = {
            "mode": "fit_content",
            "reason": "inferred_frame_padding",
            "grid_sum_pt": content_height_pt,
            "frame_height_pt": target_content_height_pt,
            "outer_frame_height_pt": outer_geometry_pt["height_pt"],
            "extra_height_pt": round(max(target_content_height_pt - content_height_pt, 0), 2),
        }

    return outer_geometry_pt, outer_geometry_norm


def _find_table_frame(
    elements: list[dict[str, Any]],
    grid_bbox: dict[str, float],
    *,
    member_z: int,
    slide_width: float,
    slide_height: float,
) -> tuple[dict[str, Any] | None, str]:
    best_element: dict[str, Any] | None = None
    best_score: float | None = None
    slide_area = slide_width * slide_height

    for element in elements:
        score = _frame_candidate_score(
            element,
            grid_bbox,
            member_z=member_z,
            slide_area=slide_area,
            slide_width=slide_width,
            slide_height=slide_height,
        )
        if score is None:
            continue
        if best_score is None or score < best_score:
            best_score = score
            best_element = element

    if best_element is None:
        return None, "cell_grid"
    return best_element, "background_shape"


def _frame_candidate_score(
    element: dict[str, Any],
    grid_bbox: dict[str, float],
    *,
    member_z: int,
    slide_area: float,
    slide_width: float,
    slide_height: float,
) -> float | None:
    if element.get("kind") not in FRAME_CANDIDATE_KINDS:
        return None
    if element.get("z_index", 0) >= member_z:
        return None

    geometry = element.get("geometry_pt") or {}
    if _is_hline_geometry(geometry, grid_bbox):
        return None

    frame_left = float(geometry.get("x_pt") or 0)
    frame_top = float(geometry.get("y_pt") or 0)
    frame_width = float(geometry.get("width_pt") or 0)
    frame_height = float(geometry.get("height_pt") or 0)
    if frame_width <= 0 or frame_height <= 0:
        return None

    frame_right = frame_left + frame_width
    frame_bottom = frame_top + frame_height
    grid_left = grid_bbox["left_pt"]
    grid_top = grid_bbox["top_pt"]
    grid_right = grid_bbox["right_pt"]
    grid_bottom = grid_bbox["bottom_pt"]

    if frame_left > grid_left + FRAME_EDGE_TOL_PT:
        return None
    if frame_top > grid_top + FRAME_EDGE_TOL_PT:
        return None
    if frame_right < grid_right - FRAME_EDGE_TOL_PT:
        return None
    if frame_bottom < grid_bottom - FRAME_EDGE_TOL_PT:
        return None

    frame_area = frame_width * frame_height
    if slide_area > 0 and frame_area / slide_area > FRAME_MAX_SLIDE_AREA_RATIO:
        return None
    if frame_width >= slide_width * 0.92 and frame_height >= slide_height * 0.92:
        return None

    edge_penalty = abs(frame_left - grid_left) + abs(frame_top - grid_top)
    contain_penalty = max(0.0, frame_right - grid_right) + max(0.0, frame_bottom - grid_bottom)
    excess_area = max(0.0, frame_area - (grid_bbox["width_pt"] * grid_bbox["height_pt"]))
    return edge_penalty * 2.0 + contain_penalty + excess_area * 0.001


def _is_hline_geometry(geometry: dict[str, Any], grid_bbox: dict[str, float]) -> bool:
    height = float(geometry.get("height_pt") or 0)
    width = float(geometry.get("width_pt") or 0)
    if height <= 0:
        return False
    if height > HLINE_MAX_HEIGHT_PT:
        return False
    min_width = grid_bbox["width_pt"] * HLINE_MIN_WIDTH_RATIO
    return width >= min_width


def _cell_text_from_element(element: dict[str, Any]) -> dict[str, Any]:
    text = element.get("text") or ""
    payload: dict[str, Any] = {"text": text}
    typography = element.get("typography") or {}
    if text.strip() and not _is_transparent_typography(typography):
        payload["typography"] = dict(typography)
    if element.get("bullet"):
        payload["bullet"] = element["bullet"]
    if element.get("paragraph_spacing_pt"):
        payload["paragraph_spacing_pt"] = element["paragraph_spacing_pt"]
    if element.get("text_paragraphs"):
        payload["text_paragraphs"] = element["text_paragraphs"]
    return payload


def _cell_style_from_element(element: dict[str, Any]) -> dict[str, Any]:
    style: dict[str, Any] = {}
    if element.get("vertical_anchor"):
        style["vertical_anchor"] = element["vertical_anchor"]
    insets = element.get("body_insets_pt") or {}
    padding = {
        key: round(float(insets[key]), 2)
        for key in ("top", "right", "bottom", "left")
        if insets.get(key)
    }
    if padding:
        style["padding_pt"] = padding
    return style


def _hline_search_bounds(
    grid_bbox: dict[str, float],
    frame_geometry: dict[str, float] | None,
) -> dict[str, float]:
    if not frame_geometry:
        return grid_bbox
    frame_left = float(frame_geometry["x_pt"])
    frame_top = float(frame_geometry["y_pt"])
    frame_width = float(frame_geometry["width_pt"])
    frame_height = float(frame_geometry["height_pt"])
    return {
        "left_pt": frame_left,
        "top_pt": frame_top,
        "right_pt": round(frame_left + frame_width, 2),
        "bottom_pt": round(frame_top + frame_height, 2),
        "width_pt": round(frame_width, 2),
        "height_pt": round(frame_height, 2),
    }


def _table_hlines(elements: list[dict[str, Any]], bounds: dict[str, float]) -> list[dict[str, Any]]:
    grid_left = bounds["left_pt"]
    grid_right = bounds["right_pt"]
    grid_top = bounds["top_pt"]
    grid_bottom = bounds["bottom_pt"]
    hlines: list[dict[str, Any]] = []

    for element in elements:
        if element.get("kind") != "image":
            continue
        geometry = element.get("geometry_pt") or {}
        if not _is_hline_geometry(geometry, bounds):
            continue
        y_pt = float(geometry.get("y_pt") or 0)
        x_pt = float(geometry.get("x_pt") or 0)
        width = float(geometry.get("width_pt") or 0)
        if y_pt < grid_top - 2 or y_pt > grid_bottom + 2:
            continue
        if x_pt + width < grid_left + 10 or x_pt > grid_right - 10:
            continue
        hlines.append(element)
    return hlines


def _apply_hline_borders(
    cell_styles: list[list[dict[str, Any] | None]],
    matrix: list[list[dict[str, Any] | None]],
    hlines: list[dict[str, Any]],
) -> None:
    if not hlines:
        return

    row_bottoms: list[float | None] = []
    for row in matrix:
        cells = [cell for cell in row if cell is not None]
        if not cells:
            row_bottoms.append(None)
            continue
        row_bottoms.append(
            round(max(cell["geometry_pt"]["y_pt"] + cell["geometry_pt"]["height_pt"] for cell in cells), 2)
        )

    for line in hlines:
        y_pt = float(line["geometry_pt"]["y_pt"])
        target_row = None
        best_distance = 9999.0
        for row_index, bottom in enumerate(row_bottoms):
            if bottom is None:
                continue
            distance = abs(y_pt - bottom)
            if distance < best_distance:
                best_distance = distance
                target_row = row_index
        if target_row is None or best_distance > 12:
            continue
        for col_index, cell_style in enumerate(cell_styles[target_row]):
            if cell_style is None:
                cell_styles[target_row][col_index] = {}
            borders = dict(cell_styles[target_row][col_index].get("borders") or {})
            borders["bottom"] = dict(DEFAULT_BORDER)
            cell_styles[target_row][col_index]["borders"] = borders


def _detect_header_row(matrix: list[list[dict[str, Any] | None]], preview: list[list[str]]) -> int | None:
    for row_index, row in enumerate(matrix):
        filled = [cell for cell in row if cell is not None]
        if len(filled) < 2:
            continue
        labels = [str(preview[row_index][col_index] or "").strip() for col_index, cell in enumerate(row) if cell]
        if not labels:
            continue
        bold_count = sum(1 for cell in filled if (cell.get("typography") or {}).get("bold"))
        if bold_count >= max(2, len(filled) // 2):
            return row_index
        if row_index > 0 and all(len(label) <= 24 for label in labels):
            return row_index
    return None


def _has_last_col_typography_accent(
    cell_text: list[list[dict[str, Any] | None]],
    row_count: int,
    col_count: int,
) -> bool:
    if col_count <= 2 or row_count <= 1:
        return False
    body_col = 1 if col_count > 2 else 0
    last_col = col_count - 1
    matches = 0
    checks = 0
    for row_index in range(1, row_count):
        if row_index >= len(cell_text):
            continue
        row_entries = cell_text[row_index] or []
        if last_col >= len(row_entries) or body_col >= len(row_entries):
            continue
        last_entry = row_entries[last_col]
        body_entry = row_entries[body_col]
        if not isinstance(last_entry, dict) or not isinstance(body_entry, dict):
            continue
        last_text = str(last_entry.get("text") or "").strip()
        body_text = str(body_entry.get("text") or "").strip()
        if not last_text or not body_text:
            continue
        checks += 1
        last_typo = last_entry.get("typography") or {}
        body_typo = body_entry.get("typography") or {}
        if json.dumps(last_typo, sort_keys=True) != json.dumps(body_typo, sort_keys=True):
            matches += 1
    return checks >= 2 and matches / checks >= 0.6


def _has_first_col_labels(matrix: list[list[dict[str, Any] | None]], preview: list[list[str]]) -> bool:
    if not matrix or not matrix[0]:
        return False
    labels = 0
    for row_index in range(1, len(matrix)):
        if matrix[row_index][0] is None:
            continue
        text = str(preview[row_index][0] or "").strip()
        if text:
            labels += 1
    return labels >= max(2, len(matrix) // 3)


def _layout_style_only(style: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in style.items() if key != "typography"}


def _style_without_cell_highlight(style: dict[str, Any]) -> dict[str, Any]:
    return _layout_style_only(style)


def _header_row_common_style(
    cell_styles: list[list[dict[str, Any] | None]],
    header_row: int,
    col_count: int,
) -> dict[str, Any] | None:
    row = cell_styles[header_row]
    for col_index in range(col_count):
        if col_index >= len(row):
            continue
        style = row[col_index]
        if not style:
            continue
        if not (style.get("fill") or {}).get("color"):
            return _style_without_cell_highlight(style)
    for col_index in range(col_count):
        if col_index < len(row) and row[col_index]:
            return _style_without_cell_highlight(row[col_index])
    return None


def _style_tokens_from_grid(
    cell_styles: list[list[dict[str, Any] | None]],
    header_row: int | None,
) -> dict[str, Any]:
    tokens: dict[str, Any] = {}
    if header_row is not None and header_row < len(cell_styles):
        header_style = _header_row_common_style(cell_styles, header_row, len(cell_styles[header_row]))
        if header_style:
            tokens["header_cell"] = header_style
            tokens["first_row_cell"] = header_style
    body_style = None
    start = (header_row or 0) + 1
    for row_index in range(start, len(cell_styles)):
        for cell_style in cell_styles[row_index]:
            if cell_style:
                body_style = cell_style
                break
        if body_style:
            break
    if body_style:
        tokens["body_cell"] = _layout_style_only(body_style)
        tokens["whole_cell"] = _layout_style_only(body_style)
    return tokens


def _summarize_elements(elements: list[dict[str, Any]]) -> dict[str, int]:
    summary: dict[str, int] = {}
    for element in elements:
        kind = element.get("kind", "unknown")
        summary[kind] = summary.get(kind, 0) + 1
    return summary
