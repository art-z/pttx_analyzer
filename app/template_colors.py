"""Template text/background color profiles with contrast-aware recommendations."""

from __future__ import annotations

from collections import Counter

from .colors import _normalize_hex
from .fill_styles import primary_fill_color

TEXT_ROLES = ("title", "subtitle", "body", "content", "default")
MIN_CONTRAST_RATIO = 2.0
BACKGROUND_LIKE_CONTRAST = 1.5
IMAGE_TEXT_MIN_SAMPLES = 2
IMAGE_TEXT_MIN_SHARE = 0.5
IMAGE_TEXT_MIN_SLIDES = 1


def build_background_image_text_stats(
    text_slots: dict | None,
    layout_image_index: dict[str, str],
    *,
    min_samples: int = IMAGE_TEXT_MIN_SAMPLES,
    min_share: float = IMAGE_TEXT_MIN_SHARE,
    min_slides: int = IMAGE_TEXT_MIN_SLIDES,
) -> dict[str, dict]:
    """Aggregate slide text colors grouped by layout background image filename."""
    from collections import defaultdict

    layout_defaults = _layout_default_text_colors(text_slots, layout_image_index)
    slides_by_source: dict[str, list[dict]] = defaultdict(list)
    for slot in (text_slots or {}).get("slide_instances", []):
        slides_by_source[slot.get("source") or ""].append(slot)

    counters: dict[str, Counter] = defaultdict(Counter)
    slide_votes: dict[str, Counter] = defaultdict(Counter)

    for slots in slides_by_source.values():
        layout = next(
            (slot.get("layout_source") or slot.get("inherited_from") for slot in slots
             if slot.get("layout_source") or slot.get("inherited_from")),
            None,
        )
        image = layout_image_index.get(layout or "")
        if not image:
            continue

        slide_colors: Counter = Counter()
        for slot in slots:
            if not _slot_counts_as_image_usage(slot, layout or "", layout_defaults):
                continue
            level = (slot.get("levels") or [{}])[0]
            color = _normalize_hex(level.get("color") or "")
            if not color:
                continue
            counters[image][color] += 1
            slide_colors[color] += 1

        if not slide_colors:
            continue
        dominant_color, dominant_count = slide_colors.most_common(1)[0]
        if dominant_count / sum(slide_colors.values()) >= min_share:
            slide_votes[image][dominant_color] += 1

    result: dict[str, dict] = {}
    images = set(layout_image_index.values()) | set(counters.keys()) | set(slide_votes.keys())
    for image in images:
        voted_slides = sum(slide_votes[image].values())
        if voted_slides >= min_slides:
            primary, primary_votes = slide_votes[image].most_common(1)[0]
            share = primary_votes / voted_slides
            if share >= min_share:
                result[image] = {
                    "primary": primary,
                    "samples": sum(counters[image].values()) or primary_votes,
                    "slide_count": voted_slides,
                    "share": round(share, 3),
                    "distribution": dict(counters[image].most_common(6) or slide_votes[image].most_common(6)),
                    "source": "background_image_usage",
                }
                continue

        counter = counters[image]
        total = sum(counter.values())
        if total < min_samples:
            continue
        primary, primary_count = counter.most_common(1)[0]
        share = primary_count / total
        if share < min_share:
            continue
        result[image] = {
            "primary": primary,
            "samples": total,
            "slide_count": voted_slides or None,
            "share": round(share, 3),
            "distribution": dict(counter.most_common(6)),
            "source": "background_image_usage",
        }
    return result


def _layout_default_text_colors(
    text_slots: dict | None,
    layout_image_index: dict[str, str],
) -> dict[str, dict[str, str]]:
    from collections import defaultdict

    defaults: dict[str, dict[str, str]] = defaultdict(dict)
    for slot in (text_slots or {}).get("templates", []):
        layout = slot.get("source") or ""
        if layout not in layout_image_index:
            continue
        role = _slot_role(slot.get("placeholder_type"))
        color = _normalize_hex(((slot.get("levels") or [{}])[0]).get("color") or "")
        if color and role not in defaults[layout]:
            defaults[layout][role] = color
    return defaults


def _slot_counts_as_image_usage(
    slot: dict,
    layout: str,
    layout_defaults: dict[str, dict[str, str]],
) -> bool:
    if not slot.get("empty"):
        return True
    role = _slot_role(slot.get("placeholder_type"))
    color = _normalize_hex(((slot.get("levels") or [{}])[0]).get("color") or "")
    default = layout_defaults.get(layout, {}).get(role)
    return bool(color and default and color != default)


def resolve_background_image_key(background: dict, render: dict | None = None) -> str | None:
    primary = background.get("primary_image")
    if primary:
        return primary
    for layer in (render or {}).get("layers", []):
        if layer.get("kind") != "image" or not layer.get("asset"):
            continue
        geometry = layer.get("geometry_norm") or {}
        width = geometry.get("width", 0)
        height = geometry.get("height", 0)
        if width >= 0.35 and height >= 0.35:
            return layer["asset"]
        if height >= 0.85 and width >= 0.22:
            return layer["asset"]
        if width >= 0.85 and height >= 0.22:
            return layer["asset"]
    return None


def build_template_color_profile(
    *,
    background: dict,
    render: dict,
    editable_slots: list[dict],
    context_palettes: dict,
    theme_map: dict,
    layout_source: str,
    text_slots: dict | None,
    background_image_text_stats: dict[str, dict] | None = None,
) -> dict:
    background_color = resolve_background_color(background, render, theme_map)
    background_is_dark = is_dark(background_color)
    background_luminance = relative_luminance(background_color)
    background_image = resolve_background_image_key(background, render)
    image_usage = (background_image_text_stats or {}).get(background_image or "")

    role_layout_colors = _role_colors_from_slots(editable_slots)
    role_observed_colors = _role_colors_from_slide_instances(text_slots, layout_source, theme_map)
    palette_text = [
        item["color"]
        for item in context_palettes.get("text", [])
        if item.get("color")
    ]
    palette_accent = _accent_colors(context_palettes, theme_map)

    text_styles: dict[str, dict] = {}
    unified_image_color = None
    if image_usage:
        unified_image_color = _normalize_hex(image_usage.get("primary") or "")

    for role in TEXT_ROLES:
        layout_color = role_layout_colors.get(role)
        observed = role_observed_colors.get(role, [])
        candidates = _dedupe_colors([
            unified_image_color,
            layout_color,
            *observed,
            *palette_text,
            *palette_accent,
            theme_map.get("lt2"),
            theme_map.get("lt1"),
            theme_map.get("dk1"),
            theme_map.get("accent1"),
        ])
        preferred = unified_image_color or layout_color
        if unified_image_color:
            primary = unified_image_color
            source = "background_image_usage"
        elif layout_color:
            # Placeholder/layout color is design intent (often white on photo layouts).
            # Do not replace it with contrast math against flat master fill (#FFFFFF).
            primary = layout_color
            source = "layout"
        else:
            primary = pick_contrasting_color(
                background_color,
                candidates,
                theme_map,
                preferred=preferred,
            )
            source = "contrast_fallback"
        style = {
            "primary": primary,
            "layout": layout_color,
            "candidates": [
                color for color in candidates
                if color and not is_background_like(color, background_color)
            ][:8],
            "source": source,
        }
        text_styles[role] = style

    recommended = pick_contrasting_color(
        background_color,
        _dedupe_colors([
            *palette_text,
            text_styles["title"]["layout"],
            text_styles["body"]["layout"],
            theme_map.get("lt2"),
            theme_map.get("lt1"),
            theme_map.get("dk1"),
        ]),
        theme_map,
    )

    fill_colors = [item["color"] for item in context_palettes.get("fill", [])[:6] if item.get("color")]

    background_image_payload = None
    if background_image:
        background_image_payload = {"asset": background_image}
        if image_usage:
            background_image_payload.update(image_usage)

    return {
        "background": background_color,
        "background_is_dark": background_is_dark,
        "background_luminance": round(background_luminance, 4),
        "text": _dedupe_colors([
            text_styles[role]["primary"] for role in ("title", "body", "subtitle", "content")
        ] + [
            color for color in palette_text
            if color and not is_background_like(color, background_color)
        ])[:6],
        "fill": fill_colors,
        "accent": palette_accent[:6],
        "theme": {
            "dk1": theme_map.get("dk1"),
            "lt1": theme_map.get("lt1"),
            "lt2": theme_map.get("lt2"),
            "accent1": theme_map.get("accent1"),
        },
        "text_styles": text_styles,
        "background_image": background_image_payload,
        "contrast": {
            "min_ratio": MIN_CONTRAST_RATIO,
            "recommended_on_background": recommended,
            "fallback_light": theme_map.get("lt2") or theme_map.get("lt1") or "#FFFFFF",
            "fallback_dark": theme_map.get("dk1") or "#000000",
        },
    }


def resolve_background_color(background: dict, render: dict, theme_map: dict) -> str:
    """
    Resolve the real template background color.

    Important:
    render.background_color can be a visual/dominant fallback color derived
    from rendered layers. It must not override an explicit PPTX background fill.
    """

    fill = (background or {}).get("fill") or {}

    color = primary_fill_color(fill)
    if color:
        return color

    if fill.get("type") == "scheme" and fill.get("scheme"):
        resolved = theme_map.get(fill["scheme"])
        if resolved:
            return resolved

    if fill.get("kind") == "solid" and fill.get("scheme"):
        resolved = theme_map.get(fill["scheme"])
        if resolved:
            return resolved

    render_color = (render or {}).get("background_color")
    if render_color:
        return render_color

    return theme_map.get("lt1") or "#FFFFFF"


def relative_luminance(hex_color: str | None) -> float:
    normalized = _normalize_hex(hex_color or "")
    if not normalized:
        return 0.5
    r = int(normalized[1:3], 16) / 255
    g = int(normalized[3:5], 16) / 255
    b = int(normalized[5:7], 16) / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(color_a: str | None, color_b: str | None) -> float:
    left = relative_luminance(color_a)
    right = relative_luminance(color_b)
    lighter = max(left, right)
    darker = min(left, right)
    return (lighter + 0.05) / (darker + 0.05)


def is_dark(hex_color: str | None) -> bool:
    return relative_luminance(hex_color) < 0.45


def is_background_like(text_color: str | None, background_color: str | None) -> bool:
    if not text_color or not background_color:
        return False
    if text_color.upper() == background_color.upper():
        return True
    if contrast_ratio(text_color, background_color) < BACKGROUND_LIKE_CONTRAST:
        return True
    if relative_luminance(text_color) > 0.88 and relative_luminance(background_color) > 0.88:
        return True
    return False


def pick_contrasting_color(
    background_color: str,
    candidates: list[str | None],
    theme_map: dict,
    *,
    preferred: str | None = None,
    min_ratio: float = MIN_CONTRAST_RATIO,
) -> str:
    if preferred and not is_background_like(preferred, background_color):
        if contrast_ratio(preferred, background_color) >= min_ratio:
            if is_dark(background_color) and relative_luminance(preferred) < 0.55:
                pass
            elif not is_dark(background_color) and relative_luminance(preferred) > 0.82:
                pass
            else:
                return preferred

    pool = _dedupe_colors([
        *candidates,
        theme_map.get("lt2"),
        theme_map.get("lt1"),
        "#FFFFFF",
        theme_map.get("dk1"),
        "#000000",
    ])
    good = [
        color for color in pool
        if color and contrast_ratio(color, background_color) >= min_ratio
    ]
    if not good:
        return theme_map.get("lt2") or "#FFFFFF" if is_dark(background_color) else theme_map.get("dk1") or "#000000"

    if is_dark(background_color):
        good.sort(key=lambda color: (-contrast_ratio(color, background_color), -relative_luminance(color)))
    else:
        good.sort(key=lambda color: (-contrast_ratio(color, background_color), relative_luminance(color)))
    return good[0]


def apply_slot_text_colors(editable_slots: list[dict], text_styles: dict) -> None:
    default_style = text_styles.get("default") or text_styles.get("body") or {}
    for slot in editable_slots:
        role_style = text_styles.get(slot.get("role")) or default_style
        slot["text_color"] = role_style.get("primary")
        if role_style.get("layout"):
            slot.setdefault("typography", {})["layout_color"] = role_style.get("layout")


def _role_colors_from_slots(editable_slots: list[dict]) -> dict[str, str]:
    colors: dict[str, str] = {}
    for slot in editable_slots:
        role = slot.get("role") or "content"
        typography = slot.get("typography") or {}
        color = typography.get("color")
        if color and role not in colors:
            colors[role] = color
    return colors


def _role_colors_from_slide_instances(
    text_slots: dict | None,
    layout_source: str,
    theme_map: dict,
) -> dict[str, list[str]]:
    grouped: dict[str, Counter] = {role: Counter() for role in TEXT_ROLES}
    for slot in (text_slots or {}).get("slide_instances", []):
        slot_layout = slot.get("layout_source") or slot.get("inherited_from")
        if slot_layout != layout_source:
            continue
        role = _slot_role(slot.get("placeholder_type"))
        for level in slot.get("levels") or []:
            color = level.get("color")
            if color:
                grouped[role][color] += 1
                grouped["default"][color] += 1
    return {
        role: [color for color, _count in counter.most_common(6)]
        for role, counter in grouped.items()
        if counter
    }


def _slot_role(placeholder_type: str | None) -> str:
    if placeholder_type in {"title", "ctrTitle"}:
        return "title"
    if placeholder_type == "subTitle":
        return "subtitle"
    if placeholder_type == "body":
        return "body"
    return "content"


def _accent_colors(context_palettes: dict, theme_map: dict) -> list[str]:
    accents = []
    for scheme in ("accent1", "accent2", "accent3", "accent4", "accent5", "accent6"):
        if scheme in theme_map:
            accents.append(theme_map[scheme])
    for item in context_palettes.get("fill", []):
        color = item.get("color")
        if color and color not in accents:
            accents.append(color)
    return accents


def _dedupe_colors(colors: list[str | None]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for color in colors:
        normalized = _normalize_hex(color or "")
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result
