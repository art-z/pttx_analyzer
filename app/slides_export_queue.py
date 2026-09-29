"""Export queue for slide content elements (flex stacks for split text groups)."""

from __future__ import annotations

from typing import Any


def build_export_queue(content_elements: list[dict]) -> list[dict[str, Any]]:
    """Mirror frontend buildRenderQueue: merge split text lines into flex_stack items."""
    sorted_elements = sorted(content_elements, key=lambda item: item.get("z_index") or 0)
    rendered_groups: set[str] = set()
    queue: list[dict[str, Any]] = []

    for element in sorted_elements:
        group_id = element.get("text_group_id")
        if group_id:
            if group_id in rendered_groups:
                continue
            rendered_groups.add(group_id)
            members = sorted(
                [item for item in sorted_elements if item.get("text_group_id") == group_id],
                key=lambda item: item.get("text_line_index") or 0,
            )
            queue.append(
                {
                    "kind": "flex_stack",
                    "layout": resolve_flex_stack_direction(members),
                    "members": members,
                    "anchor": element,
                }
            )
            continue
        queue.append({"kind": "element", "element": element})

    return queue


def resolve_flex_stack_direction(members: list[dict]) -> str:
    anchor = members[0] if members else {}
    spacing = anchor.get("text_group_spacing_pt") or {}
    return "row" if spacing.get("flex_stack_direction") == "row" else "column"


def union_geometry_pt(geometries: list[dict | None]) -> dict[str, float]:
    items = [item for item in geometries if item]
    if not items:
        return {"x_pt": 0.0, "y_pt": 0.0, "width_pt": 0.0, "height_pt": 0.0}
    x = min(float(item.get("x_pt") or 0) for item in items)
    y = min(float(item.get("y_pt") or 0) for item in items)
    right = max(float(item.get("x_pt") or 0) + float(item.get("width_pt") or 0) for item in items)
    bottom = max(float(item.get("y_pt") or 0) + float(item.get("height_pt") or 0) for item in items)
    return {
        "x_pt": x,
        "y_pt": y,
        "width_pt": max(0.0, right - x),
        "height_pt": max(0.0, bottom - y),
    }


def stack_geometry_pt(members: list[dict]) -> dict[str, float]:
    anchor = members[0] if members else {}
    group_geometry = anchor.get("text_group_geometry_pt")
    if group_geometry:
        return group_geometry
    return union_geometry_pt([member.get("geometry_pt") for member in members])


def resolve_text_group_line_gap_pt(members: list[dict]) -> float:
    if len(members) < 2:
        return 0.0
    spacing = members[0].get("text_group_spacing_pt") or {}
    gap = spacing.get("item_gap_pt") if resolve_flex_stack_direction(members) == "row" else spacing.get("line_gap_pt")
    if gap is not None:
        return max(0.0, float(gap))
    return 0.0


def flex_stack_uses_compact_display_layout(members: list[dict]) -> bool:
    anchor = members[0] if members else {}
    if not anchor.get("split_from_shape") or len(members) < 2:
        return False
    if anchor.get("vertical_anchor") != "ctr":
        return False
    spacing = anchor.get("text_group_spacing_pt") or {}
    return spacing.get("flex_stack_layout") == "compact_display"


def resolve_flex_stack_body_insets_pt(members: list[dict]) -> dict | None:
    if flex_stack_uses_compact_display_layout(members):
        return None
    anchor = members[0] if members else {}
    return anchor.get("body_insets_pt")


def should_apply_paragraph_spacing_in_flex_stack(member: dict, *, compact_display_layout: bool) -> bool:
    if compact_display_layout:
        return False
    return bool(member.get("split_from_shape"))


def paragraph_spacing_for_flex_stack_item(member: dict, line_index: int = 0) -> dict:
    spacing = dict(member.get("paragraph_spacing_pt") or {})
    if line_index == 0:
        spacing["space_before"] = 0
    return spacing


def export_queue_sort_key(item: dict[str, Any]) -> tuple[int, str]:
    if item.get("kind") == "flex_stack":
        anchor = (item.get("members") or [{}])[0]
        return (
            anchor.get("z_index") or 0,
            anchor.get("element_id") or anchor.get("text_group_id") or "",
        )
    element = item.get("element") or {}
    return (
        element.get("z_index") or 0,
        element.get("element_id") or element.get("layer_id") or "",
    )
