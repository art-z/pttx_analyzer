"""Collect chart series colors from native charts and inferred chart regions."""

from __future__ import annotations

from typing import Any

from .fill_styles import primary_fill_color

MIN_CHART_SERIES_COLORS = 2
_DEFAULT_CHART_PALETTE = ["#0077FF", "#00A86B", "#FF6B35", "#7B61FF", "#FFB020"]
NEUTRAL_CHART_COLORS = frozenset({
    "#000000",
    "#FFFFFF",
    "#E1E1E1",
    "#E5E5E5",
    "#F2F2F2",
    "#CCCCCC",
    "#D9D9D9",
    "#BFBFBF",
})
GRADIENT_FILL_KINDS = frozenset({"linear_gradient", "radial_gradient"})


def normalize_chart_color(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = str(value).strip().upper()
    if not cleaned.startswith("#"):
        cleaned = f"#{cleaned}"
    if len(cleaned) != 7:
        return None
    try:
        int(cleaned[1:], 16)
    except ValueError:
        return None
    return cleaned


def is_neutral_chart_color(color: str | None) -> bool:
    normalized = normalize_chart_color(color)
    if not normalized:
        return True
    if normalized in NEUTRAL_CHART_COLORS:
        return True
    red = int(normalized[1:3], 16)
    green = int(normalized[3:5], 16)
    blue = int(normalized[5:7], 16)
    spread = max(red, green, blue) - min(red, green, blue)
    average = (red + green + blue) / 3
    if spread < 18 and average > 200:
        return True
    if spread < 12 and average < 36:
        return True
    return False


def merge_chart_palette(
    primary: list[str],
    supplement: list[str],
    *,
    min_colors: int = MIN_CHART_SERIES_COLORS,
    reserved_colors: list[str] | None = None,
) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    reserved = {
        normalized
        for color in (reserved_colors or [])
        if (normalized := normalize_chart_color(color))
    }

    def append_colors(values: list[str]) -> None:
        for color in values:
            normalized = normalize_chart_color(color)
            if (
                not normalized
                or is_neutral_chart_color(normalized)
                or normalized in seen
                or normalized in reserved
            ):
                continue
            seen.add(normalized)
            merged.append(normalized)

    append_colors(primary)
    if len(merged) < min_colors:
        append_colors(supplement)
    if len(merged) < min_colors:
        append_colors(_DEFAULT_CHART_PALETTE)
    return merged


def extract_design_system_text_colors(colors: dict[str, Any] | None) -> list[str]:
    if not colors:
        return []

    collected: list[str] = []
    for item in (colors.get("context_palettes") or {}).get("text") or []:
        if isinstance(item, dict) and item.get("color"):
            collected.append(item["color"])

    for item in (colors.get("resolved_palette") or [])[:24]:
        if not isinstance(item, dict) or not item.get("color"):
            continue
        contexts = item.get("contexts") or {}
        if contexts.get("text"):
            collected.append(item["color"])

    result: list[str] = []
    seen: set[str] = set()
    for color in collected:
        normalized = normalize_chart_color(color)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def extract_design_system_chart_colors(colors: dict[str, Any] | None) -> list[str]:
    if not colors:
        return []

    collected: list[str] = []
    context = colors.get("context_palettes") or {}
    for bucket in ("fill", "stroke", "other"):
        for item in context.get(bucket) or []:
            if isinstance(item, dict) and item.get("color"):
                collected.append(item["color"])

    text_colors = set(extract_design_system_text_colors(colors))
    for item in (colors.get("resolved_palette") or [])[:20]:
        if not isinstance(item, dict) or not item.get("color"):
            continue
        contexts = item.get("contexts") or {}
        if contexts.get("text") and not any(contexts.get(key) for key in ("fill", "stroke", "other")):
            continue
        collected.append(item["color"])

    result: list[str] = []
    seen: set[str] = set()
    for color in collected:
        normalized = normalize_chart_color(color)
        if (
            not normalized
            or is_neutral_chart_color(normalized)
            or normalized in seen
            or normalized in text_colors
        ):
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def collect_series_colors_from_elements(elements: list[dict[str, Any]]) -> list[str]:
    colors: list[str] = []
    seen: set[str] = set()
    for element in elements:
        fill = element.get("fill") or {}
        color = normalize_chart_color(primary_fill_color(fill) if isinstance(fill, dict) else None)
        if not color or is_neutral_chart_color(color) or color in seen:
            continue
        seen.add(color)
        colors.append(color)
    return colors


def normalize_chart_fill(fill: dict[str, Any] | None) -> dict[str, Any] | None:
    if not fill or not isinstance(fill, dict):
        return None

    kind = fill.get("kind")
    if kind in {None, "solid"} and fill.get("color"):
        color = normalize_chart_color(fill.get("color"))
        if not color or is_neutral_chart_color(color):
            return None
        payload: dict[str, Any] = {"kind": "solid", "color": color}
        alpha = fill.get("alpha")
        if alpha is not None:
            payload["alpha"] = round(float(alpha), 4)
        if fill.get("scheme"):
            payload["scheme"] = fill["scheme"]
        return payload

    if kind not in GRADIENT_FILL_KINDS:
        return None

    stops: list[dict[str, Any]] = []
    for stop in fill.get("stops") or []:
        if not isinstance(stop, dict):
            continue
        color = normalize_chart_color(stop.get("color"))
        if not color:
            continue
        item: dict[str, Any] = {
            "position": round(float(stop.get("position") or 0), 5),
            "color": color,
        }
        if stop.get("alpha") is not None:
            item["alpha"] = round(float(stop["alpha"]), 4)
        if stop.get("scheme"):
            item["scheme"] = stop["scheme"]
        stops.append(item)

    if len(stops) < 2:
        return None

    stops.sort(key=lambda item: item["position"])
    payload = {"kind": kind, "stops": stops}
    if kind == "linear_gradient":
        payload["angle_deg"] = round(float(fill.get("angle_deg") or 0), 2)
        if fill.get("scaled") is not None:
            payload["scaled"] = bool(fill.get("scaled"))
    else:
        payload["path"] = fill.get("path") or "circle"
        if fill.get("fill_to_rect"):
            payload["fill_to_rect"] = fill["fill_to_rect"]
    return payload


def chart_fill_variant_key(fill: dict[str, Any]) -> tuple[Any, ...]:
    kind = fill.get("kind")
    if kind == "solid":
        return ("solid", fill.get("color"), round(float(fill.get("alpha") or 1.0), 4))
    stops = tuple(
        (
            round(float(stop.get("position") or 0), 4),
            stop.get("color"),
            round(float(stop.get("alpha") or 1.0), 4),
        )
        for stop in fill.get("stops") or []
    )
    if kind == "radial_gradient":
        rect = fill.get("fill_to_rect") or {}
        return (kind, fill.get("path"), tuple(sorted(rect.items())), stops)
    return (kind, round(float(fill.get("angle_deg") or 0), 2), stops)


def collect_series_fill_variants_from_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for element in elements:
        normalized = normalize_chart_fill(element.get("fill"))
        if not normalized:
            continue
        key = chart_fill_variant_key(normalized)
        if key in seen:
            continue
        seen.add(key)
        variants.append(normalized)
    return variants


def palette_colors_from_fill_variants(variants: list[dict[str, Any]]) -> list[str]:
    colors: list[str] = []
    seen: set[str] = set()
    for fill in variants:
        if fill.get("kind") == "solid":
            color = normalize_chart_color(fill.get("color"))
        else:
            color = normalize_chart_color((fill.get("stops") or [{}])[0].get("color"))
        if not color or is_neutral_chart_color(color) or color in seen:
            continue
        seen.add(color)
        colors.append(color)
    return colors


def build_chart_series_palette(
    slides_catalog: dict[str, Any] | None,
    graphic_components: dict[str, Any] | None,
) -> dict[str, Any]:
    tallies: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    fill_variants: list[dict[str, Any]] = []
    fill_variant_keys: set[tuple[Any, ...]] = set()

    def register(color: str | None, source: str) -> None:
        normalized = normalize_chart_color(color)
        if not normalized or is_neutral_chart_color(normalized):
            return
        tallies[normalized] = tallies.get(normalized, 0) + 1
        source_counts[source] = source_counts.get(source, 0) + 1

    def register_fill(fill: dict[str, Any] | None, source: str) -> None:
        normalized = normalize_chart_fill(fill)
        if not normalized:
            return
        key = chart_fill_variant_key(normalized)
        if key not in fill_variant_keys:
            fill_variant_keys.add(key)
            fill_variants.append(normalized)
        for color in palette_colors_from_fill_variants([normalized]):
            register(color, source)

    for chart in (graphic_components or {}).get("charts") or []:
        for item in chart.get("series_palette") or []:
            register(item.get("color") if isinstance(item, dict) else item, "native_chart")
        for item in (chart.get("style_tokens") or {}).get("series_palette") or []:
            register(item.get("color"), "native_chart_style")
        for fill in (chart.get("style_tokens") or {}).get("series_fill_variants") or []:
            register_fill(fill, "native_chart_style")

    for slide in (slides_catalog or {}).get("slides") or []:
        inferred = slide.get("inferred_chart") or {}
        slide_number = slide.get("slide_number")
        source = str(inferred.get("source") or "inferred_chart")
        for color in inferred.get("series_palette") or []:
            register(color, source)
        for fill in inferred.get("series_fill_variants") or []:
            register_fill(fill, source)
        legend = inferred.get("legend") or {}
        for item in legend.get("items") or []:
            fill = item.get("fill") or {}
            register(fill.get("color") if isinstance(fill, dict) else None, source)
            register_fill(fill if isinstance(fill, dict) else None, source)
        for pair in legend.get("labeled_pairs") or []:
            register(pair.get("color"), "labeled_legend")
            register_fill({"kind": "solid", "color": pair.get("color")}, "labeled_legend")
        for series in inferred.get("series_preview") or []:
            for color in series.get("colors_preview") or []:
                register(color, source)
        if slide_number is not None and inferred.get("series_palette"):
            source_counts[f"slide_{slide_number}"] = source_counts.get(f"slide_{slide_number}", 0) + len(inferred["series_palette"])

    ordered = sorted(tallies.keys(), key=lambda color: (-tallies[color], color))
    return {
        "colors": ordered,
        "fill_variants": fill_variants,
        "entries": [{"color": color, "occurrences": tallies[color]} for color in ordered],
        "source_summary": source_counts,
    }


def resolve_chart_palette_for_baselines(
    chart_series_palette: dict[str, Any] | None,
    design_system_palette: list[str] | None,
    fallback: list[str],
    *,
    min_colors: int = MIN_CHART_SERIES_COLORS,
    reserved_text_colors: list[str] | None = None,
) -> list[str]:
    chart_colors = list((chart_series_palette or {}).get("colors") or [])
    supplement = list(design_system_palette or []) + list(fallback)
    return merge_chart_palette(
        chart_colors,
        supplement,
        min_colors=min_colors,
        reserved_colors=reserved_text_colors,
    )
