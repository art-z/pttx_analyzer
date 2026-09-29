"""Unified component registry, catalog annotations, and shell template compatibility."""

from __future__ import annotations

from collections import Counter, defaultdict
from statistics import median

from .structure_clustering import role_signature

REPEATABLE_COMPONENT_NAMES = frozenset({
    "MEDIA_CARD",
    "TIMELINE_STEP",
    "ICON_ROW",
    "CARD",
    "IMAGE_BLOCK",
    "SHAPE_BLOCK",
})
CONTENT_REGION_MARGIN = 0.018
SHELL_BOTTOM = 0.96
TITLE_ZONE_MAX_Y = 0.22
PLACEMENT_GRID = 1000


def build_slide_semantics(
    slide_catalog: dict | None,
    slide_templates: dict | None,
    component_catalog: dict | None,
) -> dict:
    slides = list((slide_catalog or {}).get("slides") or [])
    templates = list((slide_templates or {}).get("templates") or [])
    raw_components = list((component_catalog or {}).get("components") or [])

    registry = unify_component_registry(raw_components)
    shell_templates = build_shell_templates(slides, templates, registry)
    annotate_slide_catalog(slides, registry)

    return {
        "slides": slide_catalog,
        "component_registry": registry,
        "shell_templates": shell_templates,
        "summary": {
            "registry_component_count": registry["summary"]["component_count"],
            "registry_instance_count": registry["summary"]["instance_count"],
            "shell_template_count": len(shell_templates),
            "annotated_slides": sum(1 for slide in slides if slide.get("component_instances")),
        },
    }


def unify_component_registry(components: list[dict]) -> dict:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for component in components:
        if not _is_registry_component(component):
            continue
        signature = component.get("variant_signature") or role_signature(
            (component.get("slots") or {}).get("required", [])
            + (component.get("slots") or {}).get("optional", [])
        )
        group_key = component.get("name") or "COMPONENT"
        if group_key not in REPEATABLE_COMPONENT_NAMES:
            group_key = f"{group_key}::{signature}"
        grouped[group_key].append(component)

    unified: list[dict] = []
    for index, group in enumerate(
        sorted(grouped.values(), key=lambda items: (-sum(item["frequency"]["instance_count"] for item in items), items[0]["name"])),
        start=1,
    ):
        merged = _merge_component_group(group, f"reg_{index:03d}")
        if merged:
            unified.append(merged)

    unified.sort(
        key=lambda item: (
            -item["frequency"]["instance_count"],
            -item["frequency"]["slide_count"],
            item["component_id"],
        )
    )
    return {
        "components": unified,
        "summary": {
            "component_count": len(unified),
            "instance_count": sum(item["frequency"]["instance_count"] for item in unified),
        },
    }


def build_shell_templates(
    slides: list[dict],
    layout_templates: list[dict],
    registry: dict,
) -> list[dict]:
    profile_by_layout = {item["layout_source"]: item for item in layout_templates}
    groups: dict[str, list[dict]] = defaultdict(list)
    for slide in slides:
        layout_source = slide.get("layout_source")
        if not layout_source:
            continue
        groups[_render_shell_key(slide)].append(slide)

    shells: list[dict] = []
    for shell_index, group_slides in enumerate(
        sorted(groups.values(), key=lambda items: (-len(items), items[0].get("layout_name") or "")),
        start=1,
    ):
        group_slides.sort(key=lambda item: item["slide_number"])
        layout_source = group_slides[0]["layout_source"]
        profile = profile_by_layout.get(layout_source)
        if not profile:
            continue

        slide_numbers = [slide["slide_number"] for slide in group_slides]
        preview_slide = _pick_preview_slide(group_slides, registry)
        content_region = build_content_region(profile)
        slides_by_number = {slide["slide_number"]: slide for slide in group_slides}
        allowed_components = build_allowed_components(
            registry,
            slide_numbers,
            content_region,
            profile,
            slides_by_number,
        )

        shells.append({
            "shell_id": f"shell_{shell_index:03d}",
            "layout_source": layout_source,
            "layout_name": profile.get("layout_name") or group_slides[0].get("layout_name"),
            "template_id": profile.get("template_id"),
            "slide_numbers": slide_numbers,
            "slide_count": len(slide_numbers),
            "preview_slide": preview_slide["slide_number"],
            "content_region": content_region,
            "render": group_slides[0].get("render") or profile.get("render"),
            "profile": profile,
            "allowed_components": allowed_components,
        })

    return shells


def annotate_slide_catalog(slides: list[dict], registry: dict) -> None:
    slide_map = {slide["slide_number"]: slide for slide in slides}
    for slide in slides:
        slide["component_instances"] = []

    for component in registry.get("components") or []:
        for instance in component.get("instances") or []:
            slide = slide_map.get(instance.get("slide_number"))
            if not slide:
                continue

            container_norm = _instance_container_norm(instance, component)
            repeater_index = instance.get("group_index")
            payload = {
                "component_id": component["component_id"],
                "name": component["name"],
                "label": component.get("label") or component["name"],
                "instance_index": repeater_index,
                "group_index": repeater_index,
                "layout": instance.get("layout"),
                "container_norm": container_norm,
                "element_ids": list(instance.get("element_ids") or []),
            }
            slide["component_instances"].append(payload)

            ref = {
                "component_id": component["component_id"],
                "name": component["name"],
                "instance_index": repeater_index,
                "layout": instance.get("layout"),
            }
            for element in slide.get("content_elements") or []:
                if element.get("element_id") in payload["element_ids"]:
                    element["component_ref"] = ref

    for slide in slides:
        slide["component_instances"].sort(
            key=lambda item: (
                item.get("container_norm", {}).get("y", 0),
                item.get("container_norm", {}).get("x", 0),
                item.get("instance_index") or 0,
            )
        )


def build_content_region(profile: dict) -> dict:
    slots = profile.get("editable_slots") or []
    title_slot = next(
        (slot for slot in slots if slot.get("role") in {"title", "ctrTitle"}),
        slots[0] if slots else None,
    )
    title_box = _geometry_box(title_slot.get("geometry_norm") if title_slot else None)
    y = min(SHELL_BOTTOM - 0.08, title_box["y"] + title_box["height"] + CONTENT_REGION_MARGIN)
    return {
        "x": title_box["x"],
        "y": round(y, 4),
        "width": title_box["width"],
        "height": round(max(0.08, SHELL_BOTTOM - y), 4),
    }


def build_allowed_components(
    registry: dict,
    slide_numbers: set[int] | list[int],
    content_region: dict,
    profile: dict,
    slides_by_number: dict[int, dict] | None = None,
) -> list[dict]:
    slide_set = set(slide_numbers)
    allowed: list[dict] = []
    slide_lookup = slides_by_number or {}

    for component in registry.get("components") or []:
        profile_payload = _component_shell_profile(
            component,
            slide_set,
            content_region,
            slide_lookup,
        )
        if not profile_payload:
            continue
        allowed.append({
            "component_id": component["component_id"],
            "name": component["name"],
            "label": component.get("label") or component["name"],
            "max_count": profile_payload["max_count"],
            "peak_slide_count": profile_payload["peak_slide_count"],
            "placements": profile_payload["placements"],
            "source_slides": profile_payload["source_slides"],
            "repeater": {
                "layout": component.get("layout") or "free",
                "flex_direction": "row" if component.get("layout") == "row" else "column",
            },
            "slots": component.get("slots") or {"required": [], "optional": []},
            "container": component.get("container") or {},
            "component": component,
        })

    allowed.sort(
        key=lambda item: (
            -item["max_count"],
            -len(item["source_slides"]),
            item["name"],
        )
    )
    return allowed


def _component_shell_profile(
    component: dict,
    slide_set: set[int],
    content_region: dict,
    slides_by_number: dict[int, dict],
) -> dict | None:
    placements: list[dict] = []
    seen: set[str] = set()
    per_slide: Counter = Counter()

    for instance in component.get("instances") or []:
        slide_number = instance.get("slide_number")
        if slide_number not in slide_set:
            continue
        box = _instance_container_norm(
            instance,
            component,
            slides_by_number.get(slide_number),
        )
        if not _box_fits_region(box, content_region):
            continue
        key = _placement_key(box)
        if key in seen:
            per_slide[instance["slide_number"]] += 1
            continue
        seen.add(key)
        placements.append(box)
        per_slide[instance["slide_number"]] += 1

    if not placements:
        return None

    peak_slide_count = max(per_slide.values()) if per_slide else 0
    max_count = min(len(placements), peak_slide_count or len(placements))
    if max_count <= 0:
        return None

    placements.sort(key=lambda item: (item["y"], item["x"]))
    return {
        "max_count": max_count,
        "peak_slide_count": peak_slide_count,
        "placements": placements,
        "source_slides": sorted(per_slide.keys()),
    }


def _is_registry_component(component: dict) -> bool:
    name = component.get("name") or ""
    if name in REPEATABLE_COMPONENT_NAMES:
        return True
    required = (component.get("slots") or {}).get("required") or []
    optional = (component.get("slots") or {}).get("optional") or []
    if len(required) + len(optional) < 2:
        return False
    if name == "TEXT_BLOCK" and len(required) <= 1:
        return False
    return component.get("frequency", {}).get("instance_count", 0) >= 2


def _merge_component_group(group: list[dict], component_id: str) -> dict | None:
    if not group:
        return None
    primary = max(group, key=lambda item: item["frequency"]["instance_count"])
    merged = dict(primary)
    merged["component_id"] = component_id
    merged["source_ids"] = sorted({item["component_id"] for item in group})
    merged["sources"] = sorted({item.get("source") or "catalog" for item in group})

    instances: list[dict] = []
    for component in group:
        for instance in component.get("instances") or []:
            instances.append(dict(instance))

    instances.sort(
        key=lambda item: (
            item.get("slide_number") or 0,
            item.get("group_index") or 0,
            item.get("container", {}).get("y_pt") or 0,
        )
    )
    slide_numbers = sorted({item["slide_number"] for item in instances})
    merged["frequency"] = {
        "instance_count": len(instances),
        "slide_count": len(slide_numbers),
        "slide_numbers": slide_numbers,
    }
    merged["instances"] = instances
    return merged


def _render_shell_key(slide: dict) -> str:
    render = slide.get("render") or {}
    layer_key = "|".join(
        ":".join(
            str(part)
            for part in (
                layer.get("kind") or "",
                layer.get("asset") or "",
                *_rounded_geometry(layer.get("geometry_norm") or {}),
            )
        )
        for layer in render.get("layers") or []
    )
    return f"{slide.get('layout_source') or ''}::{render.get('background_color') or ''}::{layer_key}"


def _pick_preview_slide(slides: list[dict], registry: dict) -> dict:
    slide_set = {slide["slide_number"] for slide in slides}
    best = slides[0]
    best_score = -1
    for slide in slides:
        instances = [
            item
            for component in registry.get("components") or []
            for item in component.get("instances") or []
            if item.get("slide_number") == slide["slide_number"]
        ]
        title_elements = [
            element
            for element in slide.get("content_elements") or []
            if element.get("kind") == "text"
            and (element.get("geometry_norm") or {}).get("y", 1) < TITLE_ZONE_MAX_Y
            and not element.get("component_ref")
        ]
        score = len(instances) + (2 if title_elements else 0)
        if score > best_score or (score == best_score and slide["slide_number"] < best["slide_number"]):
            best = slide
            best_score = score
    return best


def _instance_container_norm(instance: dict, component: dict, slide: dict | None = None) -> dict:
    if instance.get("container_norm"):
        return dict(instance["container_norm"])
    container = instance.get("container") or {}
    render = (slide or {}).get("render") or {}
    slide_size = render.get("slide_size_pt") or {}
    slide_width = float(slide_size.get("width") or 960)
    slide_height = float(slide_size.get("height") or 540)
    width_pt = container.get("width_pt") or component.get("container", {}).get("width_pt") or 0
    height_pt = container.get("height_pt") or component.get("container", {}).get("height_pt") or 0
    x_pt = container.get("x_pt") or 0
    y_pt = container.get("y_pt") or 0
    if slide_width <= 0 or slide_height <= 0:
        return {
            "x": component.get("container", {}).get("width_norm") and 0.12 or 0.12,
            "y": 0.2,
            "width": component.get("container", {}).get("width_norm") or 0.35,
            "height": component.get("container", {}).get("height_norm") or 0.22,
        }
    return {
        "x": round(x_pt / slide_width, 4),
        "y": round(y_pt / slide_height, 4),
        "width": round(width_pt / slide_width, 4),
        "height": round(height_pt / slide_height, 4),
    }


def _geometry_box(geometry: dict | None) -> dict:
    geometry = geometry or {}
    return {
        "x": geometry.get("x", 0.056),
        "y": geometry.get("y", 0.101),
        "width": geometry.get("width", 0.89),
        "height": geometry.get("height", 0.094),
    }


def _rounded_geometry(geometry: dict) -> tuple[float, float, float, float]:
    return tuple(round(float(geometry.get(key) or 0), 3) for key in ("x", "y", "width", "height"))


def _box_fits_region(box: dict, region: dict, epsilon: float = 0.004) -> bool:
    return (
        box["x"] >= region["x"] - epsilon
        and box["y"] >= region["y"] - epsilon
        and box["x"] + box["width"] <= region["x"] + region["width"] + epsilon
        and box["y"] + box["height"] <= region["y"] + region["height"] + epsilon
    )


def _placement_key(box: dict) -> str:
    return ":".join(str(round((box.get(key) or 0) * PLACEMENT_GRID) / PLACEMENT_GRID) for key in ("x", "y", "width", "height"))
