"""Detect reusable slide components with required and optional slots."""

from collections import Counter, defaultdict
from statistics import median

from .spatial_analysis import (
    MIN_GROUP_ITEMS,
    _extract_image_instances,
    _find_groups_on_slide,
)

CORE_THRESHOLD = 0.75
OPTIONAL_MIN = 0.25
POSITION_TOLERANCE = 0.08
SLOT_GRID = 10
MIN_CHILDREN = 2
MAX_CHILDREN = 8
MAX_ICONS_PER_CONTAINER = 2
MAX_ICONS_FOR_ANCHORING = 16
MIN_CONTAINER_AREA_RATIO = 0.008
MAX_CONTAINER_AREA_RATIO = 0.35
CLUSTER_GAP_RATIO = 0.04
ICON_TEXT_MAX_VERTICAL_GAP_RATIO = 0.14
ICON_HORIZONTAL_MARGIN_RATIO = 0.35
GRAPHIC_KINDS = frozenset({"icon", "image", "background_image"})


def detect_components(
    text_blocks: list[dict],
    scale_roles: list[dict],
    slide_size: tuple[float, float] | None,
    assets: dict | None = None,
) -> dict:
    slide_width, slide_height = slide_size or (None, None)
    if not slide_width or not slide_height:
        return {"components": [], "summary": {"component_count": 0, "instance_count": 0}}

    image_instances = _extract_image_instances(assets, slide_width, slide_height)
    icon_files = _icon_files(assets)
    elements_by_slide = _elements_by_slide(text_blocks, image_instances, icon_files)

    container_instances = []
    for slide_number in sorted(elements_by_slide):
        slide_elements = elements_by_slide[slide_number]
        container_instances.extend(
            _find_containers_on_slide(slide_number, slide_elements, slide_width, slide_height)
        )

    if len(container_instances) < MIN_GROUP_ITEMS:
        return {"components": [], "summary": {"component_count": 0, "instance_count": 0}}

    grouped = _group_container_instances(container_instances, slide_width, slide_height)
    components = []
    for index, group in enumerate(grouped, start=1):
        component = _build_component_definition(index, group, slide_width, slide_height)
        if component:
            components.append(component)

    components.sort(
        key=lambda item: (
            -item["frequency"]["instance_count"],
            -len(item["frequency"]["slide_numbers"]),
            item["component_id"],
        )
    )
    return {
        "components": components,
        "summary": {
            "component_count": len(components),
            "instance_count": sum(item["frequency"]["instance_count"] for item in components),
        },
    }


def _icon_files(assets: dict | None) -> set[str]:
    icon_files = set()
    for group in (assets or {}).get("icon_groups", []):
        icon_files.update(group.get("files", []))
    return icon_files


def _elements_by_slide(
    text_blocks: list[dict],
    image_instances: list[dict],
    icon_files: set[str],
) -> dict[int, list[dict]]:
    by_slide = defaultdict(list)
    for block in text_blocks:
        by_slide[block["slide_number"]].append(_element_from_text(block))
    for image in image_instances:
        by_slide[image["slide_number"]].append(_element_from_image(image, icon_files))
    return dict(by_slide)


def _element_from_text(block: dict) -> dict:
    return {
        "slide_number": block["slide_number"],
        "shape_id": block.get("shape_id"),
        "x_pt": block["x_pt"],
        "y_pt": block["y_pt"],
        "width_pt": block["width_pt"],
        "height_pt": block["height_pt"],
        "kind": "text",
        "family": block.get("family"),
        "size_pt": block.get("size_pt"),
        "scale_level": block.get("scale_level"),
        "line_count": block.get("line_count") or 1,
        "char_count": block.get("char_count") or 0,
        "label": block.get("text_sample"),
    }


def _element_from_image(image: dict, icon_files: set[str]) -> dict:
    filename = image.get("filename") or ""
    coverage = image.get("coverage") or 0
    width_norm = image.get("width_norm") or 0
    height_norm = image.get("height_norm") or 0
    if coverage >= 0.55 or (width_norm >= 0.55 and height_norm >= 0.55):
        kind = "background_image"
    elif (
        filename in icon_files
        or (width_norm <= 0.28 and height_norm <= 0.28)
        or (image.get("width_pt", 999) <= 72 and image.get("height_pt", 999) <= 72)
    ):
        kind = "icon"
    else:
        kind = "image"
    return {
        "slide_number": image["slide_number"],
        "shape_id": image.get("shape_id"),
        "x_pt": image["x_pt"],
        "y_pt": image["y_pt"],
        "width_pt": image["width_pt"],
        "height_pt": image["height_pt"],
        "kind": kind,
        "family": None,
        "size_pt": None,
        "scale_level": None,
        "line_count": None,
        "char_count": None,
        "label": filename,
        "filename": filename,
        "coverage": coverage,
    }


def _find_containers_on_slide(
    slide_number: int,
    elements: list[dict],
    slide_width: float,
    slide_height: float,
) -> list[dict]:
    if len(elements) < MIN_CHILDREN:
        return []

    clusters = _cluster_elements(elements, slide_width, slide_height)
    candidates = []
    seen_bbox_keys = set()
    for cluster in clusters:
        enriched = _expand_cluster_with_graphics(cluster, elements, slide_width, slide_height)
        child_count = len(enriched["children"])
        if child_count < MIN_CHILDREN or child_count > MAX_CHILDREN:
            continue
        if not _container_large_enough(enriched, slide_width, slide_height):
            continue
        if _too_many_icons(enriched):
            continue
        enriched["_origin"] = "proximity"
        candidates.append(enriched)
        seen_bbox_keys.add(_bbox_key(enriched["bbox"]))

    icons_on_slide = sum(1 for element in elements if element["kind"] == "icon")
    if icons_on_slide <= MAX_ICONS_FOR_ANCHORING:
        anchored_source = _icon_anchored_containers(elements, slide_width, slide_height)
    else:
        anchored_source = []
    for anchored in anchored_source:
        key = _bbox_key(anchored["bbox"])
        if key in seen_bbox_keys:
            continue
        child_count = len(anchored["children"])
        if child_count < MIN_CHILDREN or child_count > MAX_CHILDREN:
            continue
        if not _container_large_enough(anchored, slide_width, slide_height):
            continue
        if _too_many_icons(anchored):
            continue
        anchored["_origin"] = "icon_anchored"
        candidates.append(anchored)
        seen_bbox_keys.add(key)

    if not candidates:
        return []

    candidates = _prune_nested_containers(candidates)

    proximity_candidates = [item for item in candidates if item.get("_origin") == "proximity"]
    icon_candidates = [item for item in candidates if item.get("_origin") == "icon_anchored"]

    instances: list[dict] = []

    if icon_candidates:
        ordered = sorted(icon_candidates, key=lambda item: (item["bbox"]["y_pt"], item["bbox"]["x_pt"]))
        layout_kind = _infer_local_layout(ordered, slide_width, slide_height) if len(ordered) >= MIN_GROUP_ITEMS else "single"
        for index, candidate in enumerate(ordered, start=1):
            instances.append(_container_instance(slide_number, layout_kind, index, candidate, elements))

    if proximity_candidates:
        for candidate in proximity_candidates:
            candidate["_layout"] = _layout_element_from_container(candidate)
        groups = _find_groups_on_slide(
            slide_number,
            [candidate["_layout"] for candidate in proximity_candidates],
            slide_width,
            slide_height,
        )

        layout_by_key = {}
        for candidate in proximity_candidates:
            layout = candidate["_layout"]
            layout_by_key[(layout["x_pt"], layout["y_pt"], layout["width_pt"], layout["height_pt"])] = candidate

        matched_keys = set()
        for group in groups:
            ordered_members = sorted(group["members"], key=lambda item: (item["y_pt"], item["x_pt"]))
            for index, member in enumerate(ordered_members, start=1):
                key = (member["x_pt"], member["y_pt"], member["width_pt"], member["height_pt"])
                candidate = layout_by_key.get(key)
                if candidate is None:
                    continue
                matched_keys.add(key)
                instances.append(_container_instance(
                    slide_number, group["layout"], index, candidate, elements,
                ))

        unmatched = [
            candidate for candidate in proximity_candidates
            if (candidate["_layout"]["x_pt"], candidate["_layout"]["y_pt"],
                candidate["_layout"]["width_pt"], candidate["_layout"]["height_pt"]) not in matched_keys
        ]
        if len(unmatched) >= MIN_GROUP_ITEMS:
            ordered = sorted(unmatched, key=lambda item: (item["bbox"]["y_pt"], item["bbox"]["x_pt"]))
            layout_kind = _infer_local_layout(ordered, slide_width, slide_height)
            for index, candidate in enumerate(ordered, start=1):
                instances.append(_container_instance(slide_number, layout_kind, index, candidate, elements))

    return _dedupe_container_instances(instances)


def _container_instance(
    slide_number: int,
    layout: str,
    group_index: int,
    candidate: dict,
    all_elements: list[dict] | None = None,
) -> dict:
    slots = _extract_slots(candidate["bbox"], candidate["children"], all_elements)
    return {
        "slide_number": slide_number,
        "layout": layout,
        "group_index": group_index,
        "container": candidate["bbox"],
        "slots": slots,
        "item_width_pt": candidate["bbox"]["width_pt"],
        "item_height_pt": candidate["bbox"]["height_pt"],
    }


def _infer_local_layout(candidates: list[dict], slide_width: float, slide_height: float) -> str:
    if len(candidates) < MIN_GROUP_ITEMS:
        return "single"
    xs = [item["bbox"]["x_pt"] + item["bbox"]["width_pt"] / 2 for item in candidates]
    ys = [item["bbox"]["y_pt"] + item["bbox"]["height_pt"] / 2 for item in candidates]
    x_spread = max(xs) - min(xs)
    y_spread = max(ys) - min(ys)
    if x_spread / slide_width > y_spread / slide_height:
        return "row"
    if y_spread / slide_height > x_spread / slide_width:
        return "column"
    return "row"


def _cluster_elements(elements: list[dict], slide_width: float, slide_height: float) -> list[dict]:
    gap = min(slide_width, slide_height) * CLUSTER_GAP_RATIO
    parent = list(range(len(elements)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        root_left = find(left)
        root_right = find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for left in range(len(elements)):
        for right in range(left + 1, len(elements)):
            if _elements_belong_together(
                elements[left], elements[right], gap, slide_width, slide_height,
            ):
                union(left, right)

    grouped = defaultdict(list)
    for index, element in enumerate(elements):
        grouped[find(index)].append(element)

    clusters = []
    for members in grouped.values():
        if len(members) < MIN_CHILDREN:
            continue
        bbox = _union_bbox(members)
        clusters.append({"bbox": bbox, "children": members})
    return clusters


def _elements_belong_together(
    first: dict,
    second: dict,
    gap: float,
    slide_width: float,
    slide_height: float,
) -> bool:
    if _overlap_ratio(first, second) > 0.05:
        return True
    if _icon_text_connected(first, second, slide_width, slide_height):
        return True
    horizontal_gap = max(0.0, max(first["x_pt"], second["x_pt"]) - min(first["x_pt"] + first["width_pt"], second["x_pt"] + second["width_pt"]))
    vertical_gap = max(0.0, max(first["y_pt"], second["y_pt"]) - min(first["y_pt"] + first["height_pt"], second["y_pt"] + second["height_pt"]))
    return horizontal_gap <= gap and vertical_gap <= gap * 2.5


def _icon_text_connected(first: dict, second: dict, slide_width: float, slide_height: float) -> bool:
    kinds = {first["kind"], second["kind"]}
    if "text" not in kinds or not kinds & {"icon", "image"}:
        return False
    text = first if first["kind"] == "text" else second
    graphic = second if first["kind"] == "text" else first
    if graphic["kind"] not in {"icon", "image"}:
        return False

    graphic_left = graphic["x_pt"]
    graphic_right = graphic["x_pt"] + graphic["width_pt"]
    margin = graphic["width_pt"] * ICON_HORIZONTAL_MARGIN_RATIO
    text_center_x = text["x_pt"] + text["width_pt"] / 2
    if text_center_x < graphic_left - margin or text_center_x > graphic_right + margin:
        return False

    text_top = text["y_pt"]
    text_bottom = text["y_pt"] + text["height_pt"]
    graphic_top = graphic["y_pt"]
    graphic_bottom = graphic["y_pt"] + graphic["height_pt"]
    max_gap = slide_height * ICON_TEXT_MAX_VERTICAL_GAP_RATIO

    if graphic_bottom <= text_bottom and text_top - graphic_bottom <= max_gap:
        return True
    if graphic_top >= text_top and graphic_top - text_bottom <= max_gap * 0.6:
        return True
    if _overlap_ratio(text, graphic) > 0.02:
        return True
    return False


def _expand_cluster_with_graphics(
    cluster: dict,
    all_elements: list[dict],
    slide_width: float,
    slide_height: float,
) -> dict:
    children = list(cluster["children"])
    seen = {item.get("shape_id") for item in children if item.get("shape_id") is not None}
    text_blocks = [item for item in children if item["kind"] == "text"]
    anchor_bbox = _union_bbox(text_blocks or children)

    for element in all_elements:
        if element in children:
            continue
        shape_id = element.get("shape_id")
        if shape_id is not None and shape_id in seen:
            continue
        if element["kind"] not in GRAPHIC_KINDS:
            continue
        if _graphic_belongs_to_container(element, anchor_bbox, slide_width, slide_height):
            children.append(element)
            if shape_id is not None:
                seen.add(shape_id)

    return {"bbox": _union_bbox(children), "children": children}


def _graphic_belongs_to_container(
    graphic: dict,
    anchor_bbox: dict,
    slide_width: float,
    slide_height: float,
) -> bool:
    if _center_inside(graphic, anchor_bbox):
        return True
    return _icon_text_connected(
        {"kind": "text", **anchor_bbox},
        graphic,
        slide_width,
        slide_height,
    )


def _too_many_icons(cluster: dict) -> bool:
    return sum(1 for child in cluster["children"] if child["kind"] == "icon") > MAX_ICONS_PER_CONTAINER


def _bbox_key(bbox: dict) -> tuple:
    return (
        round(bbox["x_pt"]),
        round(bbox["y_pt"]),
        round(bbox["width_pt"] / 5),
        round(bbox["height_pt"] / 5),
    )


def _icon_anchored_containers(
    elements: list[dict],
    slide_width: float,
    slide_height: float,
) -> list[dict]:
    icons = [element for element in elements if element["kind"] == "icon"]
    texts = [element for element in elements if element["kind"] == "text"]
    if not icons or not texts:
        return []

    containers = []
    for icon in icons:
        members = [icon]
        for text in texts:
            if _icon_text_connected(text, icon, slide_width, slide_height):
                members.append(text)
        if len(members) < 2:
            continue
        members = _attach_stacked_text(members, texts, slide_height)
        if len(members) < MIN_CHILDREN:
            continue
        containers.append({"bbox": _union_bbox(members), "children": members})
    return containers


def _attach_stacked_text(members: list[dict], texts: list[dict], slide_height: float) -> list[dict]:
    """Attach body/description text stacked below the title in the same column."""
    result = list(members)
    seen = {item.get("shape_id") for item in result if item.get("shape_id") is not None}
    icons = [item for item in result if item["kind"] == "icon"]
    anchor_texts = [item for item in result if item["kind"] == "text"]
    if not anchor_texts:
        return result

    anchor = min(anchor_texts, key=lambda item: item["y_pt"])
    if icons:
        icon = min(icons, key=lambda item: item["y_pt"])
        column_left = icon["x_pt"] - icon["width_pt"] * ICON_HORIZONTAL_MARGIN_RATIO
        column_right = icon["x_pt"] + icon["width_pt"] * (1 + ICON_HORIZONTAL_MARGIN_RATIO)
    else:
        column_left = anchor["x_pt"] - anchor["width_pt"] * 0.15
        column_right = anchor["x_pt"] + anchor["width_pt"] * 1.15
    anchor_bottom = max(item["y_pt"] + item["height_pt"] for item in anchor_texts)
    max_gap = slide_height * ICON_TEXT_MAX_VERTICAL_GAP_RATIO

    for text in sorted(texts, key=lambda item: item["y_pt"]):
        shape_id = text.get("shape_id")
        if shape_id is not None and shape_id in seen:
            continue
        text_center = text["x_pt"] + text["width_pt"] / 2
        if text_center < column_left or text_center > column_right:
            continue
        if text["y_pt"] < anchor["y_pt"] - 4:
            continue
        if text["y_pt"] - anchor_bottom > max_gap:
            continue
        result.append(text)
        if shape_id is not None:
            seen.add(shape_id)
        anchor_bottom = max(anchor_bottom, text["y_pt"] + text["height_pt"])
    return result


def _center_inside(element: dict, bbox: dict) -> bool:
    cx = element["x_pt"] + element["width_pt"] / 2
    cy = element["y_pt"] + element["height_pt"] / 2
    return (
        bbox["x_pt"] <= cx <= bbox["x_pt"] + bbox["width_pt"]
        and bbox["y_pt"] <= cy <= bbox["y_pt"] + bbox["height_pt"]
    )


def _union_bbox(elements: list[dict]) -> dict:
    left = min(item["x_pt"] for item in elements)
    top = min(item["y_pt"] for item in elements)
    right = max(item["x_pt"] + item["width_pt"] for item in elements)
    bottom = max(item["y_pt"] + item["height_pt"] for item in elements)
    return {
        "x_pt": round(left, 2),
        "y_pt": round(top, 2),
        "width_pt": round(right - left, 2),
        "height_pt": round(bottom - top, 2),
    }


def _container_large_enough(cluster: dict, slide_width: float, slide_height: float) -> bool:
    bbox = cluster["bbox"]
    area = bbox["width_pt"] * bbox["height_pt"]
    slide_area = slide_width * slide_height
    if slide_area <= 0:
        return False
    ratio = area / slide_area
    return MIN_CONTAINER_AREA_RATIO <= ratio <= MAX_CONTAINER_AREA_RATIO


def _layout_element_from_container(cluster: dict) -> dict:
    bbox = cluster["bbox"]
    return {
        "slide_number": cluster["children"][0]["slide_number"],
        "shape_id": f"container_{bbox['x_pt']}_{bbox['y_pt']}",
        "x_pt": bbox["x_pt"],
        "y_pt": bbox["y_pt"],
        "width_pt": bbox["width_pt"],
        "height_pt": bbox["height_pt"],
        "kind": "container",
        "label": f"{len(cluster['children'])} slots",
    }


def _extract_slots(
    container: dict,
    children: list[dict],
    all_elements: list[dict] | None = None,
) -> list[dict]:
    members = list(children)
    seen = {item.get("shape_id") for item in members if item.get("shape_id") is not None}
    for element in all_elements or []:
        if element in members:
            continue
        shape_id = element.get("shape_id")
        if shape_id is not None and shape_id in seen:
            continue
        if element["kind"] not in GRAPHIC_KINDS:
            continue
        if _center_inside(element, container):
            members.append(element)
            if shape_id is not None:
                seen.add(shape_id)

    slots = []
    text_children = [child for child in members if child["kind"] == "text"]
    title_shape_id = None
    if text_children:
        title_shape_id = max(
            text_children,
            key=lambda item: (
                item.get("size_pt") or 0,
                -item["y_pt"],
                item.get("char_count") or 0,
            ),
        ).get("shape_id")

    for child in sorted(members, key=lambda item: (item["y_pt"], item["x_pt"])):
        slot = _slot_from_child(child, container, title_shape_id)
        slots.append(slot)
    return slots


def _slot_from_child(child: dict, container: dict, title_shape_id) -> dict:
    cx = (child["x_pt"] + child["width_pt"] / 2 - container["x_pt"]) / max(container["width_pt"], 1)
    cy = (child["y_pt"] + child["height_pt"] / 2 - container["y_pt"]) / max(container["height_pt"], 1)
    role = _infer_slot_role(child, container, title_shape_id)
    return {
        "role": role,
        "kind": child["kind"],
        "cx_norm": round(max(0.0, min(1.0, cx)), 3),
        "cy_norm": round(max(0.0, min(1.0, cy)), 3),
        "width_norm": round(child["width_pt"] / max(container["width_pt"], 1), 3),
        "height_norm": round(child["height_pt"] / max(container["height_pt"], 1), 3),
        "scale_level": child.get("scale_level"),
        "size_pt": child.get("size_pt"),
        "family": child.get("family"),
        "line_count": child.get("line_count"),
        "shape_id": child.get("shape_id"),
        "label": child.get("label"),
        "position_key": _position_key(child["kind"], cx, cy, child.get("scale_level")),
    }


def _infer_slot_role(child: dict, container: dict, title_shape_id) -> str:
    if child["kind"] == "background_image":
        return "background_image"
    if child["kind"] == "icon":
        return "icon"
    if child["kind"] == "image":
        return "image"
    if child.get("shape_id") == title_shape_id:
        return "title"
    if (child.get("line_count") or 1) >= 3:
        return "list"
    if (child.get("size_pt") or 0) >= 18:
        return "title"
    return "description"


def _position_key(kind: str, cx: float, cy: float, scale_level) -> tuple:
    return (
        kind,
        round(cx * SLOT_GRID),
        round(cy * SLOT_GRID),
        scale_level,
    )


def _group_container_instances(
    instances: list[dict],
    slide_width: float,
    slide_height: float,
) -> list[list[dict]]:
    buckets = defaultdict(list)
    for instance in instances:
        signature = (
            round(instance["item_width_pt"] / 12),
            round(instance["item_height_pt"] / 15),
        )
        buckets[signature].append(instance)

    merged = _merge_near_buckets(buckets)
    return [group for group in merged.values() if len(group) >= MIN_GROUP_ITEMS]


def _merge_near_buckets(buckets: dict[tuple[int, int], list[dict]]) -> dict[tuple[int, int], list[dict]]:
    keys = list(buckets)
    parent = {key: key for key in keys}

    def find(key):
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    def union(left, right):
        root_left = find(left)
        root_right = find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for left in keys:
        for right in keys:
            if left >= right:
                continue
            if abs(left[0] - right[0]) <= 1 and abs(left[1] - right[1]) <= 2:
                union(left, right)

    merged = defaultdict(list)
    for key, items in buckets.items():
        merged[find(key)].extend(items)
    return dict(merged)


def _build_component_definition(
    index: int,
    instances: list[dict],
    slide_width: float,
    slide_height: float,
) -> dict | None:
    if len(instances) < MIN_GROUP_ITEMS:
        return None

    slot_clusters = _consolidate_graphic_slots(_cluster_slots(instances), len(instances))
    if not slot_clusters:
        return None

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
            "typography": cluster["typography"],
        }
        if presence >= CORE_THRESHOLD:
            required.append(slot_def)
        elif presence >= OPTIONAL_MIN:
            optional.append(slot_def)

    if not required and not optional:
        return None

    slide_numbers = sorted({item["slide_number"] for item in instances})
    widths = [item["item_width_pt"] for item in instances]
    heights = [item["item_height_pt"] for item in instances]
    layout_counts = Counter(item["layout"] for item in instances)
    name = _component_name(required, optional, instances)

    return {
        "component_id": f"cmp_{index:03d}",
        "name": name,
        "label": name,
        "container": {
            "width_pt": round(median(widths), 2),
            "height_pt": round(median(heights), 2),
            "width_norm": round(median(widths) / slide_width, 4) if widths else None,
            "height_norm": round(median(heights) / slide_height, 4) if heights else None,
        },
        "layout": layout_counts.most_common(1)[0][0],
        "layout_counts": dict(layout_counts),
        "slots": {
            "required": sorted(required, key=lambda item: (item["position"]["cy_norm"], item["position"]["cx_norm"])),
            "optional": sorted(optional, key=lambda item: (-item["presence_ratio"], item["position"]["cy_norm"])),
        },
        "frequency": {
            "instance_count": len(instances),
            "slide_numbers": slide_numbers,
            "slide_count": len(slide_numbers),
        },
        "instances": [
            {
                "slide_number": item["slide_number"],
                "layout": item["layout"],
                "group_index": item["group_index"],
                "container": item["container"],
                "container_norm": item.get("container_norm"),
                "element_ids": item.get("element_ids") or [],
                "topology_fingerprint": item.get("topology_fingerprint"),
                "layout_source": item.get("layout_source"),
                "slot_count": len(item["slots"]),
                "slots": item["slots"],
            }
            for item in instances
        ],
        "detection": {
            "methods": [
                "proximity_cluster",
                "size_alignment",
                "relative_position",
                "typography_level",
                "slot_presence",
            ],
            "core_threshold": CORE_THRESHOLD,
            "optional_min": OPTIONAL_MIN,
        },
    }


def _consolidate_graphic_slots(clusters: list[dict], instance_count: int) -> list[dict]:
    """Merge multiple icon/image slot clusters into one optional/required graphic slot."""
    graphics = [cluster for cluster in clusters if cluster["kind"] in {"icon", "image"}]
    others = [cluster for cluster in clusters if cluster["kind"] not in {"icon", "image"}]
    if len(graphics) <= 1:
        return clusters

    dominant_kind = Counter(cluster["kind"] for cluster in graphics).most_common(1)[0][0]
    presence = max(cluster["presence_count"] for cluster in graphics)
    merged = {
        "slot_id": f"slot_{dominant_kind}_01",
        "role": "icon" if dominant_kind == "icon" else "image",
        "kind": dominant_kind,
        "presence_count": presence,
        "cx_norm": round(median(cluster["cx_norm"] for cluster in graphics), 3),
        "cy_norm": round(median(cluster["cy_norm"] for cluster in graphics), 3),
        "width_norm": round(median(cluster["width_norm"] for cluster in graphics), 3),
        "height_norm": round(median(cluster["height_norm"] for cluster in graphics), 3),
        "typography": {},
    }
    return others + [merged]


def _cluster_slots(instances: list[dict]) -> list[dict]:
    raw_slots = []
    for instance_index, instance in enumerate(instances):
        for slot in instance["slots"]:
            raw_slots.append({**slot, "instance_index": instance_index})

    clusters = []
    used = set()
    for index, slot in enumerate(raw_slots):
        if index in used:
            continue
        cluster_slots = [slot]
        used.add(index)
        for other_index, other in enumerate(raw_slots):
            if other_index in used or slot["instance_index"] == other["instance_index"]:
                continue
            if _slots_match(slot, other):
                cluster_slots.append(other)
                used.add(other_index)

        instance_ids = {item["instance_index"] for item in cluster_slots}
        role = Counter(item["role"] for item in cluster_slots).most_common(1)[0][0]
        kind = Counter(item["kind"] for item in cluster_slots).most_common(1)[0][0]
        slot_index = sum(1 for existing in clusters if existing["role"] == role and existing["kind"] == kind) + 1
        clusters.append({
            "slot_id": f"slot_{role}_{slot_index:02d}",
            "role": role,
            "kind": kind,
            "presence_count": len(instance_ids),
            "cx_norm": round(median(item["cx_norm"] for item in cluster_slots), 3),
            "cy_norm": round(median(item["cy_norm"] for item in cluster_slots), 3),
            "width_norm": round(median(item["width_norm"] for item in cluster_slots), 3),
            "height_norm": round(median(item["height_norm"] for item in cluster_slots), 3),
            "typography": _slot_typography(cluster_slots),
        })
    return clusters


def _slots_match(first: dict, second: dict) -> bool:
    if first["kind"] != second["kind"]:
        return False
    pos_tol = 0.14 if first["kind"] in {"icon", "image"} or second["kind"] in {"icon", "image"} else POSITION_TOLERANCE
    if abs(first["cx_norm"] - second["cx_norm"]) > pos_tol:
        return False
    if abs(first["cy_norm"] - second["cy_norm"]) > pos_tol:
        return False
    if first.get("scale_level") is not None and second.get("scale_level") is not None:
        if first["scale_level"] != second["scale_level"]:
            return False
    if first["role"] == second["role"]:
        return True
    text_roles = {"title", "description", "list"}
    if first["role"] in text_roles and second["role"] in text_roles:
        return True
    return False


def _slot_typography(slots: list[dict]) -> dict:
    families = Counter(item["family"] for item in slots if item.get("family"))
    sizes = Counter(item["size_pt"] for item in slots if item.get("size_pt") is not None)
    scale_levels = Counter(item["scale_level"] for item in slots if item.get("scale_level") is not None)
    return {
        "dominant_family": families.most_common(1)[0][0] if families else None,
        "dominant_size_pt": sizes.most_common(1)[0][0] if sizes else None,
        "dominant_scale_level": scale_levels.most_common(1)[0][0] if scale_levels else None,
    }


def _component_name(required: list[dict], optional: list[dict], instances: list[dict] | None = None) -> str:
    roles = [slot["role"] for slot in required + optional]
    role_set = set(roles)
    instance_roles = set()
    for instance in instances or []:
        instance_roles.update(slot.get("role") for slot in instance.get("slots") or [])
    effective_roles = role_set | instance_roles
    text_body_roles = {"description", "list", "body", "subtitle", "metric"}
    icon_roles = sum(1 for slot in required + optional if slot["role"] in {"icon", "image"})
    if icon_roles >= 2 and (effective_roles & text_body_roles or "title" in effective_roles or "metric" in effective_roles):
        return "CARD"
    if "marker" in effective_roles and (effective_roles & text_body_roles or "title" in effective_roles or "metric" in effective_roles):
        if _instances_have_timeline_step_titles(instances):
            return "TIMELINE_STEP"
        return "MEDIA_CARD"
    if ("title" in effective_roles or "metric" in effective_roles) and effective_roles & text_body_roles:
        if "icon" in effective_roles or "image" in effective_roles:
            return "MEDIA_CARD"
        return "TEXT_BLOCK"
    if "icon" in effective_roles:
        return "ICON_ROW"
    if "background_image" in effective_roles:
        return "MEDIA_CARD"
    if required:
        return required[0]["role"].upper()
    if optional:
        return optional[0]["role"].upper()
    return "COMPONENT"


def _instances_have_timeline_step_titles(instances: list[dict] | None) -> bool:
    if not instances:
        return False
    from .slide_patterns import is_step_label

    step_titles = 0
    title_slots = 0
    for instance in instances:
        for slot in instance.get("slots") or []:
            if slot.get("role") != "title":
                continue
            title_slots += 1
            if is_step_label(slot.get("label"), {"size_pt": slot.get("size_pt")}):
                step_titles += 1
    return title_slots > 0 and step_titles >= max(1, round(title_slots * 0.6))


def _container_area(bbox: dict) -> float:
    return max(bbox.get("width_pt") or 0, 0) * max(bbox.get("height_pt") or 0, 0)


def _bbox_contains(outer: dict, inner: dict) -> bool:
    inner_cx = inner["x_pt"] + inner["width_pt"] / 2
    inner_cy = inner["y_pt"] + inner["height_pt"] / 2
    return (
        outer["x_pt"] <= inner_cx <= outer["x_pt"] + outer["width_pt"]
        and outer["y_pt"] <= inner_cy <= outer["y_pt"] + outer["height_pt"]
    )


def _prune_nested_containers(candidates: list[dict]) -> list[dict]:
    ordered = sorted(candidates, key=lambda item: _container_area(item["bbox"]))
    kept: list[dict] = []
    for candidate in ordered:
        bbox = candidate["bbox"]
        if any(_bbox_contains(other["bbox"], bbox) for other in kept):
            continue
        kept = [other for other in kept if not _bbox_contains(bbox, other["bbox"])]
        kept.append(candidate)
    return kept


def _instance_bbox_key(instance: dict) -> tuple:
    bbox = instance["container"]
    return (
        instance["slide_number"],
        round(bbox["x_pt"]),
        round(bbox["y_pt"]),
        round(bbox["width_pt"] / 4),
        round(bbox["height_pt"] / 4),
    )


def _dedupe_container_instances(instances: list[dict]) -> list[dict]:
    best_by_key: dict[tuple, dict] = {}
    for instance in instances:
        key = _instance_bbox_key(instance)
        current = best_by_key.get(key)
        if current is None:
            best_by_key[key] = instance
            continue
        current_area = _container_area(current["container"])
        next_area = _container_area(instance["container"])
        if next_area < current_area:
            best_by_key[key] = instance
    return list(best_by_key.values())


def _overlap_ratio(first: dict, second: dict) -> float:
    left = max(first["x_pt"], second["x_pt"])
    top = max(first["y_pt"], second["y_pt"])
    right = min(first["x_pt"] + first["width_pt"], second["x_pt"] + second["width_pt"])
    bottom = min(first["y_pt"] + first["height_pt"], second["y_pt"] + second["height_pt"])
    overlap = max(0.0, right - left) * max(0.0, bottom - top)
    area = max(first["width_pt"] * first["height_pt"], 1.0)
    return overlap / area
