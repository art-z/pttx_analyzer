"""Detect flow/process diagrams built from connectors, boxes and labels (not SmartArt)."""

from __future__ import annotations

from collections import Counter
from statistics import median
from typing import Any

TITLE_ZONE_MAX_Y = 0.22
MIN_ARROW_LINES = 3
MIN_NODE_BOXES = 2
MIN_CONFIDENCE = 0.62
MIN_NODE_WIDTH_NORM = 0.04
MIN_NODE_HEIGHT_NORM = 0.03
DIAGRAM_TITLE_HINTS = frozenset({
    "схем",
    "diagram",
    "flow",
    "process",
    "блок-схем",
    "block diagram",
})


def apply_diagram_region_inference(slides_catalog: dict | None, slide_size: tuple[float, float] | None) -> None:
    if not slides_catalog or not slide_size:
        return

    slide_width, slide_height = slide_size
    inferred = 0
    for slide in slides_catalog.get("slides") or []:
        result = infer_diagram_region_on_slide(slide, slide_width, slide_height)
        if result:
            slide["inferred_diagram"] = result
            inferred += 1
        elif "inferred_diagram" in slide:
            del slide["inferred_diagram"]

    summary = slides_catalog.setdefault("summary", {})
    summary["inferred_diagram_slides"] = inferred


def infer_diagram_region_on_slide(
    slide: dict[str, Any],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    elements = slide.get("content_elements") or []
    if any(element.get("kind") in {"table", "chart", "diagram"} for element in elements):
        return None

    inferred_chart = slide.get("inferred_chart") or {}
    if inferred_chart and float(inferred_chart.get("confidence") or 0) >= 0.75:
        return None

    return _infer_shape_flow_diagram(slide, elements, slide_width, slide_height)


def apply_flow_diagram_styles_to_baselines(
    catalog: dict[str, Any],
    slides_catalog: dict[str, Any] | None,
) -> None:
    style = extract_deck_flow_diagram_style(slides_catalog)
    if not style:
        return

    for diagram in catalog.get("diagrams") or []:
        if not diagram.get("is_baseline"):
            continue
        if str(diagram.get("diagram_type") or "").lower() not in {"flow", "process"}:
            continue

        tokens = dict(diagram.get("style_tokens") or {})
        tokens.update(style.get("style_tokens") or {})
        diagram["style_tokens"] = tokens
        if style.get("preview_texts"):
            diagram["preview_texts"] = style["preview_texts"]
        if style.get("node_count"):
            diagram["node_count"] = style["node_count"]
        diagram["deck_style_source"] = style.get("source")


def extract_deck_flow_diagram_style(slides_catalog: dict[str, Any] | None) -> dict[str, Any] | None:
    if not slides_catalog:
        return None

    best: dict[str, Any] | None = None
    for slide in slides_catalog.get("slides") or []:
        inferred = slide.get("inferred_diagram") or {}
        if not inferred or str(inferred.get("diagram_type_guess") or "") != "flow":
            continue
        confidence = float(inferred.get("confidence") or 0)
        if confidence < MIN_CONFIDENCE:
            continue
        if best is None or confidence > float(best.get("confidence") or 0):
            best = {
                **inferred,
                "slide_number": slide.get("slide_number"),
            }

    if not best:
        return None

    return {
        "source": {
            "slide_number": best.get("slide_number"),
            "confidence": best.get("confidence"),
        },
        "style_tokens": best.get("style_tokens") or {},
        "preview_texts": best.get("preview_texts") or [],
        "node_count": best.get("node_count") or 0,
        "confidence": best.get("confidence"),
    }


def _infer_shape_flow_diagram(
    slide: dict[str, Any],
    elements: list[dict[str, Any]],
    slide_width: float,
    slide_height: float,
) -> dict[str, Any] | None:
    title_ids = _title_element_ids(slide, elements)
    below_title = [
        element for element in elements
        if element.get("element_id") not in title_ids
        and _center_y(element) >= TITLE_ZONE_MAX_Y
    ]
    if len(below_title) < MIN_ARROW_LINES + MIN_NODE_BOXES:
        return None

    arrow_lines = [element for element in below_title if _is_arrow_connector(element)]
    node_boxes = [element for element in below_title if _is_diagram_node_box(element)]
    if len(arrow_lines) < MIN_ARROW_LINES or len(node_boxes) < MIN_NODE_BOXES:
        return None

    connector_ratio = len(arrow_lines) / max(len(below_title), 1)
    if connector_ratio < 0.15 and len(arrow_lines) < 5:
        return None

    consumed_ids: set[str] = set()
    for element in below_title:
        element_id = element.get("element_id")
        if element_id and element_id not in title_ids:
            consumed_ids.add(element_id)

    node_texts = _node_preview_texts(node_boxes, below_title)
    style_tokens = _flow_style_tokens(arrow_lines, node_boxes, below_title)
    confidence = _flow_confidence(
        slide,
        arrow_lines,
        node_boxes,
        below_title,
        connector_ratio,
    )
    if confidence < MIN_CONFIDENCE:
        return None

    region_norm = _union_norm([element.get("geometry_norm") or {} for element in below_title])
    region_pt = _norm_to_pt(region_norm, slide_width, slide_height)

    return {
        "source": "shape_flow",
        "confidence": round(confidence, 3),
        "diagram_type_guess": "flow",
        "plot_region_norm": region_norm,
        "plot_region_pt": region_pt,
        "node_count": len(node_boxes),
        "node_element_ids": sorted(element["element_id"] for element in node_boxes if element.get("element_id")),
        "preview_texts": node_texts[:8],
        "style_tokens": style_tokens,
        "signals": {
            "arrow_line_count": len(arrow_lines),
            "node_box_count": len(node_boxes),
            "connector_ratio": round(connector_ratio, 3),
            "content_count": len(below_title),
        },
        "consumed_element_ids": sorted(consumed_ids),
    }


def _title_element_ids(slide: dict[str, Any], elements: list[dict[str, Any]]) -> set[str]:
    title_ids: set[str] = set()
    for element in elements:
        if element.get("placeholder_type") in {"title", "ctrTitle"}:
            title_id = element.get("element_id")
            if title_id:
                title_ids.add(title_id)

    top_texts = [
        element for element in elements
        if element.get("kind") == "text"
        and _text_value(element)
        and _center_y(element) <= TITLE_ZONE_MAX_Y
    ]
    if top_texts:
        top_texts.sort(key=lambda item: ((item.get("geometry_norm") or {}).get("y") or 0, -(item.get("typography") or {}).get("size_pt") or 0))
        primary = top_texts[0]
        primary_id = primary.get("element_id")
        if primary_id:
            title_ids.add(primary_id)

        title_text = _text_value(primary).lower()
        if any(hint in title_text for hint in DIAGRAM_TITLE_HINTS):
            for element in top_texts[:1]:
                title_id = element.get("element_id")
                if title_id:
                    title_ids.add(title_id)

    return title_ids


def _is_arrow_connector(element: dict[str, Any]) -> bool:
    if element.get("kind") != "line":
        return False
    stroke = element.get("stroke") or {}
    head = stroke.get("head") or {}
    tail = stroke.get("tail") or {}
    if head.get("type") not in {None, "none"} or tail.get("type") not in {None, "none"}:
        return True
    preset = str((element.get("line") or {}).get("preset") or "").lower()
    return "connector" in preset


def _is_diagram_node_box(element: dict[str, Any]) -> bool:
    if element.get("kind") not in {"fill", "shape"}:
        return False
    geometry = element.get("geometry_norm") or {}
    width = geometry.get("width") or 0
    height = geometry.get("height") or 0
    if width < MIN_NODE_WIDTH_NORM or height < MIN_NODE_HEIGHT_NORM:
        return False
    area = width * height
    if area > 0.25:
        return False
    return True


def _node_preview_texts(node_boxes: list[dict[str, Any]], elements: list[dict[str, Any]]) -> list[str]:
    texts: list[str] = []
    for box in node_boxes:
        box_norm = box.get("geometry_norm") or {}
        for element in elements:
            if element.get("kind") != "text":
                continue
            text = _text_value(element)
            if not text:
                continue
            element_norm = element.get("geometry_norm") or {}
            if _center_in_box(element_norm, box_norm):
                texts.append(text)
                break
    deduped: list[str] = []
    seen: set[str] = set()
    for text in texts:
        key = text.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(text.strip())
    return deduped


def _flow_style_tokens(
    arrow_lines: list[dict[str, Any]],
    node_boxes: list[dict[str, Any]],
    elements: list[dict[str, Any]],
) -> dict[str, Any]:
    connector_stroke = _typical_connector_stroke(arrow_lines)
    node_fill = _typical_node_fill(node_boxes)
    node_border = _typical_node_border(node_boxes)
    node_text = _typical_node_text_style(node_boxes, elements)
    head = connector_stroke.get("head") or {}
    tail = connector_stroke.get("tail") or {}
    return {
        "connector": connector_stroke,
        "node": {
            "fill": node_fill,
            "border": node_border,
            "typography": node_text,
        },
        "arrow": {
            "head_type": head.get("type") or "none",
            "tail_type": tail.get("type") or "triangle",
            "bidirectional": (
                (head.get("type") or "none") != "none"
                and (tail.get("type") or "none") != "none"
            ),
        },
    }


def _typical_connector_stroke(lines: list[dict[str, Any]]) -> dict[str, Any]:
    strokes = [line.get("stroke") or {} for line in lines]
    widths = [float(stroke.get("width_pt")) for stroke in strokes if stroke.get("width_pt")]
    width_pt = median(widths) if widths else 1

    def dominant(key: str, fallback=None):
        values = [stroke.get(key) for stroke in strokes if stroke.get(key) is not None]
        serial = [
            str(value.get("color") or value.get("type") or sorted(value.items()))
            if isinstance(value, dict) else str(value)
            for value in values
        ]
        if not serial:
            return fallback
        winner = Counter(serial).most_common(1)[0][0]
        return next(value for value, marker in zip(values, serial) if marker == winner)

    # Pick both ends as one observed pair. Aggregating head and tail separately can
    # synthesize a double-ended arrow when a few connectors happen to be drawn in
    # the opposite coordinate direction.
    endpoint_pairs = []
    for stroke in strokes:
        head = stroke.get("head") or {"type": "none"}
        tail = stroke.get("tail") or {"type": "none"}
        endpoint_pairs.append((
            str(head.get("type") or "none"),
            str(tail.get("type") or "none"),
            head,
            tail,
        ))
    pair_counts = Counter((head_type, tail_type) for head_type, tail_type, _, _ in endpoint_pairs)
    pair_type = pair_counts.most_common(1)[0][0] if pair_counts else ("none", "none")
    pair = next(
        (item for item in endpoint_pairs if item[:2] == pair_type),
        ("none", "none", {"type": "none"}, {"type": "none"}),
    )

    return {
        "width_pt": round(width_pt, 2),
        "color": dominant("color", {}),
        "dash": dominant("dash", "solid"),
        "cap": dominant("cap", "flat"),
        "head": pair[2],
        "tail": pair[3],
    }


def _typical_node_fill(boxes: list[dict[str, Any]]) -> dict[str, Any] | None:
    fills = [box.get("fill") for box in boxes if box.get("fill")]
    if not fills:
        return None
    keys = [f"{fill.get('kind')}:{fill.get('color')}" for fill in fills]
    winner = Counter(keys).most_common(1)[0][0]
    return next(fill for fill, key in zip(fills, keys) if key == winner)


def _typical_node_border(boxes: list[dict[str, Any]]) -> dict[str, Any] | None:
    strokes = [box.get("stroke") for box in boxes if box.get("stroke")]
    if not strokes:
        return None
    colors = [str((stroke.get("color") or {}).get("color") or stroke.get("color") or "") for stroke in strokes]
    winner = Counter(colors).most_common(1)[0][0]
    matching = [stroke for stroke, color in zip(strokes, colors) if color == winner]
    widths = [float(stroke.get("width_pt")) for stroke in matching if stroke.get("width_pt")]
    sample = matching[0]
    return {
        "color": sample.get("color"),
        "width_pt": round(median(widths), 2) if widths else 1,
        "dash": sample.get("dash") or "solid",
    }


def _typical_node_text_style(
    node_boxes: list[dict[str, Any]],
    elements: list[dict[str, Any]],
) -> dict[str, Any]:
    typographies = []
    for box in node_boxes:
        box_norm = box.get("geometry_norm") or {}
        for element in elements:
            if element.get("kind") != "text":
                continue
            if _center_in_box(element.get("geometry_norm") or {}, box_norm):
                typography = element.get("typography") or {}
                if typography:
                    typographies.append(typography)
    if not typographies:
        return {}

    def dominant(key: str):
        values = [item.get(key) for item in typographies if item.get(key) is not None]
        return Counter(values).most_common(1)[0][0] if values else None

    sizes = [float(item["size_pt"]) for item in typographies if item.get("size_pt") is not None]
    result = {
        "family": dominant("family"),
        "size_pt": round(median(sizes), 2) if sizes else None,
        "bold": dominant("bold"),
        "color": dominant("color"),
        "alignment": dominant("alignment"),
    }
    return {key: value for key, value in result.items() if value is not None}


def _flow_confidence(
    slide: dict[str, Any],
    arrow_lines: list[dict[str, Any]],
    node_boxes: list[dict[str, Any]],
    below_title: list[dict[str, Any]],
    connector_ratio: float,
) -> float:
    score = 0.45
    score += min(0.25, len(arrow_lines) * 0.025)
    score += min(0.15, len(node_boxes) * 0.03)
    score += min(0.15, connector_ratio * 0.5)

    title_text = " ".join(
        _text_value(element)
        for element in slide.get("content_elements") or []
        if _text_value(element) and (_center_y(element) <= TITLE_ZONE_MAX_Y)
    ).lower()
    if any(hint in title_text for hint in DIAGRAM_TITLE_HINTS):
        score += 0.12

    if len(arrow_lines) >= 5 and len(node_boxes) >= 3:
        score += 0.08

    coverage = len(arrow_lines) + len(node_boxes)
    if coverage / max(len(below_title), 1) >= 0.45:
        score += 0.05

    return min(score, 0.99)


def _text_value(element: dict[str, Any]) -> str:
    text = element.get("text") or element.get("text_sample") or ""
    return str(text).strip()


def _center_y(element: dict[str, Any]) -> float:
    geometry = element.get("geometry_norm") or {}
    return (geometry.get("y") or 0) + (geometry.get("height") or 0) / 2


def _center_in_box(inner: dict[str, Any], outer: dict[str, Any]) -> bool:
    cx = (inner.get("x") or 0) + (inner.get("width") or 0) / 2
    cy = (inner.get("y") or 0) + (inner.get("height") or 0) / 2
    return (
        cx >= (outer.get("x") or 0)
        and cx <= (outer.get("x") or 0) + (outer.get("width") or 0)
        and cy >= (outer.get("y") or 0)
        and cy <= (outer.get("y") or 0) + (outer.get("height") or 0)
    )


def _union_norm(boxes: list[dict[str, Any]]) -> dict[str, float]:
    xs = [box.get("x") or 0 for box in boxes if box]
    ys = [box.get("y") or 0 for box in boxes if box]
    xe = [(box.get("x") or 0) + (box.get("width") or 0) for box in boxes if box]
    ye = [(box.get("y") or 0) + (box.get("height") or 0) for box in boxes if box]
    if not xs or not ys:
        return {"x": 0, "y": 0, "width": 1, "height": 1}
    x = min(xs)
    y = min(ys)
    return {
        "x": x,
        "y": y,
        "width": max(xe) - x,
        "height": max(ye) - y,
    }


def _norm_to_pt(box: dict[str, float], slide_width: float, slide_height: float) -> dict[str, float]:
    return {
        "x_pt": (box.get("x") or 0) * slide_width,
        "y_pt": (box.get("y") or 0) * slide_height,
        "width_pt": (box.get("width") or 0) * slide_width,
        "height_pt": (box.get("height") or 0) * slide_height,
    }
