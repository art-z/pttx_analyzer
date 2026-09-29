"""Cluster slide blocks by repeatable structure with fuzzy subset matching."""

from __future__ import annotations

from collections import Counter, defaultdict
from statistics import median

POSITION_GRID = 8
SIMILARITY_THRESHOLD = 0.78
POSITION_TOLERANCE = 0.1
GRAPHIC_POSITION_TOLERANCE = 0.16
SIZE_TOLERANCE = 0.18
MIN_CLUSTER_SIZE = 2
MIN_ATOMIC_REPEAT_ON_SLIDE = 2
TEXT_ROLES = frozenset({"title", "subtitle", "description", "body", "list"})


def cluster_instances_by_structure(instances: list[dict]) -> list[list[dict]]:
    if len(instances) < MIN_CLUSTER_SIZE:
        return []

    parent = list(range(len(instances)))

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

    for left in range(len(instances)):
        for right in range(left + 1, len(instances)):
            if instances_structurally_compatible(instances[left], instances[right]):
                union(left, right)

    grouped: dict[int, list[dict]] = defaultdict(list)
    for index, instance in enumerate(instances):
        grouped[find(index)].append(instance)

    clusters = [group for group in grouped.values() if len(group) >= MIN_CLUSTER_SIZE]
    clusters.sort(
        key=lambda group: (
            -len(group),
            -len({item["slide_number"] for item in group}),
            role_signature(group[0].get("slots") or []),
        )
    )
    return clusters


def instances_structurally_compatible(left: dict, right: dict) -> bool:
    if not _container_size_compatible(left, right):
        return False

    left_slots = left.get("slots") or []
    right_slots = right.get("slots") or []
    if not left_slots or not right_slots:
        return False

    smaller, larger = (left_slots, right_slots) if len(left_slots) <= len(right_slots) else (right_slots, left_slots)
    matches = _match_slots(list(smaller), list(larger))
    if len(matches) < len(smaller):
        return False

    scores = [_slot_match_score(pair[0], pair[1]) for pair in matches]
    return sum(scores) / len(scores) >= SIMILARITY_THRESHOLD


def role_signature(slots: list[dict]) -> str:
    role_counts = Counter(f"{slot.get('role') or 'content'}:{slot.get('kind') or 'content'}" for slot in slots)
    return ",".join(f"{key}:{role_counts[key]}" for key in sorted(role_counts))


def topology_fingerprint(instance: dict) -> str:
    slots = instance.get("slots") or []
    role_sig = role_signature(slots)
    slot_sig = "+".join(
        f"{slot.get('role')}:{slot.get('kind')}@{_quantize(slot.get('cx_norm', 0))}:"
        f"{_quantize(slot.get('cy_norm', 0))}:{_quantize(slot.get('width_norm', 0))}:"
        f"{_quantize(slot.get('height_norm', 0))}"
        for slot in sorted(slots, key=lambda item: (item.get("cy_norm", 0), item.get("cx_norm", 0), item.get("role")))
    )
    return f"{role_sig}|{slot_sig}"


def build_variant_groups(instances: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for instance in instances:
        fingerprint = instance.get("topology_fingerprint") or topology_fingerprint(instance)
        width = round((instance.get("container") or {}).get("width_pt") or 0)
        height = round((instance.get("container") or {}).get("height_pt") or 0)
        groups[f"{fingerprint}@{width}x{height}"].append(instance)

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
            "slot_roles": role_signature(items[0].get("slots") or []),
            "container": {
                "width_pt": round(median((item.get("container") or {}).get("width_pt") or 0 for item in items), 2),
                "height_pt": round(median((item.get("container") or {}).get("height_pt") or 0 for item in items), 2),
            },
            "is_primary": index == 1,
        })
    return variants


def annotate_topology(instances: list[dict]) -> None:
    for instance in instances:
        instance["topology_fingerprint"] = topology_fingerprint(instance)
        instance["role_signature"] = role_signature(instance.get("slots") or [])


def _container_size_compatible(left: dict, right: dict) -> bool:
    left_box = left.get("container") or {}
    right_box = right.get("container") or {}
    left_w = left_box.get("width_pt") or 0
    left_h = left_box.get("height_pt") or 0
    right_w = right_box.get("width_pt") or 0
    right_h = right_box.get("height_pt") or 0
    if not left_w or not left_h or not right_w or not right_h:
        return True
    width_ratio = min(left_w, right_w) / max(left_w, right_w)
    height_ratio = min(left_h, right_h) / max(left_h, right_h)
    return width_ratio >= (1 - SIZE_TOLERANCE) and height_ratio >= (1 - SIZE_TOLERANCE)


def _match_slots(smaller: list[dict], larger: list[dict]) -> list[tuple[dict, dict]]:
    remaining = list(larger)
    matches: list[tuple[dict, dict]] = []
    for slot in smaller:
        best_index = None
        best_score = 0.0
        for index, candidate in enumerate(remaining):
            if not _roles_compatible(slot, candidate):
                continue
            score = _slot_match_score(slot, candidate)
            if score > best_score:
                best_score = score
                best_index = index
        if best_index is None or best_score < 0.65:
            continue
        matches.append((slot, remaining.pop(best_index)))
    return matches


def _roles_compatible(left: dict, right: dict) -> bool:
    left_role = left.get("role")
    right_role = right.get("role")
    if left_role == right_role:
        return True
    if left_role in TEXT_ROLES and right_role in TEXT_ROLES:
        return True
    left_kind = left.get("kind")
    right_kind = right.get("kind")
    if left_kind == right_kind and left_kind in {"icon", "image"}:
        return True
    return False


def _slot_match_score(left: dict, right: dict) -> float:
    pos_tol = GRAPHIC_POSITION_TOLERANCE if left.get("kind") in {"icon", "image"} or right.get("kind") in {"icon", "image"} else POSITION_TOLERANCE
    position_score = 1.0 - min(
        1.0,
        (abs(left.get("cx_norm", 0) - right.get("cx_norm", 0)) + abs(left.get("cy_norm", 0) - right.get("cy_norm", 0)))
        / max(pos_tol * 2, 0.01),
    )
    size_score = 1.0 - min(
        1.0,
        (abs(left.get("width_norm", 0) - right.get("width_norm", 0)) + abs(left.get("height_norm", 0) - right.get("height_norm", 0)))
        / 0.8,
    )
    return position_score * 0.75 + size_score * 0.25


def _quantize(value: float, grid: int = POSITION_GRID) -> float:
    return round(float(value or 0) * grid) / grid
