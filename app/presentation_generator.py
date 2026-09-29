import json
import re
from typing import Any

from .llm_client import LLMError, complete, extract_json_payload
from .llm_usage import JobLLMUsage
from .prompts_loader import load_prompt

CONTEXT_KEYS = (
    "paragraphs", "metrics", "cards", "lists", "timelines", "icon_lists",
    "tables", "charts", "diagrams", "persons", "quotes", "snippets", "images",
)
INTENT_REQUIREMENTS = {
    "metrics": ("metrics",),
    "features": ("cards",),
    "process": ("diagrams",),
    "workflow": ("diagrams",),
    "architecture": ("diagrams",),
    "comparison": ("tables",),
    "table": ("tables",),
    "timeline": ("timelines",),
    "roadmap": ("timelines",),
    "quote": ("quotes",),
    "team": ("persons",),
}
INTENT_MIN_COUNTS = {"metrics": 3, "features": 4, "team": 2}
MIN_DENSE_CONTEXT_TYPES = 3
LIGHTWEIGHT_INTENTS = {"title", "section"}
DECK_COVERAGE_MIN_SLIDES = 6
MIN_METRIC_SLIDES = 1
MIN_TABLE_SLIDES = 1
MIN_BAR_CHART_SLIDES = 1
MAX_SLIDE_TITLE_CHARS = 72
MAX_METRIC_VALUE_CHARS = 8
MAX_METRIC_UNIT_CHARS = 6
METRIC_VALUE_RE = re.compile(r"^[+\-]?(?:\d[\d\s]*(?:[.,]\d+)?|[.,]\d+)$")
METRIC_UNIT_RE = re.compile(r"^(?:%|‰|°|℃|℉|×|x|X|[₽$€£]|[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё.\-/]{0,11})$")
LIST_HEADING_RE = re.compile(r"^\d{1,3}[.)]?$")
TIMELINE_HEADING_RE = re.compile(
    r"(?:"
    r"(?:^|[^\d])(?:18|19|20|21)\d{2}(?:[^\d]|$)"
    r"|^(?:q[1-4]|[1-4]\s*кв(?:артал)?)$"
    r"|^(?:январ|феврал|март|апрел|ма|июн|июл|август|сентябр|октябр|ноябр|декабр)[ьяейта]*$"
    r"|^\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?$"
    r")",
    re.IGNORECASE,
)


def _first_text(item: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = str(item.get(key) or "").strip()
        if value:
            return value
    return ""


def _normalize_heading_body_item(item: Any, block: str) -> dict[str, str]:
    if not isinstance(item, dict):
        value = str(item or "").strip()
        return {
            "heading": value if block == "lists" else "",
            "body": "" if block == "lists" else value,
        }

    if block == "persons":
        heading = _first_text(item, "heading", "name", "title")
        body_parts = [
            value for value in (
                _first_text(item, "body", "bio", "description"),
                _first_text(item, "text"),
            ) if value
        ]
        body = " — ".join(dict.fromkeys(body_parts))
    elif block == "quotes":
        heading = _first_text(item, "heading", "title")
        body = _first_text(item, "body", "text", "quote")
    else:
        heading = _first_text(item, "heading", "title", "name", "label")
        body = _first_text(item, "body", "text", "description", "bio", "caption")

    return {"heading": heading, "body": body}


def _repeat_context_block(item: dict[str, str]) -> str:
    heading = item["heading"].strip()
    if not heading:
        return "icon_lists"
    if TIMELINE_HEADING_RE.search(heading):
        return "timelines"
    if LIST_HEADING_RE.fullmatch(heading):
        return "lists"
    return "cards"


def normalize_presentation_contract(presentation: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(presentation or {})
    slides = []
    for position, raw_slide in enumerate(normalized.get("slides") or [], start=1):
        slide = dict(raw_slide) if isinstance(raw_slide, dict) else {"text": str(raw_slide or "")}
        raw_context = slide.get("context")
        context = dict(raw_context) if isinstance(raw_context, dict) else {}
        if isinstance(raw_context, list):
            for item in raw_context:
                if isinstance(item, dict):
                    for key in CONTEXT_KEYS:
                        if key in item:
                            values = item[key]
                            context.setdefault(key, []).extend(values if isinstance(values, list) else [values])
                    if not any(key in item for key in CONTEXT_KEYS):
                        context.setdefault("paragraphs", []).append(item)
                elif item:
                    context.setdefault("paragraphs", []).append({"body": str(item)})
        for key in CONTEXT_KEYS:
            value = context.get(key, slide.get(key, []))
            context[key] = value if isinstance(value, list) else []
        # Structured blocks are expected to contain objects.
        # Keep the first LLM response, but silently discard malformed scalar
        # items so downstream validation/rendering cannot crash on `.get()`.
        for key in ("metrics", "charts", "tables", "diagrams", "snippets", "images"):
            context[key] = [item for item in context[key] if isinstance(item, dict)]
        for key in ("paragraphs", "cards", "lists", "timelines", "icon_lists", "persons", "quotes"):
            context[key] = [
                _normalize_heading_body_item(item, key)
                for item in context[key]
            ]
        repeat_items = {
            "cards": list(context["cards"]),
            "lists": [],
            "timelines": list(context["timelines"]),
            "icon_lists": list(context["icon_lists"]),
        }
        for item in context["lists"]:
            repeat_items[_repeat_context_block(item)].append(item)
        context.update(repeat_items)
        slide["index"] = slide.get("index") or position
        slide["intent"] = str(slide.get("intent") or "content").lower()
        slide["purpose"] = str(slide.get("purpose") or "")
        title = slide.get("title")
        options = title if isinstance(title, dict) else slide.get("title_options") or slide.get("title_variants")
        if isinstance(options, dict):
            options = {
                "short": str(options.get("short") or "").strip(),
                "middle": str(options.get("middle") or options.get("medium") or "").strip(),
                "long": str(options.get("long") or "").strip(),
            }
            fallback = next((value for value in options.values() if value), "")
            slide["title_options"] = {key: value or fallback for key, value in options.items()}
            slide["title"] = slide["title_options"]["middle"]
        else:
            slide["title"] = str(title or "")
        slide["text"] = str(slide.get("text") or "")
        slide["context"] = context
        slides.append(slide)
    normalized["slides"] = slides
    normalized["title"] = str(normalized.get("title") or "Presentation")
    normalized["goal"] = str(normalized.get("goal") or "")
    normalized["audience"] = str(normalized.get("audience") or "")
    return normalized


CIRCULAR_CHART_TYPES = frozenset({"pie", "doughnut"})
SHARE_SUM_TOLERANCE = 0.5


def _valid_share_values(values: list[Any]) -> bool:
    """Pie/doughnut values are parts of one whole: positive percents summing to 100."""
    return bool(values) and all(value > 0 for value in values) and abs(sum(values) - 100) <= SHARE_SUM_TOLERANCE


def _available_visual_families(report: dict[str, Any] | None) -> set[str]:
    if not report:
        return set()
    graphic = report.get("graphic_components") or {}
    families = set()
    if any(
        not (component.get("capacity") or {}).get("row_count_max")
        or (component.get("capacity") or {})["row_count_max"] >= 5
        for component in graphic.get("tables") or []
    ):
        families.add("tables")
    for component in graphic.get("charts") or []:
        chart_type = str(component.get("chart_type") or "").lower()
        if chart_type in {"bar", "line"}:
            families.add(chart_type)
        # Baseline pie/doughnut charts are fitted by the frontend into any
        # template's free area (like bar/line baselines), so they are usable.
        if chart_type in {"pie", "doughnut"}:
            families.add("circular")
    return families


def validate_presentation_contract(
    presentation: dict[str, Any], report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    coverage = {key: 0 for key in CONTEXT_KEYS}
    slides = presentation.get("slides") or []
    metric_slide_count = 0
    table_slide_count = 0
    bar_chart_slide_count = 0
    visual_coverage = {key: 0 for key in ("tables", "bar", "line", "circular", "icon_lists")}
    for position, slide in enumerate(slides, start=1):
        context = slide.get("context") or {}
        intent = str(slide.get("intent") or "content")
        metric_slide_count += int(bool(context.get("metrics")))
        table_slide_count += int(bool(context.get("tables")))
        visual_coverage["tables"] += int(bool(context.get("tables")))
        visual_coverage["icon_lists"] += int(bool(context.get("icon_lists")))
        for chart in context.get("charts") or []:
            if not isinstance(chart, dict):
                continue
            chart_type = str(chart.get("type") or "").lower()
            family = "circular" if chart_type in {"pie", "doughnut"} else chart_type
            if family in visual_coverage:
                visual_coverage[family] += 1
        bar_chart_slide_count += int(any(
            str(chart.get("type") or "").lower() == "bar"
            for chart in context.get("charts") or []
            if isinstance(chart, dict)
        ))
        for key in CONTEXT_KEYS:
            coverage[key] += len(context.get(key) or [])
        if not slide.get("title"):
            issues.append({"slide": position, "code": "missing_title"})
        elif len(str(slide["title"]).strip()) > MAX_SLIDE_TITLE_CHARS:
            issues.append({"slide": position, "code": "title_too_long", "maximum": MAX_SLIDE_TITLE_CHARS})

        populated_context_types = sum(bool(context.get(key)) for key in CONTEXT_KEYS)
        terminal_copy = intent == "title" or (position == len(slides) and intent in {"summary", "cta"})
        if intent not in LIGHTWEIGHT_INTENTS and not terminal_copy:
            if not any(context.get(key) for key in (
                "paragraphs", "cards", "lists", "timelines", "icon_lists",
            )):
                issues.append({
                    "slide": position,
                    "code": "missing_narrative_context",
                    "fields": ["paragraphs", "cards", "lists", "timelines", "icon_lists"],
                })
        if not terminal_copy and populated_context_types < MIN_DENSE_CONTEXT_TYPES:
            issues.append({
                "slide": position,
                "code": "insufficient_context_density",
                "minimum_types": MIN_DENSE_CONTEXT_TYPES,
                "actual_types": populated_context_types,
            })
        for block in ("charts", "tables", "diagrams"):
            count = len(context.get(block) or [])
            if count > 1:
                issues.append({
                    "slide": position,
                    "code": "too_many_graphics_for_slide",
                    "field": block,
                    "maximum": 1,
                    "actual": count,
                })

        for index, paragraph in enumerate(context.get("paragraphs") or []):
            normalized_item = _normalize_heading_body_item(paragraph, "paragraphs")
            if not normalized_item["body"]:
                issues.append({"slide": position, "code": "invalid_paragraph", "index": index})

        repeat_rules = {
            "cards": lambda heading, body: bool(heading and body)
            and not LIST_HEADING_RE.fullmatch(heading)
            and not TIMELINE_HEADING_RE.search(heading),
            "lists": lambda heading, body: bool(body and LIST_HEADING_RE.fullmatch(heading)),
            "timelines": lambda heading, body: bool(body and TIMELINE_HEADING_RE.search(heading)),
            "icon_lists": lambda heading, body: bool(body and not heading),
        }
        for block, rule in repeat_rules.items():
            for index, item in enumerate(context.get(block) or []):
                normalized_item = _normalize_heading_body_item(item, block)
                if not rule(normalized_item["heading"], normalized_item["body"]):
                    issues.append({
                        "slide": position,
                        "code": f"invalid_{block[:-1]}_item",
                        "index": index,
                    })
        for block in ("persons", "quotes"):
            for index, item in enumerate(context.get(block) or []):
                normalized_item = _normalize_heading_body_item(item, block)
                if not normalized_item["body"] or (block == "persons" and not normalized_item["heading"]):
                    issues.append({
                        "slide": position,
                        "code": f"invalid_{block[:-1]}",
                        "index": index,
                    })
        for required in INTENT_REQUIREMENTS.get(intent, ()):
            if not context.get(required):
                issues.append({"slide": position, "code": "missing_intent_data", "field": required})
            elif len(context.get(required) or []) < INTENT_MIN_COUNTS.get(intent, 1):
                issues.append({
                    "slide": position,
                    "code": "insufficient_intent_data",
                    "field": required,
                    "minimum": INTENT_MIN_COUNTS[intent],
                })

        for index, metric in enumerate(context.get("metrics") or []):
            value = str((metric or {}).get("value") or "").strip()
            unit = str((metric or {}).get("unit") or "").strip()
            description = str((metric or {}).get("description") or "").strip()
            invalid_fields = []
            if not METRIC_VALUE_RE.fullmatch(value):
                invalid_fields.append("value")
            if len(value) > MAX_METRIC_VALUE_CHARS and "value" not in invalid_fields:
                invalid_fields.append("value")
            if unit and (not METRIC_UNIT_RE.fullmatch(unit) or len(unit) > MAX_METRIC_UNIT_CHARS):
                invalid_fields.append("unit")
            if not description:
                invalid_fields.append("description")
            if invalid_fields:
                issues.append({
                    "slide": position,
                    "code": "invalid_metric",
                    "index": index,
                    "missing_or_invalid": invalid_fields,
                })

        for index, chart in enumerate(context.get("charts") or []):
            labels = (chart or {}).get("labels") or (chart or {}).get("categories") or []
            values = (chart or {}).get("values") or []
            chart_type = str((chart or {}).get("type") or "").lower()
            minimum_points = 3 if chart_type == "bar" else 2
            maximum_points = 5 if chart_type in {"line", "pie", "doughnut"} else None
            if (
                len(labels) < minimum_points
                or (maximum_points is not None and len(labels) > maximum_points)
                or len(labels) != len(values)
                or not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values)
            ):
                issues.append({"slide": position, "code": "invalid_chart", "index": index})
            elif chart_type in CIRCULAR_CHART_TYPES and not _valid_share_values(values):
                issues.append({
                    "slide": position,
                    "code": "invalid_chart",
                    "index": index,
                    "reason": "shares_must_be_positive_and_sum_to_100",
                    "actual_sum": round(sum(values), 2),
                })

        for index, table in enumerate(context.get("tables") or []):
            headers = (table or {}).get("headers") or []
            rows = (table or {}).get("rows") or []
            if not headers or not 4 <= len(rows) <= 7 or any(
                not isinstance(row, list) or len(row) != len(headers) for row in rows
            ):
                issues.append({"slide": position, "code": "invalid_table", "index": index})

        if len(context.get("icon_lists") or []) > 5:
            issues.append({"slide": position, "code": "too_many_icon_list_items", "maximum": 5})

        for index, diagram in enumerate(context.get("diagrams") or []):
            if len((diagram or {}).get("nodes") or []) < 2:
                issues.append({"slide": position, "code": "invalid_diagram", "index": index})

    if len(slides) >= DECK_COVERAGE_MIN_SLIDES:
        for code, actual, minimum in (
            ("insufficient_metric_slide_coverage", metric_slide_count, MIN_METRIC_SLIDES),
            ("insufficient_table_slide_coverage", table_slide_count, MIN_TABLE_SLIDES),
            ("insufficient_bar_chart_slide_coverage", bar_chart_slide_count, MIN_BAR_CHART_SLIDES),
        ):
            if actual < minimum:
                issues.append({"code": code, "minimum": minimum, "actual": actual})

    available = _available_visual_families(report)
    content_slots = sum(
        slide.get("intent") not in {"title", "summary", "cta"}
        for slide in slides
    )
    if content_slots >= 3:
        for family in available:
            if not visual_coverage[family]:
                issues.append({"code": "missing_visual_family", "field": family, "minimum": 1, "actual": 0})

    warnings = [
        {"code": "missing_deck_coverage", "field": key}
        for key, count in coverage.items()
        if count == 0
    ]
    return {
        "valid": not issues,
        "issues": issues,
        "warnings": warnings,
        "coverage": coverage,
        "visual_coverage": visual_coverage,
    }


def _parse_completion_payload(raw_text: str) -> dict[str, Any]:
    try:
        payload = extract_json_payload(raw_text)
    except json.JSONDecodeError as exc:
        raise LLMError("Модель вернула невалидный JSON") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("presentation"), dict):
        raise LLMError("В ответе модели отсутствует объект presentation")
    return normalize_presentation_contract(payload["presentation"])


def terminal_content_constraints(report: dict[str, Any] | None) -> dict[str, Any]:
    terminal = ((report or {}).get("slides") or {}).get("terminal_candidates") or {}
    result = {}
    for role in ("initial", "final"):
        candidates = [item for item in (terminal.get(role) or [])[:3] if item.get("text_plan")]
        if not candidates and role == "final":
            candidates = [item for item in (terminal.get("initial") or [])[:3] if item.get("text_plan")]
        if not candidates:
            continue
        title_limits = [item["text_plan"]["title"]["max_chars"] for item in candidates]
        body_limits = [item["text_plan"]["text"]["max_chars"] for item in candidates if item["text_plan"].get("text")]
        result[role] = {
            "candidate_slide_numbers": [item["slide_number"] for item in candidates],
            "title_max_chars": min(title_limits),
            "text_max_chars": min(body_limits) if len(body_limits) == len(candidates) else 0,
            "person_supported": all(item["text_plan"].get("person_supported") for item in candidates),
            "title_boxes_pt": [{
                "width": item["text_plan"]["title"]["width_pt"],
                "height": item["text_plan"]["title"]["height_pt"],
                "font_size": item["text_plan"]["title"]["typography"]["size_pt"],
            } for item in candidates],
            "text_boxes_pt": [{
                "width": item["text_plan"]["text"]["width_pt"],
                "height": item["text_plan"]["text"]["height_pt"],
                "font_size": item["text_plan"]["text"]["typography"]["size_pt"],
            } for item in candidates if item["text_plan"].get("text")],
        }
    return result


def generate_presentation_from_brief(
    brief: str,
    usage_tracker: JobLLMUsage | None = None,
    report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    brief = brief.strip()
    if not brief:
        raise LLMError("Бриф не может быть пустым")

    system_prompt = load_prompt("create_presentation.md")
    terminal_limits = terminal_content_constraints(report)
    user_prompt = f"Бриф:\n\n{brief}"
    available_visuals = sorted(_available_visual_families(report))
    if available_visuals:
        user_prompt += (
            "\n\nДоступные визуальные семейства каталога: "
            f"{', '.join(available_visuals)}. Используй каждое хотя бы раз на содержательных "
            "слайдах, если их хватает. Один график каждого типа на слайде. "
            "Числа бери из брифа; если необходимы демонстрационные данные, прямо назови их примером."
        )
        chart_families = [family for family in ("bar", "line", "circular") if family in available_visuals]
        if chart_families:
            family_hints = {
                "bar": "bar — сравнение категорий (charts.type = \"bar\")",
                "line": "line — динамика во времени (charts.type = \"line\")",
                "circular": (
                    "circular — доли одного целого (charts.type = \"pie\" или \"doughnut\", "
                    "3–4 положительных процента с суммой ровно 100)"
                ),
            }
            user_prompt += (
                "\n\nСемейства графиков: "
                f"{'; '.join(family_hints[family] for family in chart_families)}. "
                "Показывай разные типы данных там, где это соответствует смыслу слайда. "
                "Если в брифе нет подходящих чисел, придумай правдоподобные иллюстративные "
                "данные, согласованные между собой и с текстом слайда."
            )
    if terminal_limits:
        user_prompt += (
            "\n\nГЕОМЕТРИЯ НАЧАЛЬНОГО И ФИНАЛЬНОГО СЛАЙДОВ, измерена до генерации "
            "по трем подходящим шаблонам (пункты типографики и размеры рамок):\n"
            f"{json.dumps(terminal_limits, ensure_ascii=False)}\n"
            "Первый и последний слайды содержат только title и text; "
            "не размещай там таблицы, диаграммы, графики и сниппеты. "
            "Длина title.short не должна превышать title_max_chars; text заранее не сокращай: "
            "используй его как обычное описание и доверь проверку компоновке. "
            "persons добавляй только если person_supported=true и человек указан в брифе; "
            "не выдумывай автора. Остальные context-данные титула не требуются."
        )
    completion = complete(
        system_prompt,
        user_prompt,
        usage_tracker=usage_tracker,
        operation="create_presentation",
        json_mode=True,
    )
    raw_text = completion.text
    presentation = _parse_completion_payload(raw_text)
    contract = validate_presentation_contract(presentation, report)

    return {
        "presentation": presentation,
        "contract": contract,
        "raw_text": raw_text,
    }


