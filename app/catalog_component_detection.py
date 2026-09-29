"""Detect reusable components from restored slide catalog (DOM-like content_elements)."""

from __future__ import annotations

from collections import Counter, defaultdict

from .component_detection import (
    MIN_GROUP_ITEMS,
    SLOT_GRID,
    _build_component_definition,
    _infer_local_layout,
)
from .slide_patterns import (
    _block_from_cluster,
    _blocks_on_slide,
    _content_elements_for_clustering,
    _icon_files,
    _slide_size_pt,
    _slot_role,
    is_icon_asset_sheet,
    is_step_label,
)
from .structure_clustering import (
    MIN_ATOMIC_REPEAT_ON_SLIDE,
    annotate_topology,
    build_variant_groups,
    cluster_instances_by_structure,
)


def detect_catalog_components(
    slide_catalog: dict | None,
    assets: dict | None = None,
    text_blocks: list[dict] | None = None,
) -> dict:
    slides = (slide_catalog or {}).get("slides", [])
    if not slides:
        return {"components": [], "summary": {"component_count": 0, "instance_count": 0}}

    icon_files = _icon_files(assets)
    scale_by_shape = _scale_levels_by_shape(text_blocks)
    container_instances: list[dict] = []

    for slide in slides:
        slide_number = slide["slide_number"]
        slide_size = _slide_size_pt(slide)
        slide_width, slide_height = slide_size
        if not slide_width or not slide_height:
            continue

        elements = _content_elements_for_clustering(slide.get("content_elements") or [], icon_files)
        if is_icon_asset_sheet(elements):
            continue

        blocks = _blocks_on_slide(elements, slide_size)
        covered_element_ids = _element_ids_in_blocks(blocks)

        block_instances: list[dict] = []
        ordered = sorted(blocks, key=lambda item: (item["bbox_norm"]["y"], item["bbox_norm"]["x"]))
        layout_kind = _infer_local_layout_from_blocks(ordered, slide_width, slide_height)
        for index, block in enumerate(ordered, start=1):
            instance = _block_to_component_instance(
                block,
                slide_number,
                layout_kind,
                index,
                scale_by_shape,
            )
            if instance:
                instance["layout_source"] = slide.get("layout_source")
                block_instances.append(instance)

        atomic_instances = _atomic_repeat_instances(
            elements,
            slide_number,
            layout_kind,
            covered_element_ids,
            scale_by_shape,
            slide.get("layout_source"),
        )
        container_instances.extend(block_instances)
        container_instances.extend(atomic_instances)

    if len(container_instances) < MIN_GROUP_ITEMS:
        return {"components": [], "summary": {"component_count": 0, "instance_count": 0}}

    annotate_topology(container_instances)

    slide_width = float((slides[0].get("render") or {}).get("slide_size_pt", {}).get("width") or 960)
    slide_height = float((slides[0].get("render") or {}).get("slide_size_pt", {}).get("height") or 540)

    grouped = cluster_instances_by_structure(container_instances)
    components = []
    for index, group in enumerate(grouped, start=1):
        _assign_layouts(group, slide_width, slide_height)
        component = _build_component_definition(index, group, slide_width, slide_height)
        if not component:
            continue
        component["source"] = "catalog"
        component["variant_signature"] = _primary_variant_signature(group)
        component["variants"] = build_variant_groups(group)
        component["detection"] = {
            "methods": [
                "slide_catalog",
                "structure_repeat",
                "fuzzy_subset_match",
                "slot_presence",
                "slide_max_count",
            ],
            "core_threshold": 0.75,
            "optional_min": 0.25,
            "similarity_threshold": 0.78,
        }
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


def _assign_layouts(group: list[dict], slide_width: float, slide_height: float) -> None:
    per_slide: dict[int, list[dict]] = defaultdict(list)
    for instance in group:
        per_slide[instance["slide_number"]].append(instance)

    for slide_number, slide_instances in per_slide.items():
        ordered = sorted(
            slide_instances,
            key=lambda item: (item["container"]["y_pt"], item["container"]["x_pt"]),
        )
        layout_kind = _infer_local_layout(
            [{"bbox": item["container"]} for item in ordered],
            slide_width,
            slide_height,
        )
        for index, instance in enumerate(ordered, start=1):
            instance["layout"] = layout_kind
            instance["group_index"] = index


def _primary_variant_signature(group: list[dict]) -> str:
    counts = Counter(instance.get("topology_fingerprint") or "" for instance in group)
    return counts.most_common(1)[0][0] if counts else ""


def _element_ids_in_blocks(blocks: list[dict]) -> set[str]:
    covered: set[str] = set()
    for block in blocks:
        for element in block.get("elements") or []:
            element_id = element.get("element_id")
            if element_id:
                covered.add(element_id)
    return covered


def _atomic_repeat_instances(
    elements: list[dict],
    slide_number: int,
    layout: str,
    covered_element_ids: set[str],
    scale_by_shape: dict[tuple[int, int], object],
    layout_source: str | None = None,
) -> list[dict]:
    """Detect repeated atomic icons/images not already part of a richer block."""
    remaining = [
        element
        for element in elements
        if element.get("element_id") not in covered_element_ids
        and element.get("kind") in {"icon", "image"}
    ]
    if len(remaining) < MIN_ATOMIC_REPEAT_ON_SLIDE:
        return []

    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for element in remaining:
        geometry = element.get("geometry_norm") or {}
        key = (
            element.get("kind"),
            round(geometry.get("width") or 0, 3),
            round(geometry.get("height") or 0, 3),
        )
        buckets[key].append(element)

    instances: list[dict] = []
    next_index = 1
    for members in buckets.values():
        if len(members) < MIN_ATOMIC_REPEAT_ON_SLIDE:
            continue
        ordered = sorted(members, key=lambda item: (item["geometry_norm"]["y"], item["geometry_norm"]["x"]))
        for member in ordered:
            block = _block_from_cluster([member])
            instance = _block_to_component_instance(
                block,
                slide_number,
                layout,
                next_index,
                scale_by_shape,
                min_slots=1,
            )
            if instance:
                instance["layout_source"] = layout_source
                instances.append(instance)
                next_index += 1
    return instances


def _scale_levels_by_shape(text_blocks: list[dict] | None) -> dict[tuple[int, int], object]:
    scale_by_shape: dict[tuple[int, int], object] = {}
    for block in text_blocks or []:
        shape_id = block.get("shape_id")
        slide_number = block.get("slide_number")
        if shape_id is None or slide_number is None:
            continue
        scale_by_shape[(slide_number, shape_id)] = block.get("scale_level")
    return scale_by_shape


def _infer_local_layout_from_blocks(blocks: list[dict], slide_width: float, slide_height: float) -> str:
    candidates = []
    for block in blocks:
        bbox = block.get("bbox_pt") or {}
        if not bbox.get("width_pt") or not bbox.get("height_pt"):
            continue
        candidates.append({"bbox": bbox})
    return _infer_local_layout(candidates, slide_width, slide_height)


def _block_to_component_instance(
    block: dict,
    slide_number: int,
    layout: str,
    group_index: int,
    scale_by_shape: dict[tuple[int, int], object],
    min_slots: int = 2,
) -> dict | None:
    container = block.get("bbox_pt") or {}
    if not container.get("width_pt") or not container.get("height_pt"):
        return None

    title_element_id = _pick_title_element_id(block.get("elements") or [])
    slots = []
    for element in sorted(
        block.get("elements") or [],
        key=lambda item: (item["geometry_norm"]["y"], item["geometry_norm"]["x"]),
    ):
        slots.append(_element_to_slot(
            element,
            container,
            title_element_id,
            slide_number,
            scale_by_shape,
        ))

    if len(slots) < min_slots:
        return None

    return {
        "slide_number": slide_number,
        "layout": layout,
        "group_index": group_index,
        "container": container,
        "container_norm": block.get("bbox_norm"),
        "element_ids": [
            element.get("element_id")
            for element in block.get("elements") or []
            if element.get("element_id")
        ],
        "slots": slots,
        "item_width_pt": container["width_pt"],
        "item_height_pt": container["height_pt"],
        "template_id": None,
        "layout_source": None,
    }


def _pick_title_element_id(elements: list[dict]) -> str | None:
    texts = [element for element in elements if element.get("kind") == "text"]
    if not texts:
        return None
    title = max(
        texts,
        key=lambda item: (
            (item.get("typography") or {}).get("size_pt") or 0,
            -item["geometry_norm"]["y"],
            len(item.get("text_sample") or item.get("text") or ""),
        ),
    )
    return title.get("element_id")


def _element_to_slot(
    element: dict,
    container: dict,
    title_element_id: str | None,
    slide_number: int,
    scale_by_shape: dict[tuple[int, int], object],
) -> dict:
    geometry = element.get("geometry_pt") or {}
    cx = (
        (geometry.get("x_pt", 0) + geometry.get("width_pt", 0) / 2 - container["x_pt"])
        / max(container["width_pt"], 1)
    )
    cy = (
        (geometry.get("y_pt", 0) + geometry.get("height_pt", 0) / 2 - container["y_pt"])
        / max(container["height_pt"], 1)
    )
    role = _catalog_slot_role(element, title_element_id)
    kind = element.get("kind") or "content"
    typography = element.get("typography") or {}
    shape_id = element.get("shape_id")
    scale_level = scale_by_shape.get((slide_number, shape_id)) if shape_id is not None else None

    slot = {
        "role": role,
        "kind": kind,
        "cx_norm": round(max(0.0, min(1.0, cx)), 3),
        "cy_norm": round(max(0.0, min(1.0, cy)), 3),
        "width_norm": round(geometry.get("width_pt", 0) / max(container["width_pt"], 1), 3),
        "height_norm": round(geometry.get("height_pt", 0) / max(container["height_pt"], 1), 3),
        "scale_level": scale_level,
        "size_pt": typography.get("size_pt"),
        "family": typography.get("family"),
        "shape_id": shape_id,
        "label": element.get("text_sample") or (element.get("text") or "")[:120] or element.get("asset"),
        "position_key": _position_key(kind, cx, cy, scale_level),
    }
    if element.get("metric"):
        slot["metric"] = element["metric"]
    return slot


def _catalog_slot_role(element: dict, title_element_id: str | None) -> str:
    kind = element.get("kind")
    if kind == "icon":
        return "icon"
    if kind == "image":
        return "image"
    if kind == "fill":
        return "marker"
    if element.get("metric"):
        return "metric"
    if element.get("element_id") == title_element_id:
        return "title"
    if kind == "text":
        placeholder = element.get("placeholder_type")
        if placeholder in {"title", "ctrTitle"}:
            return "title"
        if placeholder == "subTitle":
            return "subtitle"
        sample = element.get("text_sample") or element.get("text") or ""
        if is_step_label(sample, element.get("typography")):
            return "title"
        return _slot_role(element)
    return _slot_role(element)


def _position_key(kind: str, cx: float, cy: float, scale_level) -> tuple:
    return (
        kind,
        round(cx * SLOT_GRID),
        round(cy * SLOT_GRID),
        scale_level,
    )
