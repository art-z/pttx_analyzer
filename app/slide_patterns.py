"""Detect repeatable content blocks from the slide catalog."""

from __future__ import annotations

from collections import Counter, defaultdict
from statistics import median

MIN_LAYOUT_INSTANCES = 2
MIN_DECK_INSTANCES = 3
CLUSTER_GAP_RATIO = 0.04
POSITION_GRID = 8
MIN_BLOCK_AREA = 0.0008
MIN_FILL_AREA = 0.00025
MAX_BLOCK_AREA = 0.55
BACKGROUND_COVERAGE = 0.34
MIN_BLOCK_CHILDREN = 2
MAX_BLOCK_CHILDREN = 12
MIN_ROW_ICONS = 3
ICON_TEXT_MAX_VERTICAL_GAP_RATIO = 0.14
ICON_HORIZONTAL_MARGIN_RATIO = 0.35
FILL_LABEL_MAX_GAP_NORM = 0.14
FILL_DESCRIPTION_MAX_GAP_NORM = 0.2
FILL_CARD_TEXT_OVERLAP_MIN = 0.45
GRAPHIC_KINDS = frozenset({"icon", "image", "fill"})
ICON_ASSET_SHEET_MIN_ICONS = 32
ICON_ASSET_SHEET_UNIQUE_RATIO = 0.65


def is_icon_asset_sheet(elements: list[dict]) -> bool:
    """Slides that mostly list unique icon assets (libraries), not reusable UI components."""
    icons = [element for element in elements if element.get("kind") in {"icon", "image"}]
    if len(icons) < ICON_ASSET_SHEET_MIN_ICONS:
        return False
    assets = {element.get("asset") for element in icons if element.get("asset")}
    if not assets:
        return False
    return len(assets) >= len(icons) * ICON_ASSET_SHEET_UNIQUE_RATIO


def is_step_label(text: str | None, typography: dict | None = None) -> bool:
    value = (text or "").strip()
    if value.isdigit() and 1 <= len(value) <= 2:
        return True
    if len(value) == 4 and value.isdigit() and value[:2] in {"19", "20"}:
        return True
    size_pt = (typography or {}).get("size_pt") or 0
    return size_pt >= 20 and len(value) <= 8 and bool(value)


def detect_slide_patterns(slide_catalog: dict | None, assets: dict | None = None) -> dict:
    slides = (slide_catalog or {}).get("slides", [])
    if not slides:
        return {"patterns": [], "summary": {"pattern_count": 0, "instance_count": 0}}

    icon_files = _icon_files(assets)
    instances: list[dict] = []
    for slide in slides:
        slide_number = slide["slide_number"]
        layout_source = slide.get("layout_source")
        elements = _content_elements_for_clustering(slide.get("content_elements") or [], icon_files)
        slide_size = _slide_size_pt(slide)
        blocks = _blocks_on_slide(elements, slide_size)
        for index, block in enumerate(blocks, start=1):
            fingerprint = _structure_fingerprint(block)
            instances.append({
                "slide_number": slide_number,
                "layout_source": layout_source,
                "layout_name": slide.get("layout_name"),
                "template_id": slide.get("template_id"),
                "block_index": index,
                "fingerprint": fingerprint,
                "position_fingerprint": _position_fingerprint(block),
                "container": block["bbox_norm"],
                "container_pt": block["bbox_pt"],
                "elements": block["elements"],
                "element_kinds": dict(block["kind_counts"]),
            })

    layout_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    deck_groups: dict[str, list[dict]] = defaultdict(list)
    for instance in instances:
        layout = instance.get("layout_source") or ""
        layout_groups[(layout, instance["fingerprint"])].append(instance)
        deck_groups[instance["fingerprint"]].append(instance)

    chosen: dict[str, list[dict]] = {}
    for (layout, fingerprint), group in layout_groups.items():
        if len(group) < MIN_LAYOUT_INSTANCES:
            continue
        key = f"layout:{layout}:{fingerprint}"
        chosen[key] = group

    for fingerprint, group in deck_groups.items():
        if len(group) < MIN_DECK_INSTANCES:
            continue
        key = f"deck:{fingerprint}"
        if key in chosen:
            continue
        layouts = {item.get("layout_source") for item in group if item.get("layout_source")}
        if len(layouts) <= 1 and any(
            len(layout_groups.get((next(iter(layouts)), fingerprint), [])) >= MIN_LAYOUT_INSTANCES
            for _ in [0]
        ):
            continue
        chosen[key] = group

    patterns = []
    slide_pattern_map: dict[int, list[str]] = defaultdict(list)
    for index, group in enumerate(sorted(chosen.values(), key=lambda items: (-len(items), items[0]["fingerprint"])), start=1):
        pattern = _build_pattern_definition(index, group)
        if not pattern:
            continue
        patterns.append(pattern)
        for slide_number in pattern["frequency"]["slide_numbers"]:
            slide_pattern_map[slide_number].append(pattern["pattern_id"])

    for slide in slides:
        slide["pattern_ids"] = sorted(set(slide_pattern_map.get(slide["slide_number"], [])))

    patterns.sort(
        key=lambda item: (
            -item["frequency"]["instance_count"],
            -item["frequency"]["slide_count"],
            item["pattern_id"],
        )
    )
    return {
        "patterns": patterns,
        "summary": {
            "pattern_count": len(patterns),
            "instance_count": sum(item["frequency"]["instance_count"] for item in patterns),
            "layout_scoped": sum(1 for item in patterns if item["scope"] == "layout"),
            "deck_scoped": sum(1 for item in patterns if item["scope"] == "deck"),
        },
    }


def _icon_files(assets: dict | None) -> set[str]:
    icon_files: set[str] = set()
    for group in (assets or {}).get("icon_groups", []):
        icon_files.update(group.get("files", []))
    return icon_files


def _content_elements_for_clustering(content_elements: list[dict], icon_files: set[str]) -> list[dict]:
    elements = []
    for element in content_elements:
        geometry = element.get("geometry_norm") or {}
        width = geometry.get("width") or 0
        height = geometry.get("height") or 0
        area = width * height
        kind = element.get("kind") or "graphic"
        min_area = MIN_FILL_AREA if kind == "fill" else MIN_BLOCK_AREA
        if area < min_area:
            continue
        if area >= BACKGROUND_COVERAGE and kind == "image":
            continue
        if kind == "image" and element.get("asset") in icon_files:
            kind = "icon"
        elements.append({
            "element_id": element.get("element_id"),
            "shape_id": element.get("shape_id"),
            "kind": kind,
            "geometry_norm": geometry,
            "geometry_pt": element.get("geometry_pt") or {},
            "asset": element.get("asset"),
            "text": element.get("text"),
            "text_sample": element.get("text_sample") or (element.get("text") or "")[:120],
            "placeholder_type": element.get("placeholder_type"),
            "typography": element.get("typography"),
            "fill": element.get("fill"),
            "rows": element.get("rows"),
            "cols": element.get("cols"),
            "chart_type": element.get("chart_type"),
            "component": element.get("component"),
            "table": element.get("table"),
            "chart": element.get("chart"),
            "diagram": element.get("diagram"),
        })
    return elements


def _slide_size_pt(slide: dict) -> tuple[float | None, float | None]:
    size = (slide.get("render") or {}).get("slide_size_pt") or {}
    width = size.get("width")
    height = size.get("height")
    if width and height:
        return float(width), float(height)
    return None, None


def _blocks_on_slide(elements: list[dict], slide_size_pt: tuple[float | None, float | None] | None = None) -> list[dict]:
    if not elements:
        return []
    slide_width, slide_height = slide_size_pt or (None, None)
    blocks: list[dict] = []
    used_element_ids: set[str | None] = set()

    _extend_reserved_blocks(blocks, _fill_anchored_blocks(elements), used_element_ids)

    remaining = _remaining_elements(elements, used_element_ids)
    _extend_reserved_blocks(blocks, _fill_card_blocks(remaining), used_element_ids)

    remaining = _remaining_elements(elements, used_element_ids)

    if slide_width and slide_height:
        _extend_reserved_blocks(
            blocks,
            _graphic_anchored_blocks(remaining, slide_width, slide_height),
            used_element_ids,
        )
        remaining = _remaining_elements(elements, used_element_ids)

    for cluster in sorted(_cluster_elements(remaining), key=_cluster_sort_key):
        active_cluster = [
            element for element in cluster
            if element.get("element_id") not in used_element_ids
        ]
        if not active_cluster:
            continue
        block = _block_from_cluster(active_cluster)
        candidates = _expand_block_candidates(block, remaining, slide_width, slide_height)
        if len(candidates) >= 2:
            if not _try_reserve_block_group(blocks, candidates, used_element_ids):
                _try_reserve_block(blocks, block, used_element_ids)
        elif candidates:
            _try_reserve_block(blocks, candidates[0], used_element_ids)
        remaining = _remaining_elements(elements, used_element_ids)

    return _dedupe_blocks_by_element_ids(blocks)


def _remaining_elements(elements: list[dict], used_element_ids: set[str | None]) -> list[dict]:
    return [
        element for element in elements
        if element.get("element_id") not in used_element_ids
    ]


def _cluster_sort_key(cluster: list[dict]) -> tuple[float, float]:
    return (
        min(item["geometry_norm"]["y"] for item in cluster),
        min(item["geometry_norm"]["x"] for item in cluster),
    )


def _element_ids_in_block(block: dict) -> set[str | None]:
    return {
        element.get("element_id")
        for element in block.get("elements") or []
        if element.get("element_id") is not None
    }


def _block_passes_filters(block: dict) -> bool:
    return bool(_filter_block_candidates([block]))


def _try_reserve_block(
    blocks: list[dict],
    candidate: dict,
    used_element_ids: set[str | None],
) -> bool:
    if not _block_passes_filters(candidate):
        return False
    block_ids = _element_ids_in_block(candidate)
    if not block_ids or block_ids & used_element_ids:
        return False
    blocks.append(candidate)
    used_element_ids.update(block_ids)
    return True


def _try_reserve_block_group(
    blocks: list[dict],
    candidates: list[dict],
    used_element_ids: set[str | None],
) -> bool:
    pending: list[dict] = []
    pending_ids: set[str | None] = set()
    for candidate in candidates:
        if not _block_passes_filters(candidate):
            return False
        block_ids = _element_ids_in_block(candidate)
        if not block_ids or block_ids & used_element_ids or block_ids & pending_ids:
            return False
        pending.append(candidate)
        pending_ids.update(block_ids)
    blocks.extend(pending)
    used_element_ids.update(pending_ids)
    return True


def _extend_reserved_blocks(
    blocks: list[dict],
    candidates: list[dict],
    used_element_ids: set[str | None],
) -> None:
    for candidate in sorted(candidates, key=lambda item: (item["bbox_norm"]["y"], item["bbox_norm"]["x"])):
        _try_reserve_block(blocks, candidate, used_element_ids)


def _dedupe_blocks_by_element_ids(blocks: list[dict]) -> list[dict]:
    seen: set[tuple[str | None, ...]] = set()
    kept: list[dict] = []
    for block in blocks:
        key = tuple(sorted(_element_ids_in_block(block)))
        if not key or key in seen:
            continue
        seen.add(key)
        kept.append(block)
    return kept


def _element_ids_in_block_list(blocks: list[dict]) -> set[str | None]:
    return {
        element.get("element_id")
        for block in blocks
        for element in block.get("elements") or []
        if element.get("element_id") is not None
    }


def _filter_block_candidates(blocks: list[dict]) -> list[dict]:
    filtered = []
    for block in blocks:
        child_count = len(block["elements"])
        if child_count > MAX_BLOCK_CHILDREN:
            continue
        if child_count > 1 and child_count < MIN_BLOCK_CHILDREN:
            continue
        area = block["bbox_norm"]["width"] * block["bbox_norm"]["height"]
        if area < MIN_BLOCK_AREA or area > MAX_BLOCK_AREA:
            continue
        if child_count == 1 and area < 0.002:
            continue
        filtered.append(block)
    return filtered


def _expand_block_candidates(
    block: dict,
    all_elements: list[dict],
    slide_width: float | None,
    slide_height: float | None,
) -> list[dict]:
    split_blocks = _split_row_block(block)
    if len(split_blocks) >= 2:
        return split_blocks

    expanded = _expand_cluster_with_graphics(block, all_elements, slide_width, slide_height)
    return [expanded]


def _expand_cluster_with_graphics(
    block: dict,
    all_elements: list[dict],
    slide_width: float | None,
    slide_height: float | None,
) -> dict:
    if not slide_width or not slide_height:
        return block

    children = list(block["elements"])
    seen = {item.get("element_id") for item in children if item.get("element_id")}
    text_blocks = [item for item in children if item["kind"] == "text"]
    anchor = text_blocks[0] if text_blocks else children[0]
    has_fill = any(item.get("kind") == "fill" for item in children)

    for element in all_elements:
        if element in children:
            continue
        element_id = element.get("element_id")
        if element_id is not None and element_id in seen:
            continue
        if element["kind"] not in GRAPHIC_KINDS:
            continue
        if element["kind"] == "fill" and has_fill:
            continue
        if element["kind"] == "fill":
            belongs = _fill_belongs_to_container(element, anchor)
        else:
            belongs = _graphic_belongs_to_container(element, anchor, slide_width, slide_height)
        if belongs:
            children.append(element)
            if element_id is not None:
                seen.add(element_id)

    return _block_from_cluster(children)


def _split_row_block(block: dict) -> list[dict]:
    icons = [item for item in block["elements"] if item["kind"] in {"icon", "image"}]
    texts = [item for item in block["elements"] if item["kind"] == "text"]
    if len(icons) < MIN_ROW_ICONS or not texts:
        return [block]

    columns: list[dict] = []
    used_text_ids: set[str | None] = set()
    for icon in sorted(icons, key=lambda item: _element_center(item)[0]):
        members = [icon]
        icon_left, icon_top = icon["geometry_norm"]["x"], icon["geometry_norm"]["y"]
        icon_right = icon_left + icon["geometry_norm"]["width"]
        icon_bottom = icon_top + icon["geometry_norm"]["height"]
        margin = icon["geometry_norm"]["width"] * ICON_HORIZONTAL_MARGIN_RATIO

        for text in texts:
            text_id = text.get("element_id")
            if text_id in used_text_ids:
                continue
            text_center_x = _element_center(text)[0]
            if text_center_x < icon_left - margin or text_center_x > icon_right + margin:
                continue
            text_top = text["geometry_norm"]["y"]
            if text_top + 0.01 < icon_top:
                continue
            if text_top - icon_bottom > ICON_TEXT_MAX_VERTICAL_GAP_RATIO:
                continue
            members.append(text)
            used_text_ids.add(text_id)

        if len(members) >= MIN_BLOCK_CHILDREN:
            columns.append(_block_from_cluster(members))

    if len(columns) < MIN_ROW_ICONS:
        return [block]
    return columns


def _graphic_anchored_blocks(
    elements: list[dict],
    slide_width: float,
    slide_height: float,
) -> list[dict]:
    graphics = [element for element in elements if element["kind"] in GRAPHIC_KINDS and element["kind"] != "fill"]
    texts = [element for element in elements if element["kind"] == "text"]
    if not graphics or not texts:
        return []

    blocks = []
    used_text_ids: set[str | None] = set()
    for graphic in sorted(graphics, key=lambda item: (_element_center(item)[1], _element_center(item)[0])):
        available_texts = [
            text for text in texts
            if text.get("element_id") not in used_text_ids
        ]
        members = [graphic]
        for text in available_texts:
            if _icon_text_connected(text, graphic, slide_width, slide_height):
                members.append(text)
        members = _attach_stacked_text(members, available_texts, slide_height)
        if len(members) < MIN_BLOCK_CHILDREN:
            continue
        for text in members:
            if text.get("kind") == "text":
                used_text_ids.add(text.get("element_id"))
        blocks.append(_block_from_cluster(members))
    return blocks


def _fill_anchored_blocks(elements: list[dict]) -> list[dict]:
    fills = [element for element in elements if element["kind"] == "fill"]
    texts = [element for element in elements if element["kind"] == "text"]
    if not fills or not texts:
        return []

    used_text_ids: set[str | None] = set()
    blocks = []
    for fill in sorted(fills, key=lambda item: (_element_center(item)[1], _element_center(item)[0])):
        label = _find_fill_label(fill, texts, used_text_ids)
        if label is None:
            continue
        description = _find_step_description(label, texts, used_text_ids)
        if description is None:
            continue
        used_text_ids.add(label.get("element_id"))
        used_text_ids.add(description.get("element_id"))
        blocks.append(_block_from_cluster([fill, label, description]))
    return blocks


def _fill_card_blocks(elements: list[dict]) -> list[dict]:
    fills = [element for element in elements if element["kind"] == "fill"]
    texts = [element for element in elements if element["kind"] == "text"]
    if not fills or not texts:
        return []

    used_text_ids: set[str | None] = set()
    blocks = []
    for fill in sorted(fills, key=lambda item: (_element_center(item)[1], _element_center(item)[0])):
        members = [fill]
        for text in texts:
            text_id = text.get("element_id")
            if text_id in used_text_ids:
                continue
            if _text_belongs_to_fill_card(text, fill):
                members.append(text)
        if len(members) < MIN_BLOCK_CHILDREN:
            continue
        for member in members:
            if member.get("kind") == "text":
                used_text_ids.add(member.get("element_id"))
        blocks.append(_block_from_cluster(members))
    return blocks


def _text_belongs_to_fill_card(text: dict, fill: dict) -> bool:
    text_box = text["geometry_norm"]
    fill_box = fill["geometry_norm"]
    sample = text.get("text_sample") or text.get("text") or ""
    if is_step_label(sample, text.get("typography")):
        return False
    if _overlap_ratio(text_box, fill_box) >= FILL_CARD_TEXT_OVERLAP_MIN:
        return True
    if _center_inside_norm(text, fill):
        return True
    return False


def _find_fill_label(fill: dict, texts: list[dict], used_text_ids: set[str | None]) -> dict | None:
    fill_bottom = fill["geometry_norm"]["y"] + fill["geometry_norm"]["height"]
    candidates = []
    for text in texts:
        text_id = text.get("element_id")
        if text_id in used_text_ids:
            continue
        if not _columns_align(fill, text):
            continue
        sample = text.get("text_sample") or text.get("text") or ""
        if not is_step_label(sample, text.get("typography")):
            continue
        gap = text["geometry_norm"]["y"] - fill_bottom
        if gap < -0.03 or gap > FILL_LABEL_MAX_GAP_NORM:
            continue
        candidates.append(text)
    if not candidates:
        return None
    return min(candidates, key=lambda item: item["geometry_norm"]["y"])


def _find_step_description(label: dict, texts: list[dict], used_text_ids: set[str | None]) -> dict | None:
    label_bottom = label["geometry_norm"]["y"] + label["geometry_norm"]["height"]
    best = None
    best_gap = float("inf")
    for text in texts:
        text_id = text.get("element_id")
        if text_id in used_text_ids or text is label:
            continue
        if is_step_label(text.get("text_sample") or text.get("text") or "", text.get("typography")):
            continue
        if not _columns_align(label, text):
            continue
        gap = text["geometry_norm"]["y"] - label_bottom
        if gap < -0.02 or gap > FILL_DESCRIPTION_MAX_GAP_NORM:
            continue
        if gap < best_gap:
            best = text
            best_gap = gap
    return best


def _fill_belongs_to_container(fill: dict, anchor: dict) -> bool:
    if anchor.get("kind") != "text":
        return False
    if not _columns_align(fill, anchor):
        return False
    fill_bottom = fill["geometry_norm"]["y"] + fill["geometry_norm"]["height"]
    anchor_top = anchor["geometry_norm"]["y"]
    return fill_bottom <= anchor_top + 0.04


def _columns_align(upper: dict, lower: dict, min_overlap_ratio: float = 0.18) -> bool:
    upper_geom = upper["geometry_norm"]
    lower_geom = lower["geometry_norm"]
    overlap = min(upper_geom["x"] + upper_geom["width"], lower_geom["x"] + lower_geom["width"]) - max(
        upper_geom["x"],
        lower_geom["x"],
    )
    if overlap <= 0:
        return False
    reference = min(upper_geom["width"], lower_geom["width"])
    return overlap / max(reference, 1e-9) >= min_overlap_ratio


def _attach_stacked_text(members: list[dict], texts: list[dict], slide_height: float) -> list[dict]:
    result = list(members)
    seen = {item.get("element_id") for item in result if item.get("element_id")}
    icons = [item for item in result if item["kind"] in {"icon", "image"}]
    anchor_texts = [item for item in result if item["kind"] == "text"]
    if not anchor_texts:
        return result

    anchor = min(anchor_texts, key=lambda item: item["geometry_norm"]["y"])
    if icons:
        icon = min(icons, key=lambda item: item["geometry_norm"]["y"])
        column_left = icon["geometry_norm"]["x"] - icon["geometry_norm"]["width"] * ICON_HORIZONTAL_MARGIN_RATIO
        column_right = icon["geometry_norm"]["x"] + icon["geometry_norm"]["width"] * (1 + ICON_HORIZONTAL_MARGIN_RATIO)
    else:
        column_left = anchor["geometry_norm"]["x"] - anchor["geometry_norm"]["width"] * 0.15
        column_right = anchor["geometry_norm"]["x"] + anchor["geometry_norm"]["width"] * 1.15
    anchor_bottom = max(
        item["geometry_norm"]["y"] + item["geometry_norm"]["height"]
        for item in anchor_texts
    )
    max_gap = ICON_TEXT_MAX_VERTICAL_GAP_RATIO

    for text in sorted(texts, key=lambda item: item["geometry_norm"]["y"]):
        element_id = text.get("element_id")
        if element_id is not None and element_id in seen:
            continue
        text_center = _element_center(text)[0]
        if text_center < column_left or text_center > column_right:
            continue
        if text["geometry_norm"]["y"] < anchor["geometry_norm"]["y"] - 0.01:
            continue
        if text["geometry_norm"]["y"] - anchor_bottom > max_gap:
            continue
        result.append(text)
        if element_id is not None:
            seen.add(element_id)
        anchor_bottom = max(anchor_bottom, text["geometry_norm"]["y"] + text["geometry_norm"]["height"])
    return result


def _icon_text_connected(text: dict, graphic: dict, slide_width: float, slide_height: float) -> bool:
    text_box = text["geometry_norm"]
    graphic_box = graphic["geometry_norm"]
    graphic_left = graphic_box["x"]
    graphic_right = graphic_box["x"] + graphic_box["width"]
    margin = graphic_box["width"] * ICON_HORIZONTAL_MARGIN_RATIO
    text_center_x = text_box["x"] + text_box["width"] / 2
    if text_center_x < graphic_left - margin or text_center_x > graphic_right + margin:
        return False

    text_top = text_box["y"]
    text_bottom = text_top + text_box["height"]
    graphic_top = graphic_box["y"]
    graphic_bottom = graphic_top + graphic_box["height"]
    max_gap = ICON_TEXT_MAX_VERTICAL_GAP_RATIO

    if text_top + 0.01 < graphic_top:
        return False

    if text_top >= graphic_bottom - 0.02 and text_top - graphic_bottom <= max_gap:
        return True
    return _overlap_ratio(text_box, graphic_box) > 0.02


def _graphic_belongs_to_container(
    graphic: dict,
    anchor: dict,
    slide_width: float,
    slide_height: float,
) -> bool:
    if _center_inside_norm(graphic, anchor):
        return True
    return _icon_text_connected(anchor, graphic, slide_width, slide_height)


def _center_inside_norm(inner: dict, outer: dict) -> bool:
    inner_cx, inner_cy = _element_center(inner)
    outer_box = outer["geometry_norm"]
    return (
        outer_box["x"] <= inner_cx <= outer_box["x"] + outer_box["width"]
        and outer_box["y"] <= inner_cy <= outer_box["y"] + outer_box["height"]
    )


def _element_center(element: dict) -> tuple[float, float]:
    geometry = element["geometry_norm"]
    return (
        geometry["x"] + geometry["width"] / 2,
        geometry["y"] + geometry["height"] / 2,
    )


def _overlap_ratio(first: dict, second: dict) -> float:
    left = max(first["x"], second["x"])
    top = max(first["y"], second["y"])
    right = min(first["x"] + first["width"], second["x"] + second["width"])
    bottom = min(first["y"] + first["height"], second["y"] + second["height"])
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    first_area = first["width"] * first["height"]
    second_area = second["width"] * second["height"]
    denominator = min(first_area, second_area)
    return intersection / denominator if denominator else 0.0


def _dedupe_blocks(blocks: list[dict]) -> list[dict]:
    if len(blocks) <= 1:
        return blocks

    ordered = sorted(
        blocks,
        key=lambda item: (
            0 if any(element.get("kind") == "fill" for element in item["elements"]) else 1,
            item["bbox_norm"]["width"] * item["bbox_norm"]["height"],
        ),
    )
    kept: list[dict] = []
    for block in ordered:
        if any(_block_contains(existing, block) for existing in kept):
            continue
        kept = [existing for existing in kept if not _block_contains(block, existing)]
        kept.append(block)
    return kept


def _block_contains(outer: dict, inner: dict) -> bool:
    outer_box = outer["bbox_norm"]
    inner_box = inner["bbox_norm"]
    inner_cx = inner_box["x"] + inner_box["width"] / 2
    inner_cy = inner_box["y"] + inner_box["height"] / 2
    if not (
        outer_box["x"] <= inner_cx <= outer_box["x"] + outer_box["width"]
        and outer_box["y"] <= inner_cy <= outer_box["y"] + outer_box["height"]
    ):
        return False
    outer_area = outer_box["width"] * outer_box["height"]
    inner_area = inner_box["width"] * inner_box["height"]
    if inner_area <= 0:
        return False
    return outer_area > inner_area * 1.2


def _blocks_overlap(left: dict, right: dict) -> bool:
    return _overlap_ratio(left["bbox_norm"], right["bbox_norm"]) >= 0.55


def _cluster_elements(elements: list[dict]) -> list[list[dict]]:
    if len(elements) == 1:
        return [elements]

    gap = CLUSTER_GAP_RATIO
    parent = list(range(len(elements)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    for left in range(len(elements)):
        for right in range(left + 1, len(elements)):
            if _boxes_near(elements[left]["geometry_norm"], elements[right]["geometry_norm"], gap):
                union(left, right)

    grouped: dict[int, list[dict]] = defaultdict(list)
    for index, element in enumerate(elements):
        grouped[find(index)].append(element)
    return list(grouped.values())


def _boxes_near(left: dict, right: dict, gap: float) -> bool:
    if _overlap(left, right):
        return True
    horizontal_gap = max(0.0, max(left["x"], right["x"]) - min(left["x"] + left["width"], right["x"] + right["width"]))
    vertical_gap = max(0.0, max(left["y"], right["y"]) - min(left["y"] + left["height"], right["y"] + right["height"]))
    min_side = min(left["width"], left["height"], right["width"], right["height"])
    threshold = max(gap, min_side * 0.35)
    return horizontal_gap <= threshold and vertical_gap <= threshold


def _overlap(left: dict, right: dict) -> bool:
    return not (
        left["x"] + left["width"] <= right["x"]
        or right["x"] + right["width"] <= left["x"]
        or left["y"] + left["height"] <= right["y"]
        or right["y"] + right["height"] <= left["y"]
    )


def _block_from_cluster(cluster: list[dict]) -> dict:
    xs = [item["geometry_norm"]["x"] for item in cluster]
    ys = [item["geometry_norm"]["y"] for item in cluster]
    xe = [item["geometry_norm"]["x"] + item["geometry_norm"]["width"] for item in cluster]
    ye = [item["geometry_norm"]["y"] + item["geometry_norm"]["height"] for item in cluster]
    bbox_norm = {
        "x": min(xs),
        "y": min(ys),
        "width": max(xe) - min(xs),
        "height": max(ye) - min(ys),
    }
    pts = [item.get("geometry_pt") or {} for item in cluster]
    pt_x = [item.get("x_pt", 0) for item in pts if item.get("x_pt") is not None]
    pt_y = [item.get("y_pt", 0) for item in pts if item.get("y_pt") is not None]
    pt_xe = [item.get("x_pt", 0) + item.get("width_pt", 0) for item in pts if item.get("width_pt")]
    pt_ye = [item.get("y_pt", 0) + item.get("height_pt", 0) for item in pts if item.get("height_pt")]
    bbox_pt = {
        "x_pt": round(min(pt_x), 2) if pt_x else None,
        "y_pt": round(min(pt_y), 2) if pt_y else None,
        "width_pt": round(max(pt_xe) - min(pt_x), 2) if pt_x and pt_xe else None,
        "height_pt": round(max(pt_ye) - min(pt_y), 2) if pt_y and pt_ye else None,
    }
    return {
        "bbox_norm": bbox_norm,
        "bbox_pt": bbox_pt,
        "elements": cluster,
        "kind_counts": Counter(item["kind"] for item in cluster),
    }


def _quantize(value: float, grid: int = POSITION_GRID) -> float:
    return round(value * grid) / grid


def _structure_fingerprint(block: dict) -> str:
    kind_counts = block["kind_counts"]
    kind_sig = ",".join(f"{kind}:{kind_counts[kind]}" for kind in sorted(kind_counts))
    bbox = block["bbox_norm"]
    slots = []
    for element in sorted(block["elements"], key=lambda item: (item["geometry_norm"]["y"], item["geometry_norm"]["x"])):
        geometry = element["geometry_norm"]
        cx = geometry["x"] + geometry["width"] / 2
        cy = geometry["y"] + geometry["height"] / 2
        rel_cx = (cx - bbox["x"]) / bbox["width"] if bbox["width"] else cx
        rel_cy = (cy - bbox["y"]) / bbox["height"] if bbox["height"] else cy
        rel_w = geometry["width"] / bbox["width"] if bbox["width"] else geometry["width"]
        rel_h = geometry["height"] / bbox["height"] if bbox["height"] else geometry["height"]
        slots.append(
            f"{element['kind']}@{_quantize(rel_cx)}:{_quantize(rel_cy)}:{_quantize(rel_w)}:{_quantize(rel_h)}"
        )
    return f"{kind_sig}|{'+'.join(slots)}"


def _position_fingerprint(block: dict) -> str:
    bbox = block["bbox_norm"]
    return (
        f"{_quantize(bbox['x'])}:{_quantize(bbox['y'])}:"
        f"{_quantize(bbox['width'])}x{_quantize(bbox['height'])}"
    )


def _block_fingerprint(block: dict) -> str:
    return f"{_structure_fingerprint(block)}@{_position_fingerprint(block)}"


def _build_pattern_definition(index: int, instances: list[dict]) -> dict | None:
    if not instances:
        return None

    layouts = Counter(item.get("layout_source") or "" for item in instances)
    primary_layout = layouts.most_common(1)[0][0]
    scope = "layout"
    if len(layouts) > 1 and len(instances) >= MIN_DECK_INSTANCES:
        scope = "deck"
    elif not primary_layout:
        scope = "deck"

    slot_clusters = _cluster_slots(instances)
    required = []
    optional = []
    for cluster in slot_clusters:
        presence = cluster["presence_count"] / len(instances)
        slot_def = {
            "slot_id": cluster["slot_id"],
            "role": cluster["role"],
            "kind": cluster["kind"],
            "presence_ratio": round(presence, 3),
            "position": {
                "cx_norm": cluster["cx_norm"],
                "cy_norm": cluster["cy_norm"],
                "width_norm": cluster["width_norm"],
                "height_norm": cluster["height_norm"],
            },
            "typography": cluster.get("typography"),
            "defaults": cluster.get("defaults") or {},
        }
        if presence >= 0.75:
            required.append(slot_def)
        elif presence >= 0.25:
            optional.append(slot_def)

    if not required and not optional:
        return None

    widths = [item["container_pt"].get("width_pt") or 0 for item in instances if item["container_pt"].get("width_pt")]
    heights = [item["container_pt"].get("height_pt") or 0 for item in instances if item["container_pt"].get("height_pt")]
    kind_totals = Counter()
    for instance in instances:
        kind_totals.update(instance.get("element_kinds") or {})

    name = _pattern_name(kind_totals, len(required) + len(optional))
    slide_numbers = sorted({item["slide_number"] for item in instances})
    layout_names = sorted({item.get("layout_name") for item in instances if item.get("layout_name")})

    return {
        "pattern_id": f"pat_{index:03d}",
        "name": name,
        "label": name,
        "scope": scope,
        "fingerprint": instances[0]["fingerprint"],
        "layout_source": primary_layout or None,
        "layout_name": layout_names[0] if len(layout_names) == 1 else None,
        "layout_sources": sorted(layout for layout in layouts if layout),
        "template_ids": sorted({item.get("template_id") for item in instances if item.get("template_id")}),
        "container": {
            "width_pt": round(median(widths), 2) if widths else None,
            "height_pt": round(median(heights), 2) if heights else None,
            "width_norm": round(median([item["container"]["width"] for item in instances]), 4),
            "height_norm": round(median([item["container"]["height"] for item in instances]), 4),
        },
        "slots": {
            "required": sorted(required, key=lambda item: (item["position"]["cy_norm"], item["position"]["cx_norm"])),
            "optional": sorted(optional, key=lambda item: (-item["presence_ratio"], item["position"]["cy_norm"])),
        },
        "element_kinds": dict(kind_totals),
        "frequency": {
            "instance_count": len(instances),
            "slide_count": len(slide_numbers),
            "slide_numbers": slide_numbers,
        },
        "instances": [
            {
                "slide_number": item["slide_number"],
                "layout_source": item.get("layout_source"),
                "layout_name": item.get("layout_name"),
                "template_id": item.get("template_id"),
                "block_index": item.get("block_index"),
                "container": item["container"],
                "element_kinds": item.get("element_kinds"),
                "elements": [
                    {
                        "element_id": element.get("element_id"),
                        "kind": element.get("kind"),
                        "geometry_norm": element.get("geometry_norm"),
                        "asset": element.get("asset"),
                        "text_sample": element.get("text_sample"),
                    }
                    for element in item.get("elements") or []
                ],
            }
            for item in instances
        ],
    }


def _cluster_slots(instances: list[dict]) -> list[dict]:
    buckets: dict[tuple, dict] = {}
    for instance in instances:
        container = instance["container"]
        for element in instance.get("elements") or []:
            geometry = element.get("geometry_norm") or {}
            cx = geometry.get("x", 0) + geometry.get("width", 0) / 2
            cy = geometry.get("y", 0) + geometry.get("height", 0) / 2
            rel_cx = (cx - container["x"]) / container["width"] if container.get("width") else 0.5
            rel_cy = (cy - container["y"]) / container["height"] if container.get("height") else 0.5
            rel_w = geometry.get("width", 0) / container["width"] if container.get("width") else geometry.get("width", 0)
            rel_h = geometry.get("height", 0) / container["height"] if container.get("height") else geometry.get("height", 0)
            key = (
                element.get("kind"),
                _quantize(rel_cx),
                _quantize(rel_cy),
                _quantize(rel_w),
                _quantize(rel_h),
            )
            bucket = buckets.setdefault(key, {
                "slot_id": f"slot_{len(buckets) + 1:02d}",
                "kind": element.get("kind"),
                "role": _slot_role(element),
                "presence_count": 0,
                "cx_values": [],
                "cy_values": [],
                "width_values": [],
                "height_values": [],
                "typography": None,
                "assets": Counter(),
                "texts": Counter(),
            })
            bucket["presence_count"] += 1
            bucket["cx_values"].append(rel_cx)
            bucket["cy_values"].append(rel_cy)
            bucket["width_values"].append(rel_w)
            bucket["height_values"].append(rel_h)
            if element.get("asset"):
                bucket["assets"][element["asset"]] += 1
            text_sample = element.get("text_sample") or element.get("text")
            if text_sample:
                bucket["texts"][text_sample.strip()] += 1
            if element.get("typography") and bucket["typography"] is None:
                bucket["typography"] = {
                    "dominant_family": element["typography"].get("family"),
                    "dominant_size_pt": element["typography"].get("size_pt"),
                }

    clusters = []
    for bucket in buckets.values():
        defaults = {}
        if bucket["assets"]:
            defaults["asset"] = bucket["assets"].most_common(1)[0][0]
        if bucket["texts"]:
            defaults["text"] = bucket["texts"].most_common(1)[0][0]
        clusters.append({
            "slot_id": bucket["slot_id"],
            "kind": bucket["kind"],
            "role": bucket["role"],
            "presence_count": bucket["presence_count"],
            "cx_norm": round(median(bucket["cx_values"]), 4),
            "cy_norm": round(median(bucket["cy_values"]), 4),
            "width_norm": round(median(bucket["width_values"]), 4),
            "height_norm": round(median(bucket["height_values"]), 4),
            "typography": bucket["typography"],
            "defaults": defaults,
        })
    return clusters


def _slot_role(element: dict) -> str:
    kind = element.get("kind")
    if kind == "text":
        placeholder = element.get("placeholder_type")
        if element.get("metric"):
            return "metric"
        if placeholder in {"title", "ctrTitle"}:
            return "title"
        if placeholder == "subTitle":
            return "subtitle"
        if placeholder == "body":
            return "body"
        return "description"
    if kind in {"icon", "image"}:
        return "image"
    if kind == "fill":
        return "marker"
    if kind == "table":
        return "table"
    if kind == "chart":
        return "chart"
    if kind == "diagram":
        return "diagram"
    return kind or "content"


def _pattern_name(kind_counts: Counter, slot_count: int) -> str:
    if kind_counts.get("table"):
        return "TABLE"
    if kind_counts.get("chart"):
        return "CHART"
    if kind_counts.get("diagram"):
        return "DIAGRAM"
    icons = kind_counts.get("icon", 0)
    images = kind_counts.get("image", 0)
    texts = kind_counts.get("text", 0)
    if icons >= 2 and texts >= 2:
        return "ICON_ROW"
    if kind_counts.get("fill") and texts >= 2:
        return "TIMELINE_STEP"
    if (icons or images) >= 1 and texts >= 1:
        return "MEDIA_CARD"
    if texts >= 2:
        return "TEXT_BLOCK"
    if icons or images:
        return "IMAGE_BLOCK"
    if kind_counts.get("fill"):
        return "SHAPE_BLOCK"
    if slot_count == 1:
        first_kind = next(iter(kind_counts))
        return f"{first_kind.upper()}_BLOCK" if first_kind else "BLOCK"
    return "BLOCK"
