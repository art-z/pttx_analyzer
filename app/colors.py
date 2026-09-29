from collections import Counter, defaultdict

from .pptx import PPTXPackage


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}

COLOR_TYPES = {
    "srgbClr",
    "schemeClr",
    "sysClr",
    "prstClr",
    "scrgbClr",
}


def extract_colors(package: PPTXPackage, theme: dict) -> dict:
    from .fill_styles import extract_gradient_fills, resolve_color_node

    raw_colors = Counter()
    palette = {}
    transparent = {}

    theme_map = _build_theme_map(theme)

    parts = (
        package.list("ppt/slides/")
        + package.list("ppt/slideLayouts/")
        + package.list("ppt/slideMasters/")
    )

    for part in parts:
        if not part.endswith(".xml"):
            continue

        root = package.xml(part)

        # lxml getparent() работает, поэтому можем определить,
        # где именно находится каждый color node.
        for node in root.iter():
            color_type = _local_name(node.tag)

            if color_type not in COLOR_TYPES:
                continue

            value = _extract_color_value(node, color_type)

            if not value:
                continue

            parsed = resolve_color_node(node, theme_map)
            resolved = parsed.get("color") if parsed else _resolve_color(
                node=node,
                color_type=color_type,
                value=value,
                theme_map=theme_map,
            )
            alpha = parsed.get("alpha", 1.0) if parsed else _extract_alpha(node)

            source_name = _source_name(
                color_type=color_type,
                value=value,
            )

            context = _detect_context(node)

            # -------------------------------------------------
            # RAW COLORS
            # -------------------------------------------------

            raw_key = (
                color_type,
                value,
                resolved,
                alpha,
                context,
            )

            raw_colors[raw_key] += 1

            if resolved is None:
                continue

            # -------------------------------------------------
            # TRANSPARENT
            # -------------------------------------------------

            if alpha <= 0:
                key = resolved

                if key not in transparent:
                    transparent[key] = {
                        "source_color": resolved,
                        "occurrences": 0,
                        "sources": Counter(),
                        "contexts": Counter(),
                    }

                item = transparent[key]

                item["occurrences"] += 1
                item["sources"][source_name] += 1
                item["contexts"][context] += 1

                continue

            # -------------------------------------------------
            # RESOLVED PALETTE
            # -------------------------------------------------

            palette_key = (
                resolved,
                alpha,
            )

            if palette_key not in palette:
                palette[palette_key] = {
                    "color": resolved,
                    "alpha": alpha,
                    "occurrences": 0,
                    "contexts": Counter(),
                    "sources": defaultdict(Counter),
                }

            item = palette[palette_key]

            item["occurrences"] += 1
            item["contexts"][context] += 1

            item["sources"][source_name]["total"] += 1
            item["sources"][source_name][context] += 1

    # -------------------------------------------------
    # SERIALIZE RAW
    # -------------------------------------------------

    colors_result = []

    for key, count in raw_colors.most_common():
        color_type, value, resolved, alpha, context = key

        colors_result.append({
            "type": color_type,
            "value": value,
            "resolved": resolved,
            "alpha": alpha,
            "context": context,
            "occurrences": count,
        })

    # -------------------------------------------------
    # SERIALIZE PALETTE
    # -------------------------------------------------

    palette_result = []

    for item in palette.values():

        sources = {}

        for source_name, source_counts in item["sources"].items():
            sources[source_name] = dict(source_counts)

        palette_result.append({
            "color": item["color"],
            "alpha": item["alpha"],
            "occurrences": item["occurrences"],
            "contexts": dict(
                item["contexts"].most_common()
            ),
            "sources": sources,
        })

    palette_result.sort(
        key=lambda x: (
            -x["occurrences"],
            x["color"],
            x["alpha"],
        )
    )

    # -------------------------------------------------
    # SERIALIZE TRANSPARENT
    # -------------------------------------------------

    transparent_result = []

    for item in transparent.values():

        transparent_result.append({
            "source_color": item["source_color"],
            "occurrences": item["occurrences"],
            "sources": dict(
                item["sources"].most_common()
            ),
            "contexts": dict(
                item["contexts"].most_common()
            ),
        })

    transparent_result.sort(
        key=lambda x: (
            -x["occurrences"],
            x["source_color"],
        )
    )

    # -------------------------------------------------
    # CONTEXT PALETTES
    # -------------------------------------------------

    context_palettes = _build_context_palettes(
        palette_result
    )

    return {
        "colors": colors_result,
        "resolved_palette": palette_result,
        "context_palettes": context_palettes,
        "transparent": transparent_result,
        "gradients": extract_gradient_fills(package, theme),
    }


# =====================================================
# CONTEXT DETECTION
# =====================================================

def _detect_context(node) -> str:
    """
    Определяет назначение color node по его XML ancestors.

    Возможные значения:
        text
        fill
        stroke
        background
        effect
        other
    """

    ancestors = []

    parent = node.getparent()

    while parent is not None:
        ancestors.append(_local_name(parent.tag))
        parent = parent.getparent()

    # -------------------------------------------------
    # EFFECTS
    # -------------------------------------------------

    effect_nodes = {
        "effectLst",
        "effectDag",
        "outerShdw",
        "innerShdw",
        "glow",
        "reflection",
        "softEdge",
    }

    if any(name in effect_nodes for name in ancestors):
        return "effect"

    # -------------------------------------------------
    # STROKE
    # -------------------------------------------------

    # <a:ln>
    #   <a:solidFill>
    #       <a:schemeClr .../>
    #   </a:solidFill>
    # </a:ln>

    if "ln" in ancestors:
        return "stroke"

    # -------------------------------------------------
    # TEXT
    # -------------------------------------------------

    text_nodes = {
        "rPr",
        "defRPr",
        "endParaRPr",
    }

    if any(name in text_nodes for name in ancestors):
        return "text"

    # -------------------------------------------------
    # BACKGROUND
    # -------------------------------------------------

    background_nodes = {
        "bg",
        "bgPr",
        "bgRef",
    }

    if any(name in background_nodes for name in ancestors):
        return "background"

    # -------------------------------------------------
    # FILL
    # -------------------------------------------------

    fill_nodes = {
        "solidFill",
        "gradFill",
        "pattFill",
    }

    if any(name in fill_nodes for name in ancestors):
        return "fill"

    return "other"


# =====================================================
# CONTEXT PALETTES
# =====================================================

def _build_context_palettes(
    palette_result: list[dict],
) -> dict:

    contexts = {
        "text": [],
        "fill": [],
        "stroke": [],
        "background": [],
        "effect": [],
        "other": [],
    }

    for color in palette_result:

        for context, count in color["contexts"].items():

            if context not in contexts:
                contexts[context] = []

            contexts[context].append({
                "color": color["color"],
                "alpha": color["alpha"],
                "occurrences": count,
            })

    for values in contexts.values():
        values.sort(
            key=lambda x: (
                -x["occurrences"],
                x["color"],
            )
        )

    return contexts


# =====================================================
# THEME
# =====================================================

def _build_theme_map(theme: dict) -> dict:
    result = {}

    themes = theme.get("themes", [])
    if not themes:
        return result

    primary_source = theme.get("primary_theme_source")

    selected_theme = None

    if primary_source:
        selected_theme = next(
            (
                item for item in themes
                if item.get("source") == primary_source
            ),
            None,
        )

    if selected_theme is None:
        selected_theme = next(
            (
                item for item in themes
                if item.get("is_used_by_master")
            ),
            None,
        )

    if selected_theme is None:
        selected_theme = themes[0]

    theme_colors = selected_theme.get("colors", {})

    for name, color in theme_colors.items():

        if not isinstance(color, dict):
            continue

        color_type = color.get("type")
        value = color.get("value")

        if not value:
            continue

        if color_type == "srgbClr":

            resolved = _normalize_hex(value)

            if resolved:
                result[name] = resolved

        elif color_type == "sysClr":

            resolved = _normalize_hex(value)

            if resolved:
                result[name] = resolved

    for alias, base in (("tx1", "dk1"), ("tx2", "dk2"), ("bg1", "lt1"), ("bg2", "lt2")):
        if alias not in result and base in result:
            result[alias] = result[base]

    return result


# =====================================================
# COLOR RESOLUTION
# =====================================================

def _extract_color_value(
    node,
    color_type: str,
) -> str | None:

    if color_type == "scrgbClr":
        r = node.get("r")
        g = node.get("g")
        b = node.get("b")

        if r is None or g is None or b is None:
            return None

        return f"{r},{g},{b}"

    return node.get("val") or node.get("lastClr")


def _resolve_color(
    node,
    color_type: str,
    value: str,
    theme_map: dict,
) -> str | None:

    if color_type == "srgbClr":
        return _normalize_hex(value)

    if color_type == "schemeClr":
        return theme_map.get(value)

    if color_type == "sysClr":
        return _normalize_hex(value)

    if color_type == "scrgbClr":
        return _resolve_scrgb(node)

    # prstClr пока не преобразуем.
    return None


def _resolve_scrgb(node) -> str | None:
    try:
        r = int(node.get("r", "0"))
        g = int(node.get("g", "0"))
        b = int(node.get("b", "0"))
    except ValueError:
        return None

    r = round(max(0, min(100000, r)) / 100000 * 255)
    g = round(max(0, min(100000, g)) / 100000 * 255)
    b = round(max(0, min(100000, b)) / 100000 * 255)

    return f"#{r:02X}{g:02X}{b:02X}"


# =====================================================
# ALPHA
# =====================================================

def _extract_alpha(node) -> float:
    alpha_node = node.find("a:alpha", NS)

    if alpha_node is None:
        return 1.0

    value = alpha_node.get("val")

    if value is None:
        return 1.0

    try:
        alpha = int(value) / 100000
    except (TypeError, ValueError):
        return 1.0

    return max(
        0.0,
        min(1.0, alpha),
    )


# =====================================================
# SOURCE
# =====================================================

def _source_name(
    color_type: str,
    value: str,
) -> str:

    if color_type == "schemeClr":
        return value

    if color_type == "srgbClr":
        return "literal"

    if color_type == "sysClr":
        return "system"

    if color_type == "prstClr":
        return f"preset:{value}"

    if color_type == "scrgbClr":
        return "scrgb"

    return color_type


# =====================================================
# HELPERS
# =====================================================

def _normalize_hex(value: str) -> str | None:

    if not value:
        return None

    value = value.strip().lstrip("#")

    if len(value) != 6:
        return None

    try:
        int(value, 16)
    except ValueError:
        return None

    return f"#{value.upper()}"


def _local_name(tag: str) -> str:
    return tag.split("}")[-1]