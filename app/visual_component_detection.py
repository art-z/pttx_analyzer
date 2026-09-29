"""Detect reusable components from repeated visual atoms (topology matching)."""

from __future__ import annotations

from collections import Counter, defaultdict
from statistics import median

from .component_detection import CORE_THRESHOLD, OPTIONAL_MIN, _build_component_definition
from .slide_patterns import (
    _content_elements_for_clustering,
    _icon_files,
    _slide_size_pt,
    is_icon_asset_sheet,
    is_step_label,
)

POSITION_GRID = 8
SIMILARITY_THRESHOLD = 0.82
MIN_CLUSTER_SIZE = 2
MIN_ATOM_CHILDREN = 2
MAX_DESCRIPTION_GAP_NORM = 0.42
COLUMN_MARGIN_RATIO = 0.22
TITLE_ZONE_Y_MAX = 0.19
FOOTER_ZONE_Y_MIN = 0.8
MAX_ICON_COLUMN_TEXT_WIDTH_NORM = 0.24
MAX_ICON_COLUMN_BBOX_WIDTH_NORM = 0.28
MAX_ICON_TEXT_VERTICAL_GAP_NORM = 0.14
ICON_COLUMN_STACK_MAX_GAP_NORM = 0.12
MAX_ICON_COLUMN_HEIGHT_NORM = 0.26
ICON_COLUMN_HORIZONTAL_MARGIN = 0.45
SHARED_CAPTION_ATOM_LIMIT = 2


def detect_visual_components(slide_catalog: dict | None, assets: dict | None = None) -> dict:
    slides = (slide_catalog or {}).get("slides", [])
    if not slides:
        return {"components": [], "summary": {"component_count": 0, "instance_count": 0}}

    icon_files = _icon_files(assets)
    atoms: list[dict] = []
    for slide in slides:
        slide_number = slide["slide_number"]
        elements = _content_elements_for_clustering(slide.get("content_elements") or [], icon_files)
        slide_size = _slide_size_pt(slide)
        slide_width, slide_height = slide_size
        if not slide_width or not slide_height:
            continue
        if is_icon_asset_sheet(elements):
            continue
        for atom in _extract_atoms_from_slide(slide, elements, slide_width, slide_height):
            atom["slide_number"] = slide_number
            atom["template_id"] = slide.get("template_id")
            atom["layout_name"] = slide.get("layout_name")
            atoms.append(atom)

    if len(atoms) < MIN_CLUSTER_SIZE:
        return {"components": [], "summary": {"component_count": 0, "instance_count": 0}}

    clusters = _cluster_atoms(atoms)
    components = []
    slide_width = float((slides[0].get("render") or {}).get("slide_size_pt", {}).get("width") or 960)
    slide_height = float((slides[0].get("render") or {}).get("slide_size_pt", {}).get("height") or 540)

    for cluster in clusters:
        if not _is_valid_visual_cluster(cluster):
            continue
        instances = _cluster_to_instances(cluster, slide_width, slide_height)
        component = _build_component_definition(len(components) + 1, instances, slide_width, slide_height)
        if not component:
            continue
        atom_kind = cluster[0]["atom_kind"]
        component["name"] = _visual_component_name(atom_kind, component)
        component["label"] = component["name"]
        component["detection"] = {
            "methods": [
                "visual_atom",
                "topology_fingerprint",
                "fuzzy_match",
                "column_pairing",
            ],
            "core_threshold": CORE_THRESHOLD,
            "optional_min": OPTIONAL_MIN,
            "similarity_threshold": SIMILARITY_THRESHOLD,
        }
        component["variant_signature"] = _variant_signature(cluster)
        component["variants"] = _variant_groups(cluster)
        components.append(component)

    components.sort(
        key=lambda item: (
            -item["frequency"]["instance_count"],
            -item["frequency"]["slide_count"],
            item["component_id"],
        )
    )
    for index, component in enumerate(components, start=1):
        component["component_id"] = f"cmp_{index:03d}"

    return {
        "components": components,
        "summary": {
            "component_count": len(components),
            "instance_count": sum(item["frequency"]["instance_count"] for item in components),
        },
    }


def merge_component_catalogs(catalog: dict | None, visual: dict | None) -> dict:
    catalog = catalog or {"components": [], "summary": {"component_count": 0, "instance_count": 0}}
    visual = visual or {"components": [], "summary": {"component_count": 0, "instance_count": 0}}

    catalog_components = list(catalog.get("components") or [])
    visual_components = _filter_visual_against_catalog(
        list(visual.get("components") or []),
        catalog_components,
    )
    offset = len(catalog_components)

    for index, component in enumerate(visual_components, start=1):
        component = dict(component)
        component["component_id"] = f"cmp_{offset + index:03d}"
        component["source"] = "visual_atom"
        catalog_components.append(component)

    for component in catalog_components:
        if "source" not in component:
            component["source"] = "catalog"

    instance_count = sum(item["frequency"]["instance_count"] for item in catalog_components)
    return {
        "components": catalog_components,
        "summary": {
            "component_count": len(catalog_components),
            "instance_count": instance_count,
            "catalog_component_count": len(catalog.get("components") or []),
            "visual_component_count": len(visual_components),
            "proximity_component_count": len(catalog.get("components") or []),
        },
    }


def _filter_visual_against_catalog(visual_components: list[dict], catalog_components: list[dict]) -> list[dict]:
    catalog_boxes: list[tuple[int, dict]] = []
    for component in catalog_components:
        for instance in component.get("instances") or []:
            container = instance.get("container") or {}
            slide_number = instance.get("slide_number")
            if slide_number is None or not container.get("width_pt") or not container.get("height_pt"):
                continue
            catalog_boxes.append((slide_number, container))

    if not catalog_boxes:
        return visual_components

    filtered = []
    for component in visual_components:
        if _visual_component_overlaps_catalog(component, catalog_boxes):
            continue
        filtered.append(component)
    return filtered


def _visual_component_overlaps_catalog(component: dict, catalog_boxes: list[tuple[int, dict]]) -> bool:
    name = component.get("name") or ""
    if name not in {"ICON_COLUMN", "MEDIA_CARD", "TEXT_BLOCK", "CARD"}:
        return False

    matched = 0
    total = 0
    for instance in component.get("instances") or []:
        slide_number = instance.get("slide_number")
        container = instance.get("container") or {}
        if slide_number is None or not container.get("width_pt") or not container.get("height_pt"):
            continue
        total += 1
        for catalog_slide, catalog_box in catalog_boxes:
            if catalog_slide != slide_number:
                continue
            if _container_overlap_ratio(container, catalog_box) >= 0.35:
                matched += 1
                break
    return total > 0 and matched / total >= 0.5


def _container_overlap_ratio(left: dict, right: dict) -> float:
    left_right = left["x_pt"] + left["width_pt"]
    left_bottom = left["y_pt"] + left["height_pt"]
    right_right = right["x_pt"] + right["width_pt"]
    right_bottom = right["y_pt"] + right["height_pt"]
    overlap_width = max(0.0, min(left_right, right_right) - max(left["x_pt"], right["x_pt"]))
    overlap_height = max(0.0, min(left_bottom, right_bottom) - max(left["y_pt"], right["y_pt"]))
    if overlap_width <= 0 or overlap_height <= 0:
        return 0.0
    intersection = overlap_width * overlap_height
    smaller_area = min(left["width_pt"] * left["height_pt"], right["width_pt"] * right["height_pt"])
    return intersection / max(smaller_area, 1e-6)


def _extract_atoms_from_slide(
    slide: dict,
    elements: list[dict],
    slide_width: float,
    slide_height: float,
) -> list[dict]:
    atoms: list[dict] = []
    seen_keys: set[tuple] = set()
    slide_number = slide["slide_number"]

    for atom in _extract_numbered_step_atoms(elements):
        key = _atom_key(atom)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        if not _atom_outside_title_zone(atom):
            continue
        atoms.append(atom)

    if not is_icon_asset_sheet(elements):
        icon_column_atoms = _filter_shared_caption_atoms(
            _extract_icon_column_atoms(elements, slide_width, slide_height),
            slide_number,
        )
        for atom in icon_column_atoms:
            key = _atom_key(atom)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            if not _atom_outside_title_zone(atom):
                continue
            if not _is_valid_icon_column_atom(atom):
                continue
            atoms.append(atom)

    return atoms


def _extract_numbered_step_atoms(elements: list[dict]) -> list[dict]:
    texts = [element for element in elements if element["kind"] == "text"]
    fills = [element for element in elements if element["kind"] == "fill"]
    badges = [text for text in texts if is_step_label(_element_text(text), text.get("typography"))]
    if len(badges) < MIN_CLUSTER_SIZE:
        return []

    used_text_ids: set[str | None] = set()
    atoms = []
    for badge in sorted(badges, key=lambda item: (_element_center(item)[1], _element_center(item)[0])):
        badge_id = badge.get("element_id")
        if badge_id in used_text_ids:
            continue
        members = [badge]
        for fill in fills:
            if _overlap_ratio_norm(fill, badge) >= 0.45:
                members.insert(0, fill)
                break

        description = _find_description_below(badge, texts, used_text_ids)
        if description is None:
            continue

        members.append(description)
        used_text_ids.add(badge_id)
        used_text_ids.add(description.get("element_id"))

        if len(members) < MIN_ATOM_CHILDREN:
            continue
        atoms.append(_atom_from_members(members, atom_kind="numbered_step"))
    return atoms


def _extract_icon_column_atoms(
    elements: list[dict],
    slide_width: float,
    slide_height: float,
) -> list[dict]:
    icons = [element for element in elements if element["kind"] == "icon"]
    texts = [element for element in elements if element["kind"] == "text"]
    if len(icons) < MIN_CLUSTER_SIZE or not texts:
        return []

    atoms = []
    for icon in icons:
        members = [icon]
        for text in texts:
            if _icon_text_connected_norm(text, icon):
                members.append(text)
        members = _attach_stacked_text_norm(members, texts)
        if len(members) < MIN_ATOM_CHILDREN:
            continue
        atoms.append(_atom_from_members(members, atom_kind="icon_column"))
    return atoms


def _atom_from_members(members: list[dict], atom_kind: str) -> dict:
    bbox_norm = _union_bbox_norm(members)
    bbox_pt = _union_bbox_pt(members)
    slots = _slots_for_members(members, bbox_norm)
    fingerprint = _topology_fingerprint(atom_kind, slots)
    return {
        "atom_kind": atom_kind,
        "bbox_norm": bbox_norm,
        "bbox_pt": bbox_pt,
        "elements": members,
        "slots": slots,
        "topology_fingerprint": fingerprint,
        "kind_counts": Counter(item["kind"] for item in members),
    }


def _slots_for_members(members: list[dict], bbox_norm: dict) -> list[dict]:
    slots = []
    for member in sorted(members, key=lambda item: (_element_center(item)[1], _element_center(item)[0])):
        geometry = member["geometry_norm"]
        cx, cy = _element_center(member)
        rel_cx = (cx - bbox_norm["x"]) / bbox_norm["width"] if bbox_norm["width"] else 0.5
        rel_cy = (cy - bbox_norm["y"]) / bbox_norm["height"] if bbox_norm["height"] else 0.5
        rel_w = geometry["width"] / bbox_norm["width"] if bbox_norm["width"] else geometry["width"]
        rel_h = geometry["height"] / bbox_norm["height"] if bbox_norm["height"] else geometry["height"]
        slots.append({
            "role": _slot_role(member),
            "kind": member["kind"],
            "cx_norm": round(rel_cx, 4),
            "cy_norm": round(rel_cy, 4),
            "width_norm": round(rel_w, 4),
            "height_norm": round(rel_h, 4),
            "label": _element_text(member),
        })
    return _consolidate_badge_slots(slots)


def _consolidate_badge_slots(slots: list[dict]) -> list[dict]:
    consolidated: list[dict] = []
    consumed = set()

    for index, slot in enumerate(slots):
        if index in consumed:
            continue
        if slot["role"] != "badge_label":
            continue
        merged = dict(slot)
        merged["role"] = "badge"
        merged["kind"] = "badge"
        for other_index, other in enumerate(slots):
            if other_index == index or other_index in consumed:
                continue
            if other["role"] != "badge_fill":
                continue
            if abs(other["cx_norm"] - slot["cx_norm"]) > 0.12 or abs(other["cy_norm"] - slot["cy_norm"]) > 0.12:
                continue
            consumed.add(other_index)
            break
        consolidated.append(merged)
        consumed.add(index)

    for index, slot in enumerate(slots):
        if index in consumed:
            continue
        if slot["role"] == "badge_fill":
            consolidated.append({**slot, "role": "badge", "kind": "badge"})
        else:
            consolidated.append(slot)
        consumed.add(index)

    return consolidated


def _topology_fingerprint(atom_kind: str, slots: list[dict]) -> str:
    role_counts = Counter(slot["role"] for slot in slots)
    role_sig = ",".join(f"{role}:{role_counts[role]}" for role in sorted(role_counts))
    slot_sig = "+".join(
        f"{slot['role']}@{_quantize(slot['cx_norm'])}:{_quantize(slot['cy_norm'])}:"
        f"{_quantize(slot['width_norm'])}:{_quantize(slot['height_norm'])}"
        for slot in sorted(slots, key=lambda item: (item["cy_norm"], item["cx_norm"], item["role"]))
    )
    return f"{atom_kind}|{role_sig}|{slot_sig}"


def _parse_topology_fingerprint(fingerprint: str) -> tuple[str, Counter, list[tuple]]:
    parts = fingerprint.split("|", 2)
    atom_kind = parts[0] if parts else ""
    role_sig = parts[1] if len(parts) > 1 else ""
    slot_sig = parts[2] if len(parts) > 2 else ""
    roles = Counter()
    for chunk in role_sig.split(","):
        if not chunk or ":" not in chunk:
            continue
        role, count = chunk.split(":", 1)
        roles[role] = int(count)
    slots = []
    for chunk in slot_sig.split("+"):
        if not chunk or "@" not in chunk:
            continue
        role, coords = chunk.split("@", 1)
        cx, cy, width, height = coords.split(":")
        slots.append((role, float(cx), float(cy), float(width), float(height)))
    return atom_kind, roles, slots


def _fingerprint_similarity(left: str, right: str) -> float:
    left_kind, left_roles, left_slots = _parse_topology_fingerprint(left)
    right_kind, right_roles, right_slots = _parse_topology_fingerprint(right)
    if left_kind != right_kind:
        return 0.0
    if left_roles != right_roles:
        return 0.0
    if len(left_slots) != len(right_slots):
        return 0.0

    scores = []
    for (left_role, lcx, lcy, lw, lh), (right_role, rcx, rcy, rw, rh) in zip(
        sorted(left_slots),
        sorted(right_slots),
    ):
        if left_role != right_role:
            return 0.0
        position_score = 1.0 - min(1.0, (abs(lcx - rcx) + abs(lcy - rcy)) / 0.5)
        size_score = 1.0 - min(1.0, (abs(lw - rw) + abs(lh - rh)) / 0.75)
        scores.append(position_score * 0.7 + size_score * 0.3)
    return sum(scores) / len(scores) if scores else 0.0


def _atoms_cluster_compatible(left: dict, right: dict) -> bool:
    if left["atom_kind"] != right["atom_kind"]:
        return False
    if left["atom_kind"] == "numbered_step":
        return _cluster_fingerprint(left) == _cluster_fingerprint(right)
    return _fingerprint_similarity(left["topology_fingerprint"], right["topology_fingerprint"]) >= SIMILARITY_THRESHOLD


def _cluster_fingerprint(atom: dict) -> str:
    role_counts = Counter(slot["role"] for slot in atom["slots"])
    role_sig = ",".join(f"{role}:{role_counts[role]}" for role in sorted(role_counts))
    return f"{atom['atom_kind']}|{role_sig}"


def _cluster_atoms(atoms: list[dict]) -> list[list[dict]]:
    parent = list(range(len(atoms)))

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

    for left in range(len(atoms)):
        for right in range(left + 1, len(atoms)):
            if _atoms_cluster_compatible(atoms[left], atoms[right]):
                union(left, right)

    grouped: dict[int, list[dict]] = defaultdict(list)
    for index, atom in enumerate(atoms):
        grouped[find(index)].append(atom)

    clusters = [group for group in grouped.values() if len(group) >= MIN_CLUSTER_SIZE]
    clusters.sort(key=lambda group: (-len(group), group[0]["topology_fingerprint"]))
    return clusters


def _cluster_to_instances(cluster: list[dict], slide_width: float, slide_height: float) -> list[dict]:
    instances = []
    per_slide: dict[int, int] = defaultdict(int)
    for atom in sorted(cluster, key=lambda item: (item["slide_number"], item["bbox_pt"]["y_pt"], item["bbox_pt"]["x_pt"])):
        per_slide[atom["slide_number"]] += 1
        instance = _atom_to_instance(atom, slide_width, slide_height)
        instance["group_index"] = per_slide[atom["slide_number"]]
        slide_atoms = [item for item in cluster if item["slide_number"] == atom["slide_number"]]
        instance["layout"] = _infer_layout(slide_atoms, slide_width, slide_height)
        instances.append(instance)
    return instances


def _visual_component_name(atom_kind: str, component: dict) -> str:
    if atom_kind == "numbered_step":
        return "NUMBERED_STEP"
    if atom_kind == "icon_column":
        return "ICON_COLUMN"
    return component.get("name") or "COMPONENT"


def _atom_to_instance(atom: dict, slide_width: float, slide_height: float) -> dict:
    bbox_pt = atom["bbox_pt"]
    slots = []
    for slot in atom["slots"]:
        slots.append({
            "role": slot["role"],
            "kind": slot["kind"],
            "cx_norm": slot["cx_norm"],
            "cy_norm": slot["cy_norm"],
            "width_norm": slot["width_norm"],
            "height_norm": slot["height_norm"],
            "label": slot.get("label"),
        })

    return {
        "slide_number": atom["slide_number"],
        "layout": "single",
        "group_index": 0,
        "container": bbox_pt,
        "slots": slots,
        "item_width_pt": bbox_pt["width_pt"],
        "item_height_pt": bbox_pt["height_pt"],
        "template_id": atom.get("template_id"),
        "topology_fingerprint": atom["topology_fingerprint"],
        "elements": [
            {
                "element_id": element.get("element_id"),
                "kind": element.get("kind"),
                "geometry_norm": element.get("geometry_norm"),
                "text_sample": _element_text(element)[:120],
            }
            for element in atom.get("elements") or []
        ],
    }


def _infer_layout(atoms: list[dict], slide_width: float, slide_height: float) -> str:
    if len(atoms) < MIN_CLUSTER_SIZE:
        return "single"
    xs = [atom["bbox_pt"]["x_pt"] + atom["bbox_pt"]["width_pt"] / 2 for atom in atoms]
    ys = [atom["bbox_pt"]["y_pt"] + atom["bbox_pt"]["height_pt"] / 2 for atom in atoms]
    x_spread = max(xs) - min(xs)
    y_spread = max(ys) - min(ys)
    if x_spread / slide_width > y_spread / slide_height:
        return "row"
    if y_spread / slide_height > x_spread / slide_width:
        return "column"
    return "row"


def _variant_signature(cluster: list[dict]) -> str:
    fingerprints = sorted({atom["topology_fingerprint"] for atom in cluster})
    if len(fingerprints) == 1:
        return fingerprints[0]
    return fingerprints[0]


def _variant_groups(cluster: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for atom in cluster:
        width_bucket = round(atom["bbox_norm"]["width"], 2)
        height_bucket = round(atom["bbox_norm"]["height"], 2)
        key = f"{atom['topology_fingerprint']}@{width_bucket}x{height_bucket}"
        groups[key].append(atom)

    variants = []
    for index, (signature, items) in enumerate(
        sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])),
        start=1,
    ):
        slide_numbers = sorted({item["slide_number"] for item in items})
        variants.append({
            "variant_id": f"v{index:02d}",
            "signature": signature,
            "instance_count": len(items),
            "slide_numbers": slide_numbers,
            "container": {
                "width_norm": round(median(item["bbox_norm"]["width"] for item in items), 4),
                "height_norm": round(median(item["bbox_norm"]["height"] for item in items), 4),
            },
        })
    return variants


def _find_description_below(
    badge: dict,
    texts: list[dict],
    used_text_ids: set[str | None],
) -> dict | None:
    badge_bottom = badge["geometry_norm"]["y"] + badge["geometry_norm"]["height"]

    best = None
    best_gap = float("inf")
    for text in texts:
        text_id = text.get("element_id")
        if text_id in used_text_ids or text is badge:
            continue
        if _is_badge_number(_element_text(text)):
            continue
        if is_step_label(_element_text(text), text.get("typography")):
            continue
        if not _columns_align(badge, text):
            continue
        text_top = text["geometry_norm"]["y"]
        if text_top + text["geometry_norm"]["height"] < badge["geometry_norm"]["y"] - 0.02:
            continue
        gap = text_top - badge_bottom
        if gap < -0.03 or gap > MAX_DESCRIPTION_GAP_NORM:
            continue
        if gap < best_gap:
            best = text
            best_gap = gap
    return best


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


def _attach_stacked_text_norm(members: list[dict], texts: list[dict]) -> list[dict]:
    result = list(members)
    seen = {item.get("element_id") for item in result if item.get("element_id") is not None}
    icons = [item for item in result if item["kind"] == "icon"]
    anchor_texts = [item for item in result if item["kind"] == "text"]
    if not anchor_texts:
        return result

    anchor = min(anchor_texts, key=lambda item: item["geometry_norm"]["y"])
    if icons:
        icon = min(icons, key=lambda item: item["geometry_norm"]["y"])
        icon_box = icon["geometry_norm"]
        margin = icon_box["width"] * ICON_COLUMN_HORIZONTAL_MARGIN
        column_left = icon_box["x"] - margin
        column_right = icon_box["x"] + icon_box["width"] + margin
    else:
        column_left = anchor["geometry_norm"]["x"] - anchor["geometry_norm"]["width"] * COLUMN_MARGIN_RATIO
        column_right = (
            anchor["geometry_norm"]["x"]
            + anchor["geometry_norm"]["width"] * (1 + COLUMN_MARGIN_RATIO)
        )
    anchor_bottom = max(
        item["geometry_norm"]["y"] + item["geometry_norm"]["height"]
        for item in anchor_texts
    )

    for text in sorted(texts, key=lambda item: item["geometry_norm"]["y"]):
        text_id = text.get("element_id")
        if text_id is not None and text_id in seen:
            continue
        text_center_x = _element_center(text)[0]
        if text_center_x < column_left or text_center_x > column_right:
            continue
        if text["geometry_norm"]["y"] < anchor["geometry_norm"]["y"] - 0.02:
            continue
        if text["geometry_norm"]["y"] - anchor_bottom > ICON_COLUMN_STACK_MAX_GAP_NORM:
            continue
        result.append(text)
        if text_id is not None:
            seen.add(text_id)
        anchor_bottom = max(anchor_bottom, text["geometry_norm"]["y"] + text["geometry_norm"]["height"])
    return result


def _slot_role(element: dict) -> str:
    if element["kind"] == "fill":
        return "badge_fill"
    if element["kind"] in {"icon", "image"}:
        return "icon"
    text = _element_text(element)
    if _is_badge_number(text):
        return "badge_label"
    if is_step_label(text, element.get("typography")):
        return "badge_label"
    if (element.get("typography") or {}).get("size_pt", 0) >= 18:
        return "title"
    return "description"


def _is_badge_number(text: str | None) -> bool:
    value = (text or "").strip()
    return value.isdigit() and 1 <= len(value) <= 2


def _element_text(element: dict) -> str:
    return (element.get("text_sample") or element.get("text") or "").strip()


def _element_center(element: dict) -> tuple[float, float]:
    geometry = element["geometry_norm"]
    return geometry["x"] + geometry["width"] / 2, geometry["y"] + geometry["height"] / 2


def _union_bbox_norm(elements: list[dict]) -> dict:
    left = min(item["geometry_norm"]["x"] for item in elements)
    top = min(item["geometry_norm"]["y"] for item in elements)
    right = max(item["geometry_norm"]["x"] + item["geometry_norm"]["width"] for item in elements)
    bottom = max(item["geometry_norm"]["y"] + item["geometry_norm"]["height"] for item in elements)
    return {
        "x": round(left, 4),
        "y": round(top, 4),
        "width": round(right - left, 4),
        "height": round(bottom - top, 4),
    }


def _union_bbox_pt(elements: list[dict]) -> dict:
    pts = [item.get("geometry_pt") or {} for item in elements]
    left = min(item.get("x_pt", 0) for item in pts)
    top = min(item.get("y_pt", 0) for item in pts)
    right = max(item.get("x_pt", 0) + item.get("width_pt", 0) for item in pts)
    bottom = max(item.get("y_pt", 0) + item.get("height_pt", 0) for item in pts)
    return {
        "x_pt": round(left, 2),
        "y_pt": round(top, 2),
        "width_pt": round(right - left, 2),
        "height_pt": round(bottom - top, 2),
    }


def _overlap_ratio_norm(first: dict, second: dict) -> float:
    a = first["geometry_norm"]
    b = second["geometry_norm"]
    left = max(a["x"], b["x"])
    top = max(a["y"], b["y"])
    right = min(a["x"] + a["width"], b["x"] + b["width"])
    bottom = min(a["y"] + a["height"], b["y"] + b["height"])
    overlap = max(0.0, right - left) * max(0.0, bottom - top)
    area = max(a["width"] * a["height"], 1e-9)
    return overlap / area


def _icon_text_connected_norm(text: dict, icon: dict) -> bool:
    text_box = text["geometry_norm"]
    icon_box = icon["geometry_norm"]
    if text_box["width"] > MAX_ICON_COLUMN_TEXT_WIDTH_NORM:
        return False

    text_center_x = _element_center(text)[0]
    margin = icon_box["width"] * ICON_COLUMN_HORIZONTAL_MARGIN
    icon_left = icon_box["x"] - margin
    icon_right = icon_box["x"] + icon_box["width"] + margin
    if text_center_x < icon_left or text_center_x > icon_right:
        return False

    text_top = text_box["y"]
    text_bottom = text_top + text_box["height"]
    icon_top = icon_box["y"]
    icon_bottom = icon_top + icon_box["height"]
    if text_top >= FOOTER_ZONE_Y_MIN and text_box["width"] > 0.18:
        return False

    if text_top + 0.01 < icon_top:
        return False

    if text_top >= icon_bottom - 0.02 and text_top - icon_bottom <= MAX_ICON_TEXT_VERTICAL_GAP_NORM:
        return True
    return _overlap_ratio_norm(text, icon) >= 0.02


def _is_valid_icon_column_atom(atom: dict) -> bool:
    bbox = atom["bbox_norm"]
    if bbox["width"] > MAX_ICON_COLUMN_BBOX_WIDTH_NORM:
        return False
    if bbox["height"] <= 0:
        return False
    if bbox["height"] > MAX_ICON_COLUMN_HEIGHT_NORM:
        return False
    if bbox["width"] / max(bbox["height"], 1e-6) > 4.5:
        return False

    icons = [element for element in atom["elements"] if element["kind"] == "icon"]
    texts = [element for element in atom["elements"] if element["kind"] == "text"]
    if not icons or not texts:
        return False

    icon = icons[0]
    for text in texts:
        if not _columns_align(icon, text):
            return False
    return True


def _filter_shared_caption_atoms(atoms: list[dict], slide_number: int) -> list[dict]:
    usage: Counter[tuple[int, str | None]] = Counter()
    for atom in atoms:
        for element in atom.get("elements") or []:
            if element.get("kind") != "text":
                continue
            usage[(slide_number, element.get("element_id"))] += 1

    filtered = []
    for atom in atoms:
        text_ids = [
            element.get("element_id")
            for element in atom.get("elements") or []
            if element.get("kind") == "text"
        ]
        if any(usage[(slide_number, text_id)] > SHARED_CAPTION_ATOM_LIMIT for text_id in text_ids):
            continue
        filtered.append(atom)
    return filtered


def _is_valid_visual_cluster(cluster: list[dict]) -> bool:
    atom_kind = cluster[0].get("atom_kind")
    if atom_kind != "icon_column":
        return True

    slide_numbers = {atom.get("slide_number") for atom in cluster}
    if len(slide_numbers) == 1:
        widths = [atom["bbox_norm"]["width"] for atom in cluster]
        if median(widths) > MAX_ICON_COLUMN_BBOX_WIDTH_NORM:
            return False
    return True


def _atom_outside_title_zone(atom: dict) -> bool:
    return atom["bbox_norm"]["y"] >= TITLE_ZONE_Y_MAX


def _atom_key(atom: dict) -> tuple:
    bbox = atom["bbox_norm"]
    return (
        atom.get("slide_number"),
        round(bbox["x"], 3),
        round(bbox["y"], 3),
        round(bbox["width"], 3),
        round(bbox["height"], 3),
        atom["topology_fingerprint"],
    )


def _quantize(value: float, grid: int = POSITION_GRID) -> float:
    return round(value * grid) / grid
