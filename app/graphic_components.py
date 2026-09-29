"""Aggregate table/chart/diagram instances into reusable DS component definitions."""

from __future__ import annotations

from collections import defaultdict
from typing import Any


def extract_graphic_components(slides: dict | None) -> dict[str, Any]:
    table_instances: list[dict[str, Any]] = []
    chart_instances: list[dict[str, Any]] = []
    diagram_instances: list[dict[str, Any]] = []

    for slide in (slides or {}).get("slides", []):
        slide_number = slide.get("slide_number")
        template_id = slide.get("template_id")
        for element in slide.get("content_elements") or []:
            kind = element.get("kind")
            if kind == "table":
                table_instances.append(_instance_from_element(slide_number, template_id, element))
            elif kind == "chart":
                chart_instances.append(_instance_from_element(slide_number, template_id, element))
            elif kind == "diagram":
                diagram_instances.append(_instance_from_element(slide_number, template_id, element))

    tables = _cluster_instances("tbl", table_instances, _table_component_payload)
    charts = _cluster_instances("cht", chart_instances, _chart_component_payload)
    diagrams = _cluster_instances("dgm", diagram_instances, _diagram_component_payload)

    return {
        "tables": tables,
        "charts": charts,
        "diagrams": diagrams,
        "summary": {
            "table_component_count": len(tables),
            "chart_component_count": len(charts),
            "diagram_component_count": len(diagrams),
            "table_instance_count": len(table_instances),
            "chart_instance_count": len(chart_instances),
            "diagram_instance_count": len(diagram_instances),
        },
    }


def _instance_from_element(slide_number: int | None, template_id: str | None, element: dict[str, Any]) -> dict[str, Any]:
    component = element.get("component") or {}
    return {
        "slide_number": slide_number,
        "template_id": template_id,
        "element_id": element.get("element_id"),
        "name": element.get("name"),
        "geometry_pt": element.get("geometry_pt") or {},
        "geometry_norm": element.get("geometry_norm") or {},
        "kind": element.get("kind"),
        "component": component,
        "variant_signature": component.get("variant_signature") or element.get("kind") or "graphic",
        "payload": element,
    }


def _cluster_instances(prefix: str, instances: list[dict[str, Any]], payload_builder) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for instance in instances:
        grouped[instance["variant_signature"]].append(instance)

    components: list[dict[str, Any]] = []
    for index, (signature, group) in enumerate(sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0])), start=1):
        first = group[0]["payload"]
        slide_numbers = sorted({item["slide_number"] for item in group if item.get("slide_number") is not None})
        template_ids = sorted({item["template_id"] for item in group if item.get("template_id")})
        component_meta = group[0].get("component") or {}
        components.append({
            "component_id": f"{prefix}_{index:03d}",
            "kind": group[0].get("kind"),
            "slot_role": component_meta.get("slot_role") or group[0].get("kind"),
            "variant_signature": signature,
            "ds_binding": component_meta.get("ds_binding"),
            **payload_builder(first),
            "frequency": {
                "instance_count": len(group),
                "slide_numbers": slide_numbers,
                "template_ids": template_ids,
            },
            "instances": [
                {
                    "slide_number": item.get("slide_number"),
                    "template_id": item.get("template_id"),
                    "element_id": item.get("element_id"),
                    "name": item.get("name"),
                    "geometry_pt": item.get("geometry_pt"),
                    "geometry_norm": item.get("geometry_norm"),
                }
                for item in group
            ],
        })
    return components


def _table_component_payload(element: dict[str, Any]) -> dict[str, Any]:
    table = element.get("table") or {}
    return {
        "structure": table.get("structure") or {},
        "style_tokens": table.get("style_tokens") or {},
        "table_style_id": table.get("table_style_id"),
        "table_source": table.get("source") or "native",
        "column_widths_pt": table.get("column_widths_pt") or [],
        "row_heights_pt": table.get("row_heights_pt") or [],
        "default_size": {
            "rows": element.get("rows"),
            "cols": element.get("cols"),
        },
        "data_preview": table.get("data_preview") or {"rows": element.get("preview") or []},
    }


def _chart_component_payload(element: dict[str, Any]) -> dict[str, Any]:
    chart = element.get("chart") or {}
    return {
        "chart_type": chart.get("type") or element.get("chart_type") or "chart",
        "subtype": chart.get("subtype") or {},
        "style_tokens": chart.get("style_tokens") or {},
        "series_palette": (chart.get("style_tokens") or {}).get("series_palette") or [],
        "series_preview": chart.get("series") or [],
        "categories_preview": chart.get("categories_preview") or [],
    }


def _diagram_component_payload(element: dict[str, Any]) -> dict[str, Any]:
    diagram = element.get("diagram") or {}
    return {
        "diagram_type": diagram.get("diagram_type") or element.get("diagram_type") or "smartart",
        "layout_id": diagram.get("layout_id"),
        "node_count": diagram.get("node_count") or 0,
        "preview_texts": diagram.get("preview_texts") or [],
    }
