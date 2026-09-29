"""Detect spatial design rules from slide element placement."""

import re
from collections import Counter, defaultdict
from statistics import median

TITLE_PLACEHOLDER_TYPES = {"title", "ctrTitle"}
BODY_PLACEHOLDER_TYPES = {"body", "obj", "subTitle"}
TITLE_SCALE_PROB_THRESHOLD = 0.25
BODY_SCALE_PROB_THRESHOLD = 0.25
TOP_ZONE_RATIO = 0.35
SAFE_FREE_RATIO = 0.75
IMAGE_MAX_COVERAGE = 0.85
HEATMAP_COLS = 48
MIN_GROUP_ITEMS = 2
MIN_ELEMENT_AREA_RATIO = 0.003
SIZE_TOLERANCE = 0.07
ALIGN_TOLERANCE = 0.035


def analyze_spatial_rules(
    text_blocks: list[dict],
    scale_roles: list[dict],
    slide_size: tuple[float, float] | None,
    text_slots: dict | None = None,
    assets: dict | None = None,
) -> dict:
    slide_width, slide_height = slide_size or (None, None)
    total_slides = _total_slide_count(text_blocks, assets)
    title_levels = _title_scale_levels(scale_roles)
    title_slots_by_slide = _title_slots_by_slide(text_slots)
    title_typography = _title_slot_typography(text_slots)

    instances = _detect_slide_titles(
        text_blocks,
        title_levels,
        title_slots_by_slide,
        slide_width,
        slide_height,
    )

    components = []
    if instances or title_slots_by_slide or title_typography:
        components.append(_build_component(
            component_id="slide_title",
            label="Заголовок слайда",
            instances=instances,
            slide_width=slide_width,
            slide_height=slide_height,
            total_slides=total_slides,
            typography=title_typography,
            detection={
                "title_scale_levels": title_levels,
                "title_placeholder_slides": len(title_slots_by_slide),
                "methods": ["placeholder_shape", "placeholder_geometry", "scale_role", "spatial_fallback"],
            },
        ))

    text_instances = _detect_text_regions(
        text_blocks,
        scale_roles,
        text_slots,
        instances,
        slide_width,
        slide_height,
    )
    if text_instances:
        components.append(_build_component(
            component_id="text_regions",
            label="Text regions",
            instances=text_instances,
            slide_width=slide_width,
            slide_height=slide_height,
            total_slides=total_slides,
            typography=_body_slot_typography(text_slots),
            detection={
                "body_scale_levels": _body_scale_levels(scale_roles),
                "methods": ["body_placeholder", "body_scale", "paragraph_heuristic"],
            },
        ))

    image_instances = _extract_image_instances(assets, slide_width, slide_height)
    if image_instances:
        components.append(_build_component(
            component_id="image_regions",
            label="Image regions",
            instances=image_instances,
            slide_width=slide_width,
            slide_height=slide_height,
            total_slides=total_slides,
            typography={},
            detection={"methods": ["slide_picture"]},
            media=_image_media_stats(image_instances),
        ))

    safe_heatmap, safe_instances = _compute_safe_space(
        text_blocks,
        image_instances,
        assets,
        slide_width,
        slide_height,
        total_slides,
    )
    if safe_heatmap:
        free_values = [value for row in safe_heatmap["free_ratios"] for value in row]
        safe_component = _build_component(
            component_id="safe_space",
            label="Safe / empty space",
            instances=safe_instances,
            slide_width=slide_width,
            slide_height=slide_height,
            total_slides=total_slides,
            typography={},
            detection={
                "free_ratio_threshold": SAFE_FREE_RATIO,
                "methods": ["content_occupancy_inverse"],
                "content_sources": ["text", "icons", "small_images"],
                "excludes": ["background_images", "large_pictures"],
            },
            extra={
                "avg_free_ratio": round(sum(free_values) / len(free_values), 3) if free_values else 0.0,
                "median_free_ratio": round(median(free_values), 3) if free_values else 0.0,
            },
        )
        safe_component["heatmap"] = safe_heatmap
        components.append(safe_component)

    group_patterns, group_instances = _detect_repeated_groups(
        text_blocks,
        image_instances,
        slide_width,
        slide_height,
    )
    if group_patterns:
        layout_counts = Counter(group["layout"] for group in group_patterns)
        components.append(_build_component(
            component_id="repeated_groups",
            label="Repeated groups",
            instances=group_instances,
            slide_width=slide_width,
            slide_height=slide_height,
            total_slides=total_slides,
            typography={},
            detection={
                "methods": ["size_alignment", "row_column_grid"],
                "layout_counts": dict(layout_counts),
            },
            groups=group_patterns,
            extra={"pattern_count": len(group_patterns)},
        ))

    return {
        "slide_size_pt": {
            "width": slide_width,
            "height": slide_height,
        } if slide_width and slide_height else None,
        "components": components,
    }


def _total_slide_count(text_blocks: list[dict], assets: dict | None) -> int:
    slides = {block["slide_number"] for block in text_blocks}
    for asset in (assets or {}).get("media_files", []):
        slides.update(asset.get("slide_numbers", []))
    return len(slides)


def _title_scale_levels(scale_roles: list[dict]) -> list[dict]:
    levels = []
    for group in scale_roles:
        family = group["family"]
        for level in group.get("levels", []):
            hint = level.get("role_hint")
            title_prob = level.get("slide_title_probability") or 0
            if hint == "slide_title" or title_prob >= TITLE_SCALE_PROB_THRESHOLD:
                levels.append({
                    "family": family,
                    "scale_level": level["scale_level"],
                    "size_pt": level.get("size_pt"),
                    "slide_title_probability": title_prob,
                    "role_hint": hint,
                })
    return sorted(levels, key=lambda item: (-item["slide_title_probability"], item["family"], item["scale_level"]))


def _title_slots_by_slide(text_slots: dict | None) -> dict[int, list[dict]]:
    if not text_slots:
        return {}
    by_slide = defaultdict(list)
    for slot in text_slots.get("slide_instances", []):
        if slot.get("placeholder_type") not in TITLE_PLACEHOLDER_TYPES:
            continue
        slide_match = re.search(r"slide(\d+)\.xml$", slot.get("source", ""))
        if slide_match is None:
            continue
        geometry = slot.get("geometry")
        if not geometry:
            continue
        by_slide[int(slide_match.group(1))].append(slot)
    return dict(by_slide)


def _title_slot_typography(text_slots: dict | None) -> dict:
    zones = []
    for slot in (text_slots or {}).get("templates", []):
        if slot.get("placeholder_type") not in TITLE_PLACEHOLDER_TYPES:
            continue
        geometry = slot.get("geometry")
        if not geometry:
            continue
        zones.append({
            "family": (slot.get("levels") or [{}])[0].get("family"),
            "size_pt": (slot.get("levels") or [{}])[0].get("size_pt"),
        })
    families = Counter(zone["family"] for zone in zones if zone.get("family"))
    sizes = Counter(zone["size_pt"] for zone in zones if zone.get("size_pt") is not None)
    dominant_family = families.most_common(1)[0][0] if families else None
    dominant_size = sizes.most_common(1)[0][0] if sizes else None
    return {
        "dominant_family": dominant_family,
        "dominant_size_pt": dominant_size,
        "families": [{"family": family, "count": count} for family, count in families.most_common()],
        "sizes_pt": [{"size_pt": size, "count": count} for size, count in sizes.most_common()],
    }


def _body_scale_levels(scale_roles: list[dict]) -> list[dict]:
    levels = []
    for group in scale_roles:
        family = group["family"]
        inferred_body = group.get("inferred_body_level")
        for level in group.get("levels", []):
            hint = level.get("role_hint")
            body_prob = level.get("body_probability") or 0
            if hint == "body" or body_prob >= BODY_SCALE_PROB_THRESHOLD or level["scale_level"] == inferred_body:
                levels.append({
                    "family": family,
                    "scale_level": level["scale_level"],
                    "size_pt": level.get("size_pt"),
                    "body_probability": body_prob,
                    "role_hint": hint,
                })
    return sorted(levels, key=lambda item: (-item["body_probability"], item["family"], item["scale_level"]))


def _body_slots_by_slide(text_slots: dict | None) -> dict[int, list[dict]]:
    if not text_slots:
        return {}
    by_slide = defaultdict(list)
    for slot in text_slots.get("slide_instances", []):
        if slot.get("placeholder_type") not in BODY_PLACEHOLDER_TYPES:
            continue
        slide_match = re.search(r"slide(\d+)\.xml$", slot.get("source", ""))
        if slide_match is None:
            continue
        geometry = slot.get("geometry")
        if not geometry:
            continue
        by_slide[int(slide_match.group(1))].append(slot)
    return dict(by_slide)


def _body_slot_typography(text_slots: dict | None) -> dict:
    zones = []
    for slot in (text_slots or {}).get("templates", []):
        if slot.get("placeholder_type") not in BODY_PLACEHOLDER_TYPES:
            continue
        geometry = slot.get("geometry")
        if not geometry:
            continue
        first_level = (slot.get("levels") or [{}])[0]
        zones.append({
            "family": first_level.get("family"),
            "size_pt": first_level.get("size_pt"),
        })
    families = Counter(zone["family"] for zone in zones if zone.get("family"))
    sizes = Counter(zone["size_pt"] for zone in zones if zone.get("size_pt") is not None)
    return {
        "dominant_family": families.most_common(1)[0][0] if families else None,
        "dominant_size_pt": sizes.most_common(1)[0][0] if sizes else None,
        "families": [{"family": family, "count": count} for family, count in families.most_common()],
        "sizes_pt": [{"size_pt": size, "count": count} for size, count in sizes.most_common()],
    }


def _detect_text_regions(
    text_blocks: list[dict],
    scale_roles: list[dict],
    text_slots: dict | None,
    title_instances: list[dict],
    slide_width: float | None,
    slide_height: float | None,
) -> list[dict]:
    title_keys = {(item["slide_number"], item.get("shape_id")) for item in title_instances}
    body_levels = _body_scale_levels(scale_roles)
    body_slots_by_slide = _body_slots_by_slide(text_slots)
    instances = []
    seen = set()

    for block in text_blocks:
        key = (block["slide_number"], block.get("shape_id"))
        if key in title_keys or key in seen:
            continue
        method = _body_detection_method(block, body_levels, body_slots_by_slide.get(block["slide_number"], []))
        if method is None:
            continue
        instances.append(_normalize_instance(block, slide_width, slide_height, method))
        seen.add(key)

    for slide_number, slots in body_slots_by_slide.items():
        for slot in slots:
            key = (slide_number, slot.get("shape_id"))
            if key in seen or key in title_keys:
                continue
            instances.append(_instance_from_slot(slot, slide_number, slide_width, slide_height, "body_slot"))
            seen.add(key)

    return instances


def _body_detection_method(block, body_levels, body_slots) -> str | None:
    shape_ids = {slot["shape_id"] for slot in body_slots if slot.get("shape_id")}
    if block.get("shape_id") in shape_ids:
        return "body_placeholder"
    if _matches_body_scale(block, body_levels):
        return "body_scale"
    if block.get("line_count", 1) >= 2 or block.get("char_count", 0) >= 20:
        if block.get("char_count", 0) <= 500:
            return "paragraph_heuristic"
    return None


def _matches_body_scale(block, body_levels: list[dict]) -> bool:
    scale_level = block.get("scale_level")
    if scale_level is None:
        return False
    family = block.get("family")
    for level in body_levels:
        if level["scale_level"] != scale_level:
            continue
        if family == level["family"] or family == "Наследуется":
            return True
    return False


def _instance_from_slot(slot, slide_number, slide_width, slide_height, method: str) -> dict:
    geometry = slot["geometry"]
    block = {
        "slide_number": slide_number,
        "shape_id": slot.get("shape_id"),
        "x_pt": geometry["x_pt"],
        "y_pt": geometry["y_pt"],
        "width_pt": geometry["width_pt"],
        "height_pt": geometry["height_pt"],
        "family": (slot.get("levels") or [{}])[0].get("family"),
        "size_pt": (slot.get("levels") or [{}])[0].get("size_pt"),
        "scale_level": None,
        "line_count": None,
        "char_count": len(slot.get("text_sample") or ""),
        "text_sample": slot.get("text_sample") or slot.get("placeholder_type"),
    }
    return _normalize_instance(block, slide_width, slide_height, method)


def _extract_image_instances(assets: dict | None, slide_width: float | None, slide_height: float | None) -> list[dict]:
    if not assets or not slide_width or not slide_height:
        return []
    instances = []
    for asset in assets.get("media_files", []):
        if asset.get("background_likelihood", 0) >= 0.7:
            continue
        for source in asset.get("sources", []):
            slide_match = re.search(r"slide(\d+)\.xml$", source.get("part", ""))
            if slide_match is None:
                continue
            placement = source.get("placement", {})
            if placement.get("role") == "background":
                continue
            if placement.get("coverage", 0) >= IMAGE_MAX_COVERAGE:
                continue
            if placement.get("x_pt") is None:
                continue
            block = {
                "slide_number": int(slide_match.group(1)),
                "shape_id": source.get("relationship_id"),
                "x_pt": placement["x_pt"],
                "y_pt": placement["y_pt"],
                "width_pt": placement["width_pt"],
                "height_pt": placement["height_pt"],
                "family": None,
                "size_pt": None,
                "scale_level": None,
                "line_count": None,
                "char_count": None,
                "text_sample": asset.get("filename"),
            }
            instance = _normalize_instance(block, slide_width, slide_height, "slide_picture")
            instance["filename"] = asset.get("filename")
            instance["extension"] = asset.get("extension")
            instance["pixel_width"] = asset.get("width")
            instance["pixel_height"] = asset.get("height")
            instance["coverage"] = placement.get("coverage")
            instances.append(instance)
    return instances


def _image_media_stats(instances: list[dict]) -> dict:
    widths = Counter(round(instance["width_pt"]) for instance in instances if instance.get("width_pt") is not None)
    heights = Counter(round(instance["height_pt"]) for instance in instances if instance.get("height_pt") is not None)
    extensions = Counter(instance.get("extension") for instance in instances if instance.get("extension"))
    dominant_width = widths.most_common(1)[0][0] if widths else None
    dominant_height = heights.most_common(1)[0][0] if heights else None
    return {
        "dominant_width_pt": dominant_width,
        "dominant_height_pt": dominant_height,
        "widths_pt": [{"width_pt": width, "count": count} for width, count in widths.most_common(8)],
        "heights_pt": [{"height_pt": height, "count": count} for height, count in heights.most_common(8)],
        "extensions": [{"extension": ext, "count": count} for ext, count in extensions.most_common()],
    }


def _occupancy_content_items(
    text_blocks: list[dict],
    image_instances: list[dict],
    assets: dict | None,
) -> list[dict]:
    """Content that occupies slide space — text and compact icons, not backgrounds."""
    items = list(text_blocks)
    icon_files = set()
    for group in (assets or {}).get("icon_groups", []):
        icon_files.update(group.get("files", []))
    background_files = {
        asset["filename"]
        for asset in (assets or {}).get("media_files", [])
        if asset.get("background_likelihood", 0) >= 0.7
    }

    for image in image_instances:
        filename = image.get("filename")
        if filename in background_files:
            continue
        if (image.get("coverage") or 0) >= 0.5:
            continue
        if filename in icon_files:
            items.append(image)
            continue
        width_norm = image.get("width_norm")
        height_norm = image.get("height_norm")
        if width_norm is not None and height_norm is not None and width_norm <= 0.35 and height_norm <= 0.35:
            items.append(image)
    return items


def _deck_slide_numbers(text_blocks: list[dict], assets: dict | None) -> set[int]:
    slides = {block["slide_number"] for block in text_blocks}
    for asset in (assets or {}).get("media_files", []):
        slides.update(asset.get("slide_numbers", []))
    return slides


def _compute_safe_space(
    text_blocks: list[dict],
    image_instances: list[dict],
    assets: dict | None,
    slide_width: float | None,
    slide_height: float | None,
    total_slides: int,
) -> tuple[dict | None, list[dict]]:
    if not slide_width or not slide_height or total_slides < 2:
        return None, []

    content_items = _occupancy_content_items(text_blocks, image_instances, assets)
    deck_slides = _deck_slide_numbers(text_blocks, assets)
    if not deck_slides:
        return None, []

    cols, rows = _grid_size(slide_width, slide_height)
    occupancy = [[0 for _ in range(cols)] for _ in range(rows)]
    by_slide = defaultdict(list)
    for item in content_items:
        by_slide[item["slide_number"]].append(item)

    for slide_number in deck_slides:
        covered = set()
        for item in by_slide.get(slide_number, []):
            covered.update(_cover_cells(item, slide_width, slide_height, cols, rows))
        for row, col in covered:
            occupancy[row][col] += 1

    slide_count = len(deck_slides)
    free_ratios = [
        [round((slide_count - occupancy[row][col]) / slide_count, 3) for col in range(cols)]
        for row in range(rows)
    ]
    heatmap = {
        "mode": "free_ratio",
        "cols": cols,
        "rows": rows,
        "free_ratios": free_ratios,
        "max_free_ratio": round(max(value for row in free_ratios for value in row), 3),
    }
    instances = _safe_regions_from_grid(occupancy, cols, rows, slide_count, slide_width, slide_height)
    return heatmap, instances


def _grid_size(slide_width: float, slide_height: float) -> tuple[int, int]:
    rows = max(1, round(HEATMAP_COLS / (slide_width / slide_height)))
    return HEATMAP_COLS, rows


def _cover_cells(item, slide_width, slide_height, cols, rows) -> set[tuple[int, int]]:
    x0 = item.get("x_norm")
    y0 = item.get("y_norm")
    if x0 is None:
        x0 = item["x_pt"] / slide_width
        y0 = item["y_pt"] / slide_height
        x1 = (item["x_pt"] + item["width_pt"]) / slide_width
        y1 = (item["y_pt"] + item["height_pt"]) / slide_height
    else:
        x1 = x0 + item.get("width_norm", item["width_pt"] / slide_width)
        y1 = y0 + item.get("height_norm", item["height_pt"] / slide_height)

    col_start = max(0, int(x0 * cols))
    col_end = min(cols - 1, int(x1 * cols))
    row_start = max(0, int(y0 * rows))
    row_end = min(rows - 1, int(y1 * rows))
    return {(row, col) for row in range(row_start, row_end + 1) for col in range(col_start, col_end + 1)}


def _safe_regions_from_grid(occupancy, cols, rows, total_slides, slide_width, slide_height) -> list[dict]:
    safe = [
        [((total_slides - occupancy[row][col]) / total_slides) >= SAFE_FREE_RATIO for col in range(cols)]
        for row in range(rows)
    ]
    visited = [[False for _ in range(cols)] for _ in range(rows)]
    regions = []

    for row in range(rows):
        for col in range(cols):
            if not safe[row][col] or visited[row][col]:
                continue
            cells = []
            stack = [(row, col)]
            visited[row][col] = True
            while stack:
                current_row, current_col = stack.pop()
                cells.append((current_row, current_col))
                for next_row, next_col in (
                    (current_row - 1, current_col),
                    (current_row + 1, current_col),
                    (current_row, current_col - 1),
                    (current_row, current_col + 1),
                ):
                    if 0 <= next_row < rows and 0 <= next_col < cols and safe[next_row][next_col] and not visited[next_row][next_col]:
                        visited[next_row][next_col] = True
                        stack.append((next_row, next_col))

            min_row = min(item[0] for item in cells)
            max_row = max(item[0] for item in cells)
            min_col = min(item[1] for item in cells)
            max_col = max(item[1] for item in cells)
            free_values = [(total_slides - occupancy[r][c]) / total_slides for r, c in cells]
            block = {
                "slide_number": 0,
                "shape_id": f"safe_{len(regions) + 1}",
                "x_pt": round(min_col / cols * slide_width, 2),
                "y_pt": round(min_row / rows * slide_height, 2),
                "width_pt": round((max_col - min_col + 1) / cols * slide_width, 2),
                "height_pt": round((max_row - min_row + 1) / rows * slide_height, 2),
                "family": None,
                "size_pt": None,
                "scale_level": None,
                "line_count": None,
                "char_count": len(cells),
                "text_sample": f"Свободно на {round(sum(free_values) / len(free_values) * 100)}% слайдов",
            }
            instance = _normalize_instance(block, slide_width, slide_height, "occupancy_inverse")
            instance["free_ratio"] = round(sum(free_values) / len(free_values), 3)
            instance["cell_count"] = len(cells)
            regions.append(instance)

    regions.sort(key=lambda item: (-item.get("cell_count", 0), -item.get("free_ratio", 0)))
    return regions[:12]


def _detect_repeated_groups(
    text_blocks: list[dict],
    image_instances: list[dict],
    slide_width: float | None,
    slide_height: float | None,
) -> tuple[list[dict], list[dict]]:
    if not slide_width or not slide_height:
        return [], []

    elements_by_slide = defaultdict(list)
    for block in text_blocks:
        if _element_large_enough(block, slide_width, slide_height):
            elements_by_slide[block["slide_number"]].append(_layout_element_from_block(block))
    for image in image_instances:
        if _element_large_enough(image, slide_width, slide_height):
            elements_by_slide[image["slide_number"]].append(_layout_element_from_image(image))

    slide_groups = []
    for slide_number in sorted(elements_by_slide):
        slide_groups.extend(_find_groups_on_slide(slide_number, elements_by_slide[slide_number], slide_width, slide_height))

    return _aggregate_repeated_groups(slide_groups, slide_width, slide_height)


def _element_large_enough(item, slide_width, slide_height) -> bool:
    area = item.get("width_pt", 0) * item.get("height_pt", 0)
    slide_area = slide_width * slide_height
    if slide_area <= 0:
        return False
    if area / slide_area < MIN_ELEMENT_AREA_RATIO:
        return False
    return item.get("width_pt", 0) >= 12 and item.get("height_pt", 0) >= 12


def _layout_element_from_block(block) -> dict:
    return {
        "slide_number": block["slide_number"],
        "shape_id": block.get("shape_id"),
        "x_pt": block["x_pt"],
        "y_pt": block["y_pt"],
        "width_pt": block["width_pt"],
        "height_pt": block["height_pt"],
        "kind": "text",
        "label": block.get("text_sample"),
    }


def _layout_element_from_image(image) -> dict:
    return {
        "slide_number": image["slide_number"],
        "shape_id": image.get("shape_id"),
        "x_pt": image["x_pt"],
        "y_pt": image["y_pt"],
        "width_pt": image["width_pt"],
        "height_pt": image["height_pt"],
        "kind": "image",
        "label": image.get("filename"),
    }


def _sizes_match(first, second) -> bool:
    tol_w = max(4.0, first["width_pt"] * SIZE_TOLERANCE)
    tol_h = max(4.0, first["height_pt"] * SIZE_TOLERANCE)
    return abs(first["width_pt"] - second["width_pt"]) <= tol_w and abs(first["height_pt"] - second["height_pt"]) <= tol_h


def _size_bucket(element) -> tuple[int, int]:
    return (round(element["width_pt"] / 5), round(element["height_pt"] / 5))


def _find_groups_on_slide(slide_number, elements, slide_width, slide_height) -> list[dict]:
    if len(elements) < MIN_GROUP_ITEMS:
        return []

    by_size = defaultdict(list)
    for element in elements:
        by_size[_size_bucket(element)].append(element)

    row_groups = []
    column_groups = []
    for bucket_elements in by_size.values():
        if len(bucket_elements) < MIN_GROUP_ITEMS:
            continue
        row_groups.extend(_detect_axis_groups(bucket_elements, slide_number, slide_width, slide_height, "row"))
        column_groups.extend(_detect_axis_groups(bucket_elements, slide_number, slide_width, slide_height, "column"))

    grid_groups = _detect_grid_groups(row_groups, slide_number, slide_width, slide_height)
    consumed_members = {id(member) for group in grid_groups for member in group["members"]}

    results = list(grid_groups)
    for group in row_groups + column_groups:
        if any(id(member) in consumed_members for member in group["members"]):
            continue
        results.append(group)
    return _dedupe_slide_groups(results)


def _detect_axis_groups(elements, slide_number, slide_width, slide_height, layout: str) -> list[dict]:
    align_tol = max(6.0, (slide_height if layout == "row" else slide_width) * ALIGN_TOLERANCE)
    enriched = []
    for element in elements:
        item = dict(element)
        item["center_x_pt"] = element["x_pt"] + element["width_pt"] / 2
        item["center_y_pt"] = element["y_pt"] + element["height_pt"] / 2
        enriched.append(item)

    if layout == "row":
        sorted_elements = sorted(enriched, key=lambda item: item["center_y_pt"])
    else:
        sorted_elements = sorted(enriched, key=lambda item: item["center_x_pt"])

    groups = []
    used = set()
    for index, anchor in enumerate(sorted_elements):
        if index in used:
            continue
        cluster = [anchor]
        used.add(index)
        anchor_center = anchor["center_y_pt"] if layout == "row" else anchor["center_x_pt"]
        for other_index, other in enumerate(sorted_elements):
            if other_index in used or not _sizes_match(anchor, other):
                continue
            other_center = other["center_y_pt"] if layout == "row" else other["center_x_pt"]
            if abs(anchor_center - other_center) <= align_tol:
                cluster.append(other)
                used.add(other_index)
        if len(cluster) >= MIN_GROUP_ITEMS:
            groups.append(_finalize_layout_group(cluster, layout, slide_number, slide_width, slide_height))
    return groups


def _detect_grid_groups(row_groups, slide_number, slide_width, slide_height) -> list[dict]:
    by_signature = defaultdict(list)
    for group in row_groups:
        signature = (len(group["members"]), round(group["item_width_pt"]), round(group["item_height_pt"]))
        by_signature[signature].append(group)

    grids = []
    for rows in by_signature.values():
        if len(rows) < 2:
            continue
        if not _rows_x_align(rows, slide_width):
            continue
        members = [member for row in rows for member in row["members"]]
        grid = _finalize_layout_group(members, "grid", slide_number, slide_width, slide_height)
        grid["rows"] = len(rows)
        grid["cols"] = len(rows[0]["members"])
        grids.append(grid)
    return grids


def _rows_x_align(row_groups, slide_width) -> bool:
    align_tol = max(8.0, slide_width * ALIGN_TOLERANCE)
    x_sets = []
    for group in row_groups:
        x_sets.append(sorted(member["x_pt"] + member["width_pt"] / 2 for member in group["members"]))
    col_count = len(x_sets[0])
    if col_count < MIN_GROUP_ITEMS or any(len(items) != col_count for items in x_sets):
        return False
    for col in range(col_count):
        column_centers = [items[col] for items in x_sets]
        if max(column_centers) - min(column_centers) > align_tol:
            return False
    return True


def _spacing_stats(elements, layout: str) -> float | None:
    if layout == "row":
        ordered = sorted(elements, key=lambda item: item["x_pt"])
        gaps = [
            ordered[index + 1]["x_pt"] - (ordered[index]["x_pt"] + ordered[index]["width_pt"])
            for index in range(len(ordered) - 1)
        ]
    elif layout == "column":
        ordered = sorted(elements, key=lambda item: item["y_pt"])
        gaps = [
            ordered[index + 1]["y_pt"] - (ordered[index]["y_pt"] + ordered[index]["height_pt"])
            for index in range(len(ordered) - 1)
        ]
    else:
        rows = defaultdict(list)
        for element in elements:
            rows[round(element["y_pt"] / 5)].append(element)
        row_gaps = []
        col_gaps = []
        for row_elements in rows.values():
            ordered = sorted(row_elements, key=lambda item: item["x_pt"])
            col_gaps.extend(
                ordered[index + 1]["x_pt"] - (ordered[index]["x_pt"] + ordered[index]["width_pt"])
                for index in range(len(ordered) - 1)
            )
        ordered_rows = sorted(rows)
        for index in range(len(ordered_rows) - 1):
            current = max(item["y_pt"] + item["height_pt"] for item in rows[ordered_rows[index]])
            next_top = min(item["y_pt"] for item in rows[ordered_rows[index + 1]])
            row_gaps.append(next_top - current)
        gaps = col_gaps or row_gaps
    gaps = [gap for gap in gaps if gap >= -2]
    return round(median(gaps), 2) if gaps else None


def _finalize_layout_group(members, layout, slide_number, slide_width, slide_height) -> dict:
    widths = [member["width_pt"] for member in members]
    heights = [member["height_pt"] for member in members]
    item_count = len(members)
    rows = 1
    cols = item_count
    if layout == "column":
        rows, cols = item_count, 1
    elif layout == "grid":
        rows = len({round(member["y_pt"] / 5) for member in members})
        cols = max(1, item_count // rows)
    return {
        "slide_number": slide_number,
        "layout": layout,
        "item_count": item_count,
        "rows": rows,
        "cols": cols,
        "item_width_pt": round(median(widths), 2),
        "item_height_pt": round(median(heights), 2),
        "spacing_pt": _spacing_stats(members, layout),
        "members": members,
        "kinds": sorted({member["kind"] for member in members}),
    }


def _dedupe_slide_groups(groups) -> list[dict]:
    layout_rank = {"grid": 3, "row": 2, "column": 1}
    ordered = sorted(
        groups,
        key=lambda group: (layout_rank.get(group["layout"], 0), len(group["members"])),
        reverse=True,
    )
    kept = []
    used_member_ids = set()
    for group in ordered:
        member_ids = {id(member) for member in group["members"]}
        if member_ids & used_member_ids and len(member_ids & used_member_ids) >= max(1, len(member_ids) // 2):
            continue
        kept.append(group)
        used_member_ids |= member_ids
    return kept


def _aggregate_repeated_groups(slide_groups, slide_width, slide_height) -> tuple[list[dict], list[dict]]:
    aggregated = {}
    for group in slide_groups:
        signature = (
            group["layout"],
            group["item_count"],
            round(group["item_width_pt"] / 5),
            round(group["item_height_pt"] / 5),
            group["rows"],
            group["cols"],
        )
        if signature not in aggregated:
            aggregated[signature] = {
                "group_id": f"rg_{len(aggregated) + 1:03d}",
                "layout": group["layout"],
                "item_count": group["item_count"],
                "rows": group["rows"],
                "cols": group["cols"],
                "item_width_pt": group["item_width_pt"],
                "item_height_pt": group["item_height_pt"],
                "spacing_pt": [],
                "kinds": set(group["kinds"]),
                "slide_numbers": set(),
                "occurrences": 0,
                "members_by_slide": [],
            }
        entry = aggregated[signature]
        entry["slide_numbers"].add(group["slide_number"])
        entry["occurrences"] += 1
        entry["kinds"].update(group["kinds"])
        if group.get("spacing_pt") is not None:
            entry["spacing_pt"].append(group["spacing_pt"])
        entry["members_by_slide"].append(group)

    patterns = []
    instances = []
    for entry in aggregated.values():
        spacing_values = entry["spacing_pt"]
        pattern = {
            "group_id": entry["group_id"],
            "layout": entry["layout"],
            "item_count": entry["item_count"],
            "rows": entry["rows"],
            "cols": entry["cols"],
            "item_width_pt": entry["item_width_pt"],
            "item_height_pt": entry["item_height_pt"],
            "spacing_pt": round(median(spacing_values), 2) if spacing_values else None,
            "kinds": sorted(entry["kinds"]),
            "occurrences": entry["occurrences"],
            "slide_numbers": sorted(entry["slide_numbers"]),
        }
        patterns.append(pattern)

        for slide_group in entry["members_by_slide"]:
            for index, member in enumerate(slide_group["members"], start=1):
                block = {
                    "slide_number": member["slide_number"],
                    "shape_id": member.get("shape_id"),
                    "x_pt": member["x_pt"],
                    "y_pt": member["y_pt"],
                    "width_pt": member["width_pt"],
                    "height_pt": member["height_pt"],
                    "family": None,
                    "size_pt": None,
                    "scale_level": None,
                    "line_count": None,
                    "char_count": None,
                    "text_sample": member.get("label"),
                }
                instance = _normalize_instance(block, slide_width, slide_height, slide_group["layout"])
                instance["group_id"] = entry["group_id"]
                instance["group_layout"] = slide_group["layout"]
                instance["group_index"] = index
                instance["element_kind"] = member["kind"]
                instances.append(instance)

    patterns = [
        pattern for pattern in patterns
        if pattern["occurrences"] >= 2
        or len(pattern["slide_numbers"]) >= 2
        or pattern["item_count"] >= 3
    ]
    patterns.sort(key=lambda item: (-len(item["slide_numbers"]), -item["occurrences"], -item["item_count"], item["group_id"]))
    kept_ids = {pattern["group_id"] for pattern in patterns}
    instances = [instance for instance in instances if instance.get("group_id") in kept_ids]
    return patterns, instances


def _detect_slide_titles(
    text_blocks: list[dict],
    title_levels: list[dict],
    title_slots_by_slide: dict[int, list[dict]],
    slide_width: float | None,
    slide_height: float | None,
) -> list[dict]:
    by_slide = defaultdict(list)
    for block in text_blocks:
        by_slide[block["slide_number"]].append(block)

    instances = []
    for slide_number in sorted(by_slide):
        block, method = _pick_title_block(
            by_slide[slide_number],
            title_levels,
            title_slots_by_slide.get(slide_number, []),
            slide_height,
        )
        if block is None:
            continue
        instances.append(_normalize_instance(block, slide_width, slide_height, method))
    return instances


def _pick_title_block(blocks, title_levels, title_slots, slide_height):
    if not blocks:
        return None, None

    title_shape_ids = {slot["shape_id"] for slot in title_slots if slot.get("shape_id")}
    shape_matches = [block for block in blocks if block.get("shape_id") in title_shape_ids]
    if shape_matches:
        return _best_top_block(shape_matches, slide_height), "placeholder_shape"

    placeholder_matches = [
        (block, score) for block in blocks
        for score in [_best_placeholder_match_score(block, title_slots)]
        if score >= 0.75
    ]
    if placeholder_matches:
        block, _ = max(placeholder_matches, key=lambda item: (item[1], -item[0]["y_pt"]))
        return block, "placeholder_geometry"

    scale_matches = [block for block in blocks if _matches_title_scale(block, title_levels)]
    if scale_matches:
        return _best_top_block(scale_matches, slide_height), "scale_role"

    spatial_candidates = [block for block in blocks if _spatial_title_candidate(block, slide_height)]
    if spatial_candidates:
        return _best_top_block(spatial_candidates, slide_height), "spatial_fallback"

    return None, None


def _matches_title_scale(block, title_levels: list[dict]) -> bool:
    scale_level = block.get("scale_level")
    if scale_level is None:
        return False
    family = block.get("family")
    for level in title_levels:
        if level["scale_level"] != scale_level:
            continue
        if family == level["family"] or family == "Наследуется":
            return True
    return False


def _spatial_title_candidate(block, slide_height: float | None) -> bool:
    if block.get("char_count", 0) > 150 or block.get("line_count", 1) > 4:
        return False
    if slide_height:
        center_y = (block["y_pt"] + block["height_pt"] / 2) / slide_height
        return center_y <= TOP_ZONE_RATIO
    return block.get("y_pt", 0) <= 180


def _best_top_block(blocks, slide_height):
    def sort_key(block):
        center_y = (block["y_pt"] + block["height_pt"] / 2) / slide_height if slide_height else block["y_pt"]
        return (center_y, -block.get("height_pt", 0), -block.get("char_count", 0))
    return min(blocks, key=sort_key)


def _best_placeholder_match_score(block, title_slots: list[dict]) -> float:
    if not title_slots:
        return 0.0
    return max(_bbox_overlap_ratio(block, slot["geometry"]) for slot in title_slots)


def _bbox_overlap_ratio(block, geometry: dict) -> float:
    left_a = block["x_pt"]
    top_a = block["y_pt"]
    right_a = left_a + block["width_pt"]
    bottom_a = top_a + block["height_pt"]

    left_b = geometry["x_pt"]
    top_b = geometry["y_pt"]
    right_b = left_b + geometry["width_pt"]
    bottom_b = top_b + geometry["height_pt"]

    overlap_w = max(0.0, min(right_a, right_b) - max(left_a, left_b))
    overlap_h = max(0.0, min(bottom_a, bottom_b) - max(top_a, top_b))
    overlap_area = overlap_w * overlap_h
    block_area = max(block["width_pt"] * block["height_pt"], 1.0)
    zone_area = max(geometry["width_pt"] * geometry["height_pt"], 1.0)
    return overlap_area / min(block_area, zone_area)


def _normalize_instance(block, slide_width, slide_height, method: str) -> dict:
    center_x = block["x_pt"] + block["width_pt"] / 2
    center_y = block["y_pt"] + block["height_pt"] / 2
    normalized = {}
    if slide_width and slide_height:
        normalized = {
            "x_norm": round(block["x_pt"] / slide_width, 4),
            "y_norm": round(block["y_pt"] / slide_height, 4),
            "width_norm": round(block["width_pt"] / slide_width, 4),
            "height_norm": round(block["height_pt"] / slide_height, 4),
            "center_x_norm": round(center_x / slide_width, 4),
            "center_y_norm": round(center_y / slide_height, 4),
        }
    return {
        "slide_number": block["slide_number"],
        "shape_id": block.get("shape_id"),
        "x_pt": round(block["x_pt"], 2),
        "y_pt": round(block["y_pt"], 2),
        "width_pt": round(block["width_pt"], 2),
        "height_pt": round(block["height_pt"], 2),
        "center_x_pt": round(center_x, 2),
        "center_y_pt": round(center_y, 2),
        "family": block.get("family"),
        "size_pt": block.get("size_pt"),
        "scale_level": block.get("scale_level"),
        "line_count": block.get("line_count"),
        "char_count": block.get("char_count"),
        "text_sample": block.get("text_sample"),
        "detection_method": method,
        **normalized,
    }


def _build_component(
    component_id: str,
    label: str,
    instances: list[dict],
    slide_width: float | None,
    slide_height: float | None,
    total_slides: int,
    typography: dict,
    detection: dict,
    media: dict | None = None,
    extra: dict | None = None,
    groups: list[dict] | None = None,
) -> dict:
    method_counts = Counter(instance["detection_method"] for instance in instances)
    slide_ids = {instance["slide_number"] for instance in instances if instance.get("slide_number")}
    slide_ids.discard(0)
    result = {
        "id": component_id,
        "label": label,
        "detection": {
            **detection,
            "instance_methods": dict(method_counts),
        },
        "typography": _instance_typography(instances, typography) if typography else _instance_typography(instances, {}),
        "spatial_rules": _spatial_rules(instances, slide_width, slide_height),
        "line_counts": _line_count_stats(instances),
        "frequency": {
            "instance_count": len(instances),
            "slide_count": len(slide_ids),
            "total_slides": total_slides,
            "presence_ratio": round(len(slide_ids) / total_slides, 3) if total_slides and slide_ids else 0.0,
        },
        "heatmap": _position_heatmap(instances, slide_width, slide_height),
        "instances": instances,
    }
    if media:
        result["media"] = media
    if extra:
        result["extra"] = extra
    if groups:
        result["groups"] = groups
    return result


def _instance_typography(instances: list[dict], slot_typography: dict) -> dict:
    families = Counter(instance["family"] for instance in instances if instance.get("family"))
    sizes = Counter(instance["size_pt"] for instance in instances if instance.get("size_pt") is not None)
    return {
        "dominant_family": families.most_common(1)[0][0] if families else slot_typography.get("dominant_family"),
        "dominant_size_pt": sizes.most_common(1)[0][0] if sizes else slot_typography.get("dominant_size_pt"),
        "slot_dominant_family": slot_typography.get("dominant_family"),
        "slot_dominant_size_pt": slot_typography.get("dominant_size_pt"),
        "families": [{"family": family, "count": count} for family, count in families.most_common()],
        "sizes_pt": [{"size_pt": size, "count": count} for size, count in sizes.most_common()],
    }


def _spatial_rules(instances: list[dict], slide_width: float | None, slide_height: float | None) -> dict:
    if not instances:
        return {}

    def stats(values: list[float]) -> dict:
        ordered = sorted(values)
        return {
            "min": round(min(ordered), 2),
            "max": round(max(ordered), 2),
            "median": round(median(ordered), 2),
        }

    rules = {
        "x_pt": stats([instance["x_pt"] for instance in instances]),
        "y_pt": stats([instance["y_pt"] for instance in instances]),
        "width_pt": stats([instance["width_pt"] for instance in instances]),
        "height_pt": stats([instance["height_pt"] for instance in instances]),
        "center_x_pt": stats([instance["center_x_pt"] for instance in instances]),
        "center_y_pt": stats([instance["center_y_pt"] for instance in instances]),
    }
    if slide_width and slide_height and instances[0].get("x_norm") is not None:
        rules.update({
            "x_norm": stats([instance["x_norm"] for instance in instances]),
            "y_norm": stats([instance["y_norm"] for instance in instances]),
            "width_norm": stats([instance["width_norm"] for instance in instances]),
            "height_norm": stats([instance["height_norm"] for instance in instances]),
            "center_x_norm": stats([instance["center_x_norm"] for instance in instances]),
            "center_y_norm": stats([instance["center_y_norm"] for instance in instances]),
        })
    return rules


def _line_count_stats(instances: list[dict]) -> dict:
    if not instances:
        return {}
    counts = [instance.get("line_count") or 1 for instance in instances]
    distribution = Counter(counts)
    ordered = sorted(counts)
    return {
        "min": min(ordered),
        "max": max(ordered),
        "median": int(median(ordered)),
        "distribution": {str(key): value for key, value in sorted(distribution.items())},
    }


def _position_heatmap(instances: list[dict], slide_width: float | None, slide_height: float | None) -> dict:
    """Rasterize text-field bounding boxes onto a grid (not center points)."""
    if not instances or not slide_width or not slide_height:
        return {"cols": HEATMAP_COLS, "rows": 0, "counts": [], "max_count": 0, "mode": "bbox"}

    aspect = slide_width / slide_height
    rows = max(1, round(HEATMAP_COLS / aspect))
    grid = [[0 for _ in range(HEATMAP_COLS)] for _ in range(rows)]

    for instance in instances:
        x0 = instance.get("x_norm")
        y0 = instance.get("y_norm")
        x1 = x0 + instance.get("width_norm") if x0 is not None else None
        y1 = y0 + instance.get("height_norm") if y0 is not None else None
        if x0 is None or y0 is None:
            x0 = instance["x_pt"] / slide_width
            y0 = instance["y_pt"] / slide_height
            x1 = (instance["x_pt"] + instance["width_pt"]) / slide_width
            y1 = (instance["y_pt"] + instance["height_pt"]) / slide_height

        col_start = max(0, int(x0 * HEATMAP_COLS))
        col_end = min(HEATMAP_COLS - 1, int(x1 * HEATMAP_COLS))
        row_start = max(0, int(y0 * rows))
        row_end = min(rows - 1, int(y1 * rows))
        for row in range(row_start, row_end + 1):
            for col in range(col_start, col_end + 1):
                grid[row][col] += 1

    max_count = max(value for row in grid for value in row) if instances else 0
    return {
        "cols": HEATMAP_COLS,
        "rows": rows,
        "counts": grid,
        "max_count": max_count,
        "mode": "bbox",
    }
