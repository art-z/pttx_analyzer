"""Detect slides suitable for the beginning and end of a generated deck."""

from __future__ import annotations

from math import isfinite


SHORT_TEXT_CHARS = 120
DISTINCT_FINAL_SCORE_MARGIN = 25
MAX_MINIMAL_COMPONENTS = 3
PERSON_MARKERS = ("person", "speaker", "author", "profile", "спикер", "персон")
TITLE_ROLES = {"title", "ctrTitle"}
BODY_ROLES = {"body", "subtitle", "content"}


def annotate_terminal_slide_candidates(
    slide_catalog: dict | None,
    typography: dict | None = None,
    slide_templates: dict | None = None,
) -> dict:
    """Score title-bearing slides and annotate the catalog with terminal roles.

    The first slide is the default cover. A distinct final slide is selected only
    when its closing score is materially stronger; otherwise the cover is reused.
    """
    catalog = slide_catalog or {}
    slides = list(catalog.get("slides") or [])
    if not slides:
        result = _empty_result()
        catalog["terminal_candidates"] = result
        _annotate_templates(slide_templates, result)
        return result

    title_shapes = _spatial_title_shapes(typography)
    profiles = {
        item.get("layout_source"): item
        for item in ((slide_templates or {}).get("templates") or [])
        if item.get("layout_source")
    }
    presentation_template_count = len(profiles) or len({
        slide.get("layout_source") for slide in slides if slide.get("layout_source")
    })
    titled = []
    first_order = min(int(slide.get("presentation_order") or slide.get("slide_number") or 0) for slide in slides)
    for slide in slides:
        profile = profiles.get(slide.get("layout_source"))
        title = _find_title(
            slide,
            title_shapes.get(slide.get("slide_number"), set()),
            profile,
            allow_layout_title=(
                int(slide.get("presentation_order") or slide.get("slide_number") or 0) == first_order
            ),
        )
        slide["terminal_roles"] = []
        slide.pop("terminal_candidate", None)
        if not title:
            continue
        titled.append((slide, title, profile))

    if not titled:
        result = _empty_result()
        catalog["terminal_candidates"] = result
        _annotate_templates(slide_templates, result)
        return result

    min_elements = min(_component_count(slide, title) for slide, title, _ in titled)
    last_order = max(
        int(slide.get("presentation_order") or slide.get("slide_number") or 0)
        for slide in slides
    )
    scored = []
    for slide, title, profile in titled:
        item = _score_slide(slide, title, min_elements, last_order, first_order)
        item["text_plan"] = _terminal_text_plan(slide, title, profile, typography)
        scored.append(item)

    eligible = [
        item for item in scored
        if presentation_template_count == 1 or not _is_narrative_template(item, profiles)
    ]
    initial = _rank_distinct_templates(
        [item for item in eligible if item["initial_eligible"]],
        "initial",
    )
    if not initial:
        result = _empty_result()
        catalog["terminal_candidates"] = result
        _annotate_templates(slide_templates, result)
        return result
    preferred_initial = next((item for item in initial if item["presentation_order"] == first_order), initial[0])
    initial = [preferred_initial, *(
        item for item in initial if _template_key(item) != _template_key(preferred_initial)
    )]

    final_ranked = _rank_distinct_templates(
        [item for item in eligible if item["final_eligible"]],
        "final",
    )
    initial_template_final = next((
        item for item in final_ranked
        if _template_key(item) == _template_key(preferred_initial)
    ), preferred_initial)
    distinct_final = next((
        item for item in final_ranked
        if _template_key(item) != _template_key(preferred_initial)
        and ("last_slide" in item["signals"] or "person_component" in item["signals"])
        and item["final_score"] >= initial_template_final["final_score"] + DISTINCT_FINAL_SCORE_MARGIN
    ), None)
    preferred_final = distinct_final or initial_template_final
    final = [preferred_final, *(
        item for item in final_ranked if _template_key(item) != _template_key(preferred_final)
    )]

    initial_numbers = {item["slide_number"] for item in initial}
    final_numbers = {item["slide_number"] for item in final}

    by_number = {item["slide_number"]: item for item in scored}
    for slide in slides:
        number = slide.get("slide_number")
        roles = []
        if number in initial_numbers:
            roles.append("initial")
        if number in final_numbers:
            roles.append("final")
        slide["terminal_roles"] = roles
        if roles:
            item = by_number[number]
            slide["terminal_candidate"] = {
                "initial_score": item["initial_score"],
                "final_score": item["final_score"],
                "reasons": item["signals"],
                "preferred_initial": number == preferred_initial["slide_number"],
                "preferred_final": number == preferred_final["slide_number"],
            }

    result = {
        "initial": [_public_candidate(item, "initial") for item in initial],
        "final": [_public_candidate(item, "final") for item in final],
        "preferred": {
            "initial_slide_number": preferred_initial["slide_number"],
            "final_slide_number": preferred_final["slide_number"],
        },
        "summary": {
            "title_bearing_slide_count": len(titled),
            "initial_candidate_count": len(initial),
            "final_candidate_count": len(final),
            "final_reuses_initial": _template_key(preferred_final) == _template_key(preferred_initial),
        },
    }
    catalog["terminal_candidates"] = result
    catalog.setdefault("summary", {})["terminal_candidate_count"] = len(initial_numbers | final_numbers)
    _ensure_terminal_template_profiles(catalog, slide_templates, result)
    _annotate_templates(slide_templates, result)
    return result


def _empty_result() -> dict:
    return {
        "initial": [],
        "final": [],
        "preferred": {"initial_slide_number": None, "final_slide_number": None},
        "summary": {
            "title_bearing_slide_count": 0,
            "initial_candidate_count": 0,
            "final_candidate_count": 0,
            "final_reuses_initial": True,
        },
    }


def _annotate_templates(slide_templates: dict | None, result: dict) -> None:
    templates = (slide_templates or {}).get("templates") or []
    by_id = {item.get("template_id"): item for item in templates if item.get("template_id")}
    by_layout = {item.get("layout_source"): item for item in templates if item.get("layout_source")}
    preferred = result.get("preferred") or {}
    for template in templates:
        template["terminal_roles"] = []
        template["terminal_candidate_slides"] = {"initial": [], "final": []}
        template["preferred_terminal_roles"] = []
        template["terminal_text_plans"] = {}

    for role in ("initial", "final"):
        preferred_number = preferred.get(f"{role}_slide_number")
        for candidate in result.get(role) or []:
            template = by_id.get(candidate.get("template_id")) or by_layout.get(candidate.get("layout_source"))
            if not template:
                continue
            if role not in template["terminal_roles"]:
                template["terminal_roles"].append(role)
            template["terminal_candidate_slides"][role].append(candidate["slide_number"])
            if candidate["slide_number"] == preferred_number:
                template["preferred_terminal_roles"].append(role)
            template.setdefault("terminal_text_plans", {})[role] = candidate.get("text_plan")


def _ensure_terminal_template_profiles(catalog: dict, slide_templates: dict | None, result: dict) -> None:
    if slide_templates is None:
        return
    templates = slide_templates.setdefault("templates", [])
    known_layouts = {item.get("layout_source") for item in templates}
    slides = catalog.get("slides") or []
    by_number = {item.get("slide_number"): item for item in slides}
    for candidate in [*(result.get("initial") or []), *(result.get("final") or [])]:
        source = by_number.get(candidate.get("slide_number"))
        layout = candidate.get("layout_source")
        if not source or not layout or layout in known_layouts:
            continue
        template_id = f"terminal_bg_{source['slide_number']}"
        same_layout = [item for item in slides if item.get("layout_source") == layout]
        templates.append({
            "template_id": template_id,
            "layout_source": layout,
            "layout_name": source.get("layout_name") or "Фоновый титульный шаблон",
            "layout_file": source.get("layout_file"),
            "slide_numbers": [item.get("slide_number") for item in same_layout],
            "slide_count": len(same_layout),
            "preview_slide": source.get("slide_number"),
            "editable_slots": [],
            "editable_slot_count": 0,
            "capabilities": [],
            "background_only": True,
            "render": source.get("render") or {},
            "colors": {"background": (source.get("render") or {}).get("background_color")},
        })
        for item in same_layout:
            if not item.get("template_id"):
                item["template_id"] = template_id
        known_layouts.add(layout)
    by_layout = {item.get("layout_source"): item for item in templates}
    for candidate in [*(result.get("initial") or []), *(result.get("final") or [])]:
        if not candidate.get("template_id"):
            candidate["template_id"] = (by_layout.get(candidate.get("layout_source")) or {}).get("template_id")
    summary = slide_templates.setdefault("summary", {})
    summary["template_count"] = len(templates)
    summary["layout_count"] = len(templates)


def _spatial_title_shapes(typography: dict | None) -> dict[int, set[str]]:
    result: dict[int, set[str]] = {}
    components = ((typography or {}).get("spatial") or {}).get("components") or []
    title_component = next((item for item in components if item.get("id") == "slide_title"), None)
    for instance in (title_component or {}).get("instances") or []:
        number = instance.get("slide_number")
        shape_id = instance.get("shape_id")
        if number is not None and shape_id is not None:
            result.setdefault(int(number), set()).add(str(shape_id))
    return result


def _find_title(
    slide: dict,
    spatial_shape_ids: set[str],
    template_profile: dict | None = None,
    *,
    allow_layout_title: bool = False,
) -> dict | None:
    texts = [
        element for element in slide.get("content_elements") or []
        if element.get("kind") == "text" and _text(element) and not _is_system_text(element)
    ]
    for element in texts:
        if element.get("placeholder_type") in {"title", "ctrTitle"}:
            return element
        if str(element.get("shape_id")) in spatial_shape_ids:
            return element

    # Some decks use plain text boxes instead of title placeholders. Require a
    # prominent, reasonably short text box so body copy cannot qualify alone.
    candidates = []
    for element in texts:
        box = element.get("geometry_norm") or {}
        size = _number((element.get("typography") or {}).get("size_pt"))
        if size < 24 or len(_text(element)) > 160:
            continue
        if _number(box.get("y")) > 0.48:
            continue
        candidates.append((size, _number(box.get("width")), element))
    if candidates:
        return max(candidates, key=lambda item: (item[0], item[1]))[2]

    # A blank source slide can still be a usable cover: the editable title
    # placeholder belongs to its layout, not to slide content_elements.
    title_slot = next((
        slot for slot in (template_profile or {}).get("editable_slots") or []
        if slot.get("role") in {"title", "ctrTitle"}
    ), None) if allow_layout_title else None
    if title_slot:
        return {
            "kind": "text",
            "placeholder_type": "title",
            "text": "",
            "geometry_norm": title_slot.get("geometry_norm") or {},
            "typography": title_slot.get("typography") or {},
            "_layout_title_slot": True,
        }
    if allow_layout_title and not texts and not any(
        element.get("kind") in {"table", "chart", "diagram"}
        for element in slide.get("content_elements") or []
    ):
        return {
            "kind": "text",
            "placeholder_type": "title",
            "text": "",
            "geometry_norm": _inferred_title_box(slide),
            "typography": {"size_pt": 40},
            "_layout_title_slot": True,
            "_inferred_title_slot": True,
        }
    return None


def _inferred_title_box(slide: dict) -> dict:
    # Blank covers often have no editable placeholders. Keep the source art,
    # but choose the least obstructed title band rather than treating it as
    # an empty, textless layout.
    choices = [
        {"x": .10, "y": .19, "width": .80, "height": .20},
        {"x": .10, "y": .30, "width": .80, "height": .20},
        {"x": .10, "y": .42, "width": .80, "height": .20},
    ]
    obstacles = []
    for element in [*(slide.get("content_elements") or []), *((slide.get("render") or {}).get("layers") or [])]:
        box = element.get("geometry_norm") or {}
        area = _number(box.get("width")) * _number(box.get("height"))
        if area < .003 or area > .75:
            continue
        if element.get("source_scope") and element.get("kind") not in {"image", "text"}:
            continue
        obstacles.append(box)
    def overlap(choice: dict) -> float:
        return sum(
            max(0, min(choice["x"] + choice["width"], _number(box.get("x")) + _number(box.get("width")))
                - max(choice["x"], _number(box.get("x"))))
            * max(0, min(choice["y"] + choice["height"], _number(box.get("y")) + _number(box.get("height")))
                - max(choice["y"], _number(box.get("y"))))
            for box in obstacles
        )
    return min(choices, key=overlap)


def _valid_box(box: dict | None) -> bool:
    return _number((box or {}).get("width")) > .05 and _number((box or {}).get("height")) > .02


def _inferred_body_box(slide: dict, title_box: dict, title_id: object) -> dict | None:
    bottom = _number(title_box.get("y")) + _number(title_box.get("height"))
    available = min(.18, .80 - bottom - .035)
    if available < .06:
        return None
    x = _number(title_box.get("x"))
    width = _number(title_box.get("width"))
    y = bottom + .035
    choices = [
        {"x": x, "y": y, "width": width, "height": available},
        {"x": x, "y": y, "width": width * .62, "height": available},
        {"x": x + width * .38, "y": y, "width": width * .62, "height": available},
    ]
    obstacles = []
    for item in [*(slide.get("content_elements") or []), *((slide.get("render") or {}).get("layers") or [])]:
        if item.get("element_id") == title_id or _is_system_text(item):
            continue
        if item.get("source_scope") and item.get("kind") not in {"image", "text"}:
            continue
        box = item.get("geometry_norm") or {}
        area = _number(box.get("width")) * _number(box.get("height"))
        if .003 <= area <= .75:
            obstacles.append(box)
    def penalty(choice: dict) -> float:
        return sum(
            max(0, min(choice["x"] + choice["width"], _number(box.get("x")) + _number(box.get("width")))
                - max(choice["x"], _number(box.get("x"))))
            * max(0, min(choice["y"] + choice["height"], _number(box.get("y")) + _number(box.get("height")))
                - max(choice["y"], _number(box.get("y"))))
            for box in obstacles
        )
    return min(choices, key=lambda choice: penalty(choice) + (.003 if choice["width"] < width else 0))


def _slot_payload(box: dict, typography: dict | None, size: dict, *, fallback_size: float, cap: int) -> dict:
    font = _number((typography or {}).get("size_pt")) or fallback_size
    width_pt = _number(box.get("width")) * _number(size.get("width"))
    height_pt = _number(box.get("height")) * _number(size.get("height"))
    lines = max(1, int(height_pt / (font * 1.18)))
    chars_per_line = max(1, int(width_pt / (font * .52)))
    return {
        "geometry_norm": box,
        "typography": {**(typography or {}), "size_pt": font},
        "width_pt": round(width_pt),
        "height_pt": round(height_pt),
        "max_lines": lines,
        "max_chars": min(cap, max(8, int(chars_per_line * lines * .78))),
    }


def _terminal_text_plan(slide: dict, title: dict, profile: dict | None, typography: dict | None) -> dict:
    slots = (profile or {}).get("editable_slots") or []
    size = (slide.get("render") or {}).get("slide_size_pt") or (
        (typography or {}).get("visibility") or {}
    ).get("slide_size_pt") or {"width": 960, "height": 540}
    title_slot = next((slot for slot in slots if slot.get("role") in TITLE_ROLES and _valid_box(slot.get("geometry_norm"))), None)
    title_box = title.get("geometry_norm") if _valid_box(title.get("geometry_norm")) else (title_slot or {}).get("geometry_norm")
    if not _valid_box(title_box):
        title_box = _inferred_title_box(slide)
    title_type = title.get("typography") or (title_slot or {}).get("typography") or {}
    if title.get("_inferred_title_slot"):
        global_title = next((item for item in (((typography or {}).get("spatial") or {}).get("components") or [])
                             if item.get("id") == "slide_title"), {})
        global_type = global_title.get("typography") or {}
        title_type = {
            "family": global_type.get("dominant_family") or title_type.get("family"),
            "size_pt": global_type.get("dominant_size_pt") or title_type.get("size_pt") or 40,
        }
    title_plan = _slot_payload(title_box, title_type, size, fallback_size=40, cap=90)
    body_slot = next((slot for slot in slots if slot.get("role") in BODY_ROLES and _valid_box(slot.get("geometry_norm"))), None)
    title_ids = {title.get("element_id")}
    body = next((element for element in slide.get("content_elements") or []
                 if element.get("kind") == "text" and element.get("element_id") not in title_ids
                 and element.get("placeholder_type") in {"body", "subTitle"}
                 and _valid_box(element.get("geometry_norm"))), None)
    body_box = (body or body_slot or {}).get("geometry_norm")
    body_type = (body or body_slot or {}).get("typography") or {}
    if not _valid_box(body_box):
        body_box = _inferred_body_box(slide, title_box, title.get("element_id"))
        body_type = {"family": title_type.get("family"), "size_pt": max(16, min(22, _number(title_type.get("size_pt")) * .5))}
    body_plan = _slot_payload(body_box, body_type, size, fallback_size=18, cap=180) if body_box else None
    return {
        "title": title_plan,
        "text": body_plan,
        "person_supported": _has_renderable_person(slide),
        "title_source": "inferred" if title.get("_inferred_title_slot") else "template",
    }


def _score_slide(slide: dict, title: dict, min_elements: int, last_order: int, first_order: int = 1) -> dict:
    number = int(slide.get("slide_number") or 0)
    order = int(slide.get("presentation_order") or number)
    count = _component_count(slide, title)
    text_chars = sum(len(_text(element)) for element in slide.get("content_elements") or []
                     if element.get("kind") == "text" and not _is_system_text(element))
    non_title_texts = [
        element for element in slide.get("content_elements") or []
        if element.get("kind") == "text" and element is not title and _text(element)
        and not _is_system_text(element)
    ]
    decorations = _background_decoration_count(slide)
    has_person = _has_person_component(slide)
    # Relative minimum alone is too broad in placeholder-heavy decks. Retain
    # the relative comparison only when the slide is genuinely sparse.
    sparse = count == min_elements and count <= MAX_MINIMAL_COMPONENTS
    title_only = not non_title_texts and count <= 2
    short_text = text_chars <= SHORT_TEXT_CHARS
    layout_title_slot = bool(title.get("_layout_title_slot"))

    initial_score = 50
    final_score = 40
    initial_reasons = ["has_title"]
    final_reasons = ["has_title"]
    signals = ["has_title"]

    if order == first_order:
        initial_score += 150
        initial_reasons.append("first_slide")
        signals.append("first_slide")
    if sparse:
        initial_score += 42
        final_score += 38
        initial_reasons.append("minimum_component_count")
        final_reasons.append("minimum_component_count")
        signals.append("minimum_component_count")
    if title_only:
        initial_score += 34
        final_score += 38
        initial_reasons.append("title_only")
        final_reasons.append("title_only")
        signals.append("title_only")
    if short_text:
        initial_score += 18
        final_score += 25
        initial_reasons.append("short_text")
        final_reasons.append("short_text")
        signals.append("short_text")
    if decorations:
        bonus = min(decorations, 4) * 4
        initial_score += bonus
        final_score += bonus
        initial_reasons.append("background_decorations")
        final_reasons.append("background_decorations")
        signals.append("background_decorations")
    if has_person:
        initial_score += 24
        final_score += 32
        initial_reasons.append("person_component")
        final_reasons.append("person_component")
        signals.append("person_component")
    if order == last_order:
        final_score += 30
        final_reasons.append("last_slide")
        signals.append("last_slide")

    if layout_title_slot:
        initial_score += 12
        final_score += 12
        initial_reasons.append("editable_layout_title")
        final_reasons.append("editable_layout_title")
        signals.append("editable_layout_title")

    # A real title is mandatory. At least one additional signal must identify
    # a useful cover/closing layout; ordinary dense content slides are omitted.
    initial_eligible = (
        order == first_order
        or title_only
        or sparse
        or has_person
        or (short_text and decorations > 0)
    )
    final_eligible = (
        title_only
        or sparse
        or has_person
        or (short_text and decorations > 0)
    )

    return {
        "slide_number": number,
        "presentation_order": order,
        "template_id": slide.get("template_id"),
        "layout_source": slide.get("layout_source"),
        "initial_score": initial_score,
        "final_score": final_score,
        "initial_eligible": initial_eligible,
        "final_eligible": final_eligible,
        "initial_reasons": initial_reasons,
        "final_reasons": final_reasons,
        "signals": list(dict.fromkeys(signals)),
        "component_count": count,
        "text_char_count": text_chars,
    }


def _public_candidate(item: dict, role: str) -> dict:
    return {
        "slide_number": item["slide_number"],
        "template_id": item["template_id"],
        "layout_source": item["layout_source"],
        "score": item[f"{role}_score"],
        "reasons": item[f"{role}_reasons"],
        "component_count": item["component_count"],
        "text_char_count": item["text_char_count"],
        "text_plan": item["text_plan"],
    }


def _component_count(slide: dict, title: dict) -> int:
    elements = slide.get("content_elements") or []
    count = sum(1 for element in elements if element is title or _is_substantial(element))
    if title.get("_layout_title_slot"):
        count += 1
    return count


def _template_key(item: dict) -> str:
    return str(item.get("template_id") or item.get("layout_source") or f"slide:{item['slide_number']}")


def _rank_distinct_templates(scored: list[dict], role: str) -> list[dict]:
    score_key = f"{role}_score"
    best_by_template: dict[str, dict] = {}
    for item in scored:
        key = _template_key(item)
        current = best_by_template.get(key)
        rank = (item[score_key], item["presentation_order"] if role == "final" else -item["presentation_order"])
        current_rank = (
            current[score_key],
            current["presentation_order"] if role == "final" else -current["presentation_order"],
        ) if current else None
        if current is None or rank > current_rank:
            best_by_template[key] = item
    return sorted(
        best_by_template.values(),
        key=lambda item: (
            -item[score_key],
            -item["presentation_order"] if role == "final" else item["presentation_order"],
            item["slide_number"],
        ),
    )


def _is_substantial(element: dict) -> bool:
    if element.get("kind") == "text":
        return bool(_text(element)) and not _is_system_text(element)
    box = element.get("geometry_norm") or {}
    area = _number(box.get("width")) * _number(box.get("height"))
    return area >= 0.0025


def _background_decoration_count(slide: dict) -> int:
    layers = (slide.get("render") or {}).get("layers") or []
    return sum(
        1 for layer in layers
        if layer.get("decorative")
        and layer.get("kind") in {"image", "line"}
        and layer.get("source_scope") in {"master", "layout"}
    )


def _is_narrative_template(item: dict, profiles: dict[str, dict]) -> bool:
    profile = profiles.get(item.get("layout_source")) or {}
    roles = {str(role).lower() for role in (profile.get("detected_roles") or [])}
    return bool(roles.intersection({"quote", "snippet"}))


def _has_person_component(slide: dict) -> bool:
    values = []
    for component in slide.get("component_instances") or []:
        values.extend((component.get("name"), component.get("label")))
    for element in slide.get("content_elements") or []:
        ref = element.get("component_ref") or {}
        values.extend((ref.get("name"), ref.get("component_id")))
    haystack = " ".join(str(value).lower() for value in values if value)
    return any(marker in haystack for marker in PERSON_MARKERS)


def _has_renderable_person(slide: dict) -> bool:
    return any(
        component.get("element_ids")
        and any(marker in " ".join(str(component.get(key) or "").lower() for key in ("name", "label", "component_id"))
                for marker in PERSON_MARKERS)
        for component in slide.get("component_instances") or []
    )


def _text(element: dict) -> str:
    return str(element.get("text") or element.get("text_sample") or "").strip()


def _is_system_text(element: dict) -> bool:
    if element.get("placeholder_type") in {"sldNum", "dt", "ftr", "hdr"}:
        return True
    name = str(element.get("name") or element.get("role") or "").lower()
    return "pagination" in name or "slide number" in name


def _number(value: object) -> float:
    try:
        number = float(value or 0)
        return number if isfinite(number) else 0.0
    except (TypeError, ValueError):
        return 0.0
