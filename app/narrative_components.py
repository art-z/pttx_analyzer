"""Detect quote and code-snippet components and mark their slide templates."""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Any

DECORATIVE_QUOTE_CHARS = frozenset("«»“”„‟‘’‹›❝❞❮❯〝〞〟＂\"'`")
INLINE_QUOTE_RE = re.compile(
    r"[«»“”„‟❝❞]"
    r"|\"[^\"\n]{8,}\""
)
CODE_SIGNAL_RE = re.compile(
    r"(\{|\};|=>|->|::|#include\b|"
    r"\b(?:function|const|let|var|class|import|return|def|public|void|select|from)\b|"
    r"https?://|(?:padding|margin|font-family|background)\s*:)",
    re.IGNORECASE,
)
MONOSPACE_TOKENS = (
    "consolas",
    "courier",
    "mono",
    "menlo",
    "inconsolata",
    "source code",
    "jetbrains",
    "fira code",
    "dejavu sans mono",
    "liberation mono",
    "roboto mono",
    "ubuntu mono",
    "cascadia",
)
TITLE_PLACEHOLDERS = frozenset({"title", "ctrTitle"})
SYSTEM_PLACEHOLDERS = frozenset({"ftr", "hdr", "dt", "sldNum"})
TYPOGRAPHY_KEYS = ("family", "size_pt", "bold", "italic", "color")

MIN_QUOTE_BODY_CHARS = 12
MIN_INLINE_QUOTE_CHARS = 48
MIN_SNIPPET_CHARS = 40
MIN_SNIPPET_COLORS = 3
MIN_CONTENT_QUOTE_SIZE_PT = 24.0
MIN_CONTENT_QUOTE_HEIGHT = 0.05
MAX_ATTRIBUTION_CHARS = 160


def is_decorative_quote_text(text: str) -> bool:
    """True when the whole string is a quotation glyph, not a page number."""
    raw = (text or "").strip()
    if not raw or len(raw) > 6:
        return False
    if any(char.isdigit() or char == "#" for char in raw):
        return False
    compact = "".join(raw.split())
    return bool(compact) and all(char in DECORATIVE_QUOTE_CHARS for char in compact)


def text_has_inline_quotes(text: str) -> bool:
    return bool(INLINE_QUOTE_RE.search(text or ""))


def apply_narrative_component_inference(
    slides_catalog: dict | None,
    slide_templates: dict | None,
    shell_templates: list[dict] | None = None,
) -> dict[str, Any]:
    slides = list((slides_catalog or {}).get("slides") or [])
    templates = list((slide_templates or {}).get("templates") or [])
    template_by_id = {item.get("template_id"): item for item in templates if item.get("template_id")}

    for template in templates:
        template.pop("detected_roles", None)
    for slide in slides:
        slide.pop("narrative_hits", None)
        for element in slide.get("content_elements") or []:
            element.pop("narrative_role", None)

    decorative_by_template: dict[str, list[dict]] = {}
    for template in templates:
        marks = _marks_from_layers((template.get("render") or {}).get("layers") or [], source="template")
        if marks and template.get("template_id"):
            decorative_by_template[template["template_id"]] = marks

    quote_instances: list[dict[str, Any]] = []
    snippet_instances: list[dict[str, Any]] = []
    roles_by_template: dict[str, set[str]] = defaultdict(set)
    for template_id in decorative_by_template:
        roles_by_template[template_id].add("quote")

    for slide in slides:
        template_id = slide.get("template_id")
        template_marks = list(decorative_by_template.get(template_id) or [])
        if not template_marks:
            template_marks = _marks_from_layers(
                (slide.get("render") or {}).get("layers") or [],
                source="slide_render",
            )
        content_marks = _content_quote_marks(slide)
        marks = template_marks or content_marks

        snippet_groups = _snippet_groups(slide)
        claimed_ids = {element.get("element_id") for members in snippet_groups for element in members}
        for members in snippet_groups:
            instance = _snippet_instance(slide, members)
            if not instance:
                continue
            snippet_instances.append(instance)
            if template_id:
                roles_by_template[template_id].add("snippet")
            for element in members:
                element["narrative_role"] = "snippet"

        quote_instance = _quote_instance(slide, marks, claimed_ids)
        if quote_instance:
            quote_instances.append(quote_instance)
            if template_id:
                roles_by_template[template_id].add("quote")

        hits = []
        if quote_instance:
            hits.append({
                "kind": "quote",
                "element_ids": quote_instance["element_ids"],
                "detection_methods": quote_instance["detection_methods"],
            })
        for instance in snippet_instances:
            if instance.get("slide_number") != slide.get("slide_number"):
                continue
            hits.append({
                "kind": "snippet",
                "element_ids": instance["element_ids"],
                "detection_methods": instance["detection_methods"],
            })
        if hits:
            slide["narrative_hits"] = hits

    for template in templates:
        roles = roles_by_template.get(template.get("template_id"))
        if roles:
            template["detected_roles"] = sorted(roles)
    for shell in shell_templates or []:
        roles = roles_by_template.get(shell.get("template_id"))
        if roles:
            shell["detected_roles"] = sorted(roles)
            profile = shell.get("profile")
            if isinstance(profile, dict):
                profile["detected_roles"] = sorted(roles)

    quotes = _cluster_components("qte", "quote", "Цитата", quote_instances, _quote_style)
    snippets = _cluster_components("snp", "snippet", "Пример кода", snippet_instances, _snippet_style)
    _mark_baseline(quotes)
    _mark_baseline(snippets)

    quote_slides = {item["slide_number"] for item in quote_instances}
    snippet_slides = {item["slide_number"] for item in snippet_instances}
    summary = (slides_catalog or {}).setdefault("summary", {}) if slides_catalog is not None else {}
    if slides_catalog is not None:
        summary["quote_slides"] = len(quote_slides)
        summary["snippet_slides"] = len(snippet_slides)
        summary["quote_template_ids"] = sorted(
            template_id for template_id, roles in roles_by_template.items() if "quote" in roles
        )
        summary["snippet_template_ids"] = sorted(
            template_id for template_id, roles in roles_by_template.items() if "snippet" in roles
        )

    return {
        "quotes": quotes,
        "snippets": snippets,
        "summary": {
            "quote_component_count": len(quotes),
            "snippet_component_count": len(snippets),
            "quote_instance_count": len(quote_instances),
            "snippet_instance_count": len(snippet_instances),
            "quote_template_ids": summary.get("quote_template_ids") or [],
            "snippet_template_ids": summary.get("snippet_template_ids") or [],
        },
    }


def _marks_from_layers(layers: list[dict], *, source: str) -> list[dict[str, Any]]:
    marks = []
    for layer in layers:
        if layer.get("kind") != "text":
            continue
        text = layer.get("text") or ""
        if not is_decorative_quote_text(text):
            continue
        marks.append(_mark_payload(text, layer.get("typography") or {}, layer.get("geometry_norm"), source))
    return marks


def _content_quote_marks(slide: dict) -> list[dict[str, Any]]:
    marks = []
    for element in slide.get("content_elements") or []:
        if element.get("kind") != "text":
            continue
        text = element.get("text") or ""
        if not is_decorative_quote_text(text):
            continue
        size = float((element.get("typography") or {}).get("size_pt") or 0)
        height = float((element.get("geometry_norm") or {}).get("height") or 0)
        if size < MIN_CONTENT_QUOTE_SIZE_PT and height < MIN_CONTENT_QUOTE_HEIGHT and not element.get("decorative"):
            continue
        marks.append(_mark_payload(
            text,
            element.get("typography") or {},
            element.get("geometry_norm"),
            "content",
            element.get("element_id"),
        ))
    return marks


def _mark_payload(
    text: str,
    typography: dict,
    geometry_norm: dict | None,
    source: str,
    element_id: str | None = None,
) -> dict[str, Any]:
    payload = {
        "text": "".join((text or "").split()),
        "source": source,
        "typography": _slim_typography(typography),
        "geometry_norm": geometry_norm,
        "size_pt": float(typography.get("size_pt") or 0),
    }
    if element_id:
        payload["element_id"] = element_id
    return payload


def _snippet_groups(slide: dict) -> list[list[dict]]:
    groups = []
    for members in _text_groups(slide):
        if _is_system_or_title(members):
            continue
        if _is_snippet_group(members):
            groups.append(members)
    return groups


def _is_snippet_group(members: list[dict]) -> bool:
    text = _group_text(members)
    if len(text) < MIN_SNIPPET_CHARS:
        return False
    if len(_group_colors(members)) < MIN_SNIPPET_COLORS:
        return False
    if _is_monospace(_dominant_family(members)):
        return True
    if text.count("\n") < 2:
        return False
    punctuation = sum(text.count(char) for char in "{}();=:")
    if punctuation < 3:
        return False
    return bool(CODE_SIGNAL_RE.search(text))


def _snippet_instance(slide: dict, members: list[dict]) -> dict[str, Any] | None:
    text = _group_text(members)
    colors = _group_colors(members)
    typography = _slim_typography(_dominant_typography(members))
    geometry_norm, geometry_pt = _union_geometry(members)
    if not geometry_norm:
        return None
    return {
        "slide_number": slide.get("slide_number"),
        "template_id": slide.get("template_id"),
        "element_ids": [element.get("element_id") for element in members if element.get("element_id")],
        "detection_methods": ["code_like_multicolor_text"],
        "text": text,
        "preview_text": text[:240],
        "typography": typography,
        "palette": colors,
        "color_count": len(colors),
        "size_pt": float(typography.get("size_pt") or 0),
        "geometry_norm": geometry_norm,
        "geometry_pt": geometry_pt,
        "container": geometry_pt,
        "container_norm": geometry_norm,
    }


def _quote_instance(slide: dict, marks: list[dict], claimed_ids: set) -> dict[str, Any] | None:
    groups = [
        members for members in _text_groups(slide)
        if not _is_system_or_title(members)
        and not any(element.get("element_id") in claimed_ids for element in members)
        and not is_decorative_quote_text(_group_text(members))
    ]
    inline_groups = [members for members in groups if _is_inline_quote_group(members)]
    if not marks and not inline_groups:
        return None

    body = _longest_group(inline_groups or groups)
    if body is None or len(_group_text(body)) < MIN_QUOTE_BODY_CHARS:
        return None

    body_ids = {element.get("element_id") for element in body}
    attribution = _attribution_group(groups, body, body_ids)
    methods = []
    if marks:
        methods.append("decorative_quote_mark")
    if inline_groups and body in inline_groups:
        methods.append("inline_quote_text")
    if not methods:
        methods.append("decorative_quote_mark")

    mark = max(marks, key=lambda item: (item.get("size_pt") or 0, len(item.get("text") or ""))) if marks else None
    body_typography = _slim_typography(_dominant_typography(body))
    attribution_typography = _slim_typography(_dominant_typography(attribution)) if attribution else {}
    geometry_members = list(body)
    if attribution:
        geometry_members.extend(attribution)
    geometry_norm, geometry_pt = _union_geometry(geometry_members)
    element_ids = [element.get("element_id") for element in geometry_members if element.get("element_id")]
    for element in body:
        element["narrative_role"] = "quote_body"
    if attribution:
        for element in attribution:
            element["narrative_role"] = "quote_attribution"

    return {
        "slide_number": slide.get("slide_number"),
        "template_id": slide.get("template_id"),
        "element_ids": element_ids,
        "detection_methods": methods,
        "body_text": _group_text(body),
        "attribution_text": _group_text(attribution) if attribution else "",
        "typography": body_typography,
        "attribution_typography": attribution_typography,
        "mark": _public_mark(mark),
        "size_pt": float(body_typography.get("size_pt") or 0),
        "mark_size_pt": float((mark or {}).get("size_pt") or 0),
        "geometry_norm": geometry_norm,
        "geometry_pt": geometry_pt,
        "container": geometry_pt,
        "container_norm": geometry_norm,
    }


def _is_inline_quote_group(members: list[dict]) -> bool:
    text = _group_text(members)
    return len(text) >= MIN_INLINE_QUOTE_CHARS and text_has_inline_quotes(text)


def _longest_group(groups: list[list[dict]]) -> list[dict] | None:
    eligible = [members for members in groups if len(_group_text(members)) >= MIN_QUOTE_BODY_CHARS]
    if not eligible:
        return None
    return max(eligible, key=lambda members: (len(_group_text(members)), _group_size(members)))


def _attribution_group(groups: list[list[dict]], body: list[dict], body_ids: set) -> list[dict] | None:
    body_box = _union_norm(body)
    if not body_box:
        return None
    body_bottom = body_box["y"] + body_box["height"]
    candidates = []
    for members in groups:
        if any(element.get("element_id") in body_ids for element in members):
            continue
        text = _group_text(members)
        if len(text) < 3 or len(text) > MAX_ATTRIBUTION_CHARS:
            continue
        if re.fullmatch(r"\d{1,3}", text):
            continue
        box = _union_norm(members)
        if not box or box["y"] < body_bottom - 0.02:
            continue
        candidates.append(members)
    if not candidates:
        return None
    return max(candidates, key=lambda members: (_union_norm(members) or {}).get("y") or 0)


def _cluster_components(
    prefix: str,
    kind: str,
    label: str,
    instances: list[dict[str, Any]],
    style_builder,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for instance in instances:
        grouped[_variant_signature(kind, instance)].append(instance)

    components = []
    ordered = sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0]))
    for index, (signature, group) in enumerate(ordered, start=1):
        baseline = _baseline_instance(group)
        slide_numbers = sorted({item["slide_number"] for item in group if item.get("slide_number") is not None})
        template_ids = sorted({item["template_id"] for item in group if item.get("template_id")})
        components.append({
            "component_id": f"{prefix}_{index:03d}",
            "kind": kind,
            "label": label,
            "is_baseline": False,
            "variant_signature": signature,
            "slot_role": kind,
            "style_tokens": style_builder(baseline, group),
            "text_fields": _text_fields(kind, baseline),
            "frequency": {
                "instance_count": len(group),
                "slide_count": len(slide_numbers),
                "slide_numbers": slide_numbers,
                "template_ids": template_ids,
            },
            "instances": [_public_instance(item) for item in group],
        })
    return components


def _variant_signature(kind: str, instance: dict) -> str:
    family = ((instance.get("typography") or {}).get("family") or "").lower()
    if kind == "snippet":
        palette = ",".join(instance.get("palette") or [])
        return f"snippet|{family}|{palette}"
    mark = ((instance.get("mark") or {}).get("text") or "inline")
    return f"quote|{mark}|{family}"


def _baseline_instance(group: list[dict[str, Any]]) -> dict[str, Any]:
    return max(
        group,
        key=lambda item: (
            float(item.get("size_pt") or 0),
            float(item.get("mark_size_pt") or 0),
            int(item.get("color_count") or 0),
            -int(item.get("slide_number") or 0),
        ),
    )


def _mark_baseline(components: list[dict[str, Any]]) -> None:
    if not components:
        return
    winner = max(
        components,
        key=lambda item: (
            float((item.get("style_tokens") or {}).get("baseline_size_pt") or 0),
            item["frequency"]["instance_count"],
        ),
    )
    for component in components:
        component["is_baseline"] = component is winner


def _quote_style(baseline: dict, group: list[dict]) -> dict[str, Any]:
    return {
        "body": baseline.get("typography") or {},
        "attribution": baseline.get("attribution_typography") or None,
        "mark": baseline.get("mark"),
        "baseline_size_pt": baseline.get("size_pt") or 0,
        "size_profiles": _size_profiles(group),
        "detection_methods": sorted({method for item in group for method in item.get("detection_methods") or []}),
    }


def _snippet_style(baseline: dict, group: list[dict]) -> dict[str, Any]:
    return {
        "typography": baseline.get("typography") or {},
        "palette": baseline.get("palette") or [],
        "color_count": baseline.get("color_count") or 0,
        "baseline_size_pt": baseline.get("size_pt") or 0,
        "size_profiles": _size_profiles(group),
        "preview_text": baseline.get("preview_text") or "",
        "detection_methods": ["code_like_multicolor_text"],
    }


def _size_profiles(group: list[dict]) -> list[dict[str, Any]]:
    counts = Counter(round(float(item.get("size_pt") or 0), 2) for item in group)
    return [
        {"size_pt": size, "instance_count": count}
        for size, count in sorted(counts.items(), key=lambda item: (-item[0], -item[1]))
    ]


def _text_fields(kind: str, baseline: dict) -> list[dict[str, Any]]:
    if kind == "snippet":
        return [{
            "field_id": "code",
            "role": "body",
            "required": True,
            "sample_text": baseline.get("preview_text") or "",
            "typography": {
                "dominant_family": (baseline.get("typography") or {}).get("family"),
                "dominant_size_pt": (baseline.get("typography") or {}).get("size_pt"),
            },
        }]
    fields = [{
        "field_id": "body",
        "role": "body",
        "required": True,
        "sample_text": (baseline.get("body_text") or "")[:240],
        "typography": {
            "dominant_family": (baseline.get("typography") or {}).get("family"),
            "dominant_size_pt": (baseline.get("typography") or {}).get("size_pt"),
        },
    }]
    attribution = baseline.get("attribution_text") or ""
    if attribution:
        fields.append({
            "field_id": "attribution",
            "role": "heading",
            "required": False,
            "sample_text": attribution[:240],
            "typography": {
                "dominant_family": (baseline.get("attribution_typography") or {}).get("family"),
                "dominant_size_pt": (baseline.get("attribution_typography") or {}).get("size_pt"),
            },
        })
    return fields


def _public_instance(instance: dict) -> dict[str, Any]:
    return {
        "slide_number": instance.get("slide_number"),
        "template_id": instance.get("template_id"),
        "element_ids": instance.get("element_ids") or [],
        "detection_methods": instance.get("detection_methods") or [],
        "size_pt": instance.get("size_pt"),
        "geometry_norm": instance.get("geometry_norm"),
        "geometry_pt": instance.get("geometry_pt"),
        "container": instance.get("container"),
        "container_norm": instance.get("container_norm"),
        "body_text": instance.get("body_text"),
        "attribution_text": instance.get("attribution_text"),
        "preview_text": instance.get("preview_text"),
        "palette": instance.get("palette"),
        "mark": instance.get("mark"),
    }


def _public_mark(mark: dict | None) -> dict | None:
    if not mark:
        return None
    return {
        "text": mark.get("text"),
        "source": mark.get("source"),
        "typography": mark.get("typography") or {},
        "size_pt": mark.get("size_pt") or 0,
    }


def _text_groups(slide: dict) -> list[list[dict]]:
    grouped: dict[str, list[dict]] = {}
    order: list[str] = []
    for element in slide.get("content_elements") or []:
        if element.get("kind") != "text":
            continue
        if not (element.get("text") or "").strip():
            continue
        key = element.get("text_group_id") or element.get("element_id") or f"text-{len(order)}"
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(element)
    return [grouped[key] for key in order]


def _group_text(members: list[dict]) -> str:
    return "\n".join((element.get("text") or "").strip() for element in members if (element.get("text") or "").strip())


def _group_colors(members: list[dict]) -> list[str]:
    colors: list[str] = []
    seen: set[str] = set()
    for element in members:
        for run in element.get("text_runs") or []:
            if not run.get("text") or not run.get("color"):
                continue
            color = str(run["color"]).upper()
            if color in seen:
                continue
            seen.add(color)
            colors.append(color)
    return colors


def _dominant_typography(members: list[dict]) -> dict:
    if not members:
        return {}
    return max(members, key=lambda element: float((element.get("typography") or {}).get("size_pt") or 0)).get("typography") or {}


def _dominant_family(members: list[dict]) -> str:
    return (_dominant_typography(members).get("family") or "")


def _group_size(members: list[dict]) -> float:
    return float((_dominant_typography(members) or {}).get("size_pt") or 0)


def _is_monospace(family: str) -> bool:
    lowered = (family or "").lower()
    return any(token in lowered for token in MONOSPACE_TOKENS)


def _is_system_or_title(members: list[dict]) -> bool:
    placeholders = {element.get("placeholder_type") for element in members}
    if placeholders and placeholders <= (TITLE_PLACEHOLDERS | SYSTEM_PLACEHOLDERS):
        return True
    return False


def _union_geometry(members: list[dict]) -> tuple[dict | None, dict | None]:
    return _union_norm(members), _union_pt(members)


def _union_norm(members: list[dict]) -> dict | None:
    boxes = [
        element.get("geometry_norm") or {}
        for element in members
        if (element.get("geometry_norm") or {}).get("width") and (element.get("geometry_norm") or {}).get("height")
    ]
    if not boxes:
        return None
    x0 = min(box["x"] for box in boxes)
    y0 = min(box["y"] for box in boxes)
    x1 = max(box["x"] + box["width"] for box in boxes)
    y1 = max(box["y"] + box["height"] for box in boxes)
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


def _union_pt(members: list[dict]) -> dict | None:
    boxes = [
        element.get("geometry_pt") or {}
        for element in members
        if (element.get("geometry_pt") or {}).get("width_pt") and (element.get("geometry_pt") or {}).get("height_pt")
    ]
    if not boxes:
        return None
    x0 = min(box["x_pt"] for box in boxes)
    y0 = min(box["y_pt"] for box in boxes)
    x1 = max(box["x_pt"] + box["width_pt"] for box in boxes)
    y1 = max(box["y_pt"] + box["height_pt"] for box in boxes)
    return {
        "x_pt": x0,
        "y_pt": y0,
        "width_pt": x1 - x0,
        "height_pt": y1 - y0,
    }


def _slim_typography(typography: dict | None) -> dict[str, Any]:
    source = typography or {}
    return {key: source[key] for key in TYPOGRAPHY_KEYS if source.get(key) is not None}
