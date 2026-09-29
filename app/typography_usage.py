"""Infer typographic roles from how scale levels are used on slides."""

import math
import re
from collections import Counter, defaultdict

from .pptx import PPTXPackage
from .slide_geometry import is_shape_visible, shape_geometry, visible_shape_context

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
EMU_PER_PT = 12700


def analyze_typography_usage(
    package: PPTXPackage,
    theme: dict,
    type_scales: list[dict],
    slide_size=None,
    use_visible_slides=False,
) -> dict:
    slide_size = slide_size or _slide_size(package)
    blocks = _extract_text_blocks(package, theme, slide_size, use_visible_slides)
    level_lookup = _build_level_lookup(type_scales)
    canonical_sizes = _canonical_sizes(type_scales)
    for block in blocks:
        block["scale_level"] = _match_scale_level(block, level_lookup)
    scale_roles = _analyze_scale_roles(blocks, slide_size, canonical_sizes)
    return {
        "text_blocks": blocks,
        "scale_roles": scale_roles,
    }


def _slide_size(package: PPTXPackage) -> tuple[float, float] | None:
    if not package.exists("ppt/presentation.xml"):
        return None
    size = package.xml("ppt/presentation.xml").find("p:sldSz", NS)
    if size is None:
        return None
    try:
        return int(size.get("cx")) / EMU_PER_PT, int(size.get("cy")) / EMU_PER_PT
    except (TypeError, ValueError):
        return None


def _extract_text_blocks(package: PPTXPackage, theme: dict, slide_size, use_visible_slides) -> list[dict]:
    theme_fonts = _theme_fonts(theme)
    blocks = []
    for part in package.list("ppt/slides/"):
        if not part.endswith(".xml"):
            continue
        slide_match = re.search(r"slide(\d+)\.xml$", part)
        if slide_match is None:
            continue
        slide_number = int(slide_match.group(1))
        root = package.xml(part)
        for shape in root.findall(".//p:sp", NS):
            if use_visible_slides and not is_shape_visible(shape):
                continue
            body = shape.find("p:txBody", NS)
            if body is None:
                continue
            paragraphs = body.findall("a:p", NS)
            line_texts = []
            for paragraph in paragraphs:
                text = "".join(node.text or "" for node in paragraph.findall(".//a:t", NS)).strip()
                if text:
                    line_texts.append(text)
            if not line_texts:
                continue
            full_text = "\n".join(line_texts)
            family, size_pt = _dominant_run_style(body, theme_fonts)
            geometry = shape_geometry(shape)
            if geometry is None:
                continue
            if use_visible_slides and visible_shape_context(shape, slide_size) is None:
                continue
            blocks.append({
                "slide_number": slide_number,
                "shape_id": _shape_id(shape),
                "x_pt": geometry["x_pt"],
                "y_pt": geometry["y_pt"],
                "width_pt": geometry["width_pt"],
                "height_pt": geometry["height_pt"],
                "area_pt2": round(geometry["width_pt"] * geometry["height_pt"], 2),
                "family": family,
                "size_pt": size_pt,
                "line_count": len(line_texts),
                "char_count": len(full_text),
                "text_sample": full_text[:120],
            })
    return blocks


def _shape_id(shape):
    identity = shape.find("p:nvSpPr/p:cNvPr", NS)
    return identity.get("id") if identity is not None else None


def _dominant_run_style(body, theme_fonts):
    weighted = Counter()
    for run in body.findall(".//a:r", NS):
        text = run.find("a:t", NS)
        if text is None:
            continue
        content = text.text or ""
        if not content.strip():
            continue
        rpr = run.find("a:rPr", NS)
        family = None
        size_pt = None
        if rpr is not None:
            latin = rpr.find("a:latin", NS)
            if latin is not None and latin.get("typeface"):
                family = latin.get("typeface")
            size_raw = rpr.get("sz")
            if size_raw is not None:
                try:
                    size_pt = int(size_raw) / 100
                except ValueError:
                    pass
        if family in theme_fonts and theme_fonts[family]:
            family = theme_fonts[family]
        weighted[(family or "Наследуется", size_pt)] += len(content)
    if not weighted:
        return "Наследуется", None
    (family, size_pt), _ = weighted.most_common(1)[0]
    return family, size_pt


def _theme_fonts(theme):
    themes = theme.get("themes", [])
    fonts = themes[0].get("fonts", {}) if themes else {}
    return {
        "+mj-lt": fonts.get("major", {}).get("latin"),
        "+mn-lt": fonts.get("minor", {}).get("latin"),
    }


def _build_level_lookup(type_scales):
    lookup = {}
    for scale in type_scales:
        family = scale["family"]
        lookup[family] = sorted(scale["levels"], key=lambda item: item["scale_level"])
    return lookup


def _canonical_sizes(type_scales):
    sizes = {}
    for scale in type_scales:
        family = scale["family"]
        sizes[family] = {level["scale_level"]: level["size_pt"] for level in scale["levels"]}
    return sizes


def _match_scale_level(block, level_lookup):
    family = block["family"]
    size_pt = block["size_pt"]
    levels = level_lookup.get(family)
    if not levels or size_pt is None:
        return None
    exact = next((level["scale_level"] for level in levels if level["size_pt"] == size_pt), None)
    if exact is not None:
        return exact
    tolerance = max(0.35, size_pt * 0.025)
    candidates = [level for level in levels if abs(level["size_pt"] - size_pt) <= tolerance]
    if not candidates:
        return None
    return min(candidates, key=lambda level: abs(level["size_pt"] - size_pt))["scale_level"]


def _analyze_scale_roles(blocks, slide_size, canonical_sizes):
    grouped = defaultdict(list)
    for block in blocks:
        if block["scale_level"] is None:
            continue
        grouped[(block["family"], block["scale_level"])].append(block)

    by_family = defaultdict(list)
    for (family, scale_level), group_blocks in grouped.items():
        metrics = _level_metrics(group_blocks, slide_size)
        by_family[family].append({
            "scale_level": scale_level,
            "size_pt": canonical_sizes.get(family, {}).get(scale_level, group_blocks[0]["size_pt"]),
            "block_count": len(group_blocks),
            "slide_count": len({block["slide_number"] for block in group_blocks}),
            "metrics": metrics,
        })

    result = []
    for family, levels in by_family.items():
        levels.sort(key=lambda item: item["scale_level"])
        scale_sizes = list(canonical_sizes.get(family, {}).values())
        body_raw = _assign_role_probabilities(levels, scale_sizes)
        inferred_body = max(body_raw, key=lambda item: item[1])[0]
        total_raw = sum(score for _, score in body_raw)
        best_raw = max(score for _, score in body_raw)
        body_confidence = round(best_raw / total_raw, 2) if total_raw else 0.0
        for level in levels:
            level["step_from_body"] = level["scale_level"] - inferred_body
            if level["scale_level"] == inferred_body and body_confidence >= 0.2:
                level["role_hint"] = "body"
            elif level["role_hint"] == "body":
                level["role_hint"] = "other"
        result.append({
            "family": family,
            "inferred_body_level": inferred_body,
            "inferred_body_confidence": round(body_confidence, 2),
            "levels": levels,
        })
    return sorted(result, key=lambda item: (-sum(level["block_count"] for level in item["levels"]), item["family"]))


def _level_metrics(blocks, slide_size):
    slide_width, slide_height = slide_size or (None, None)
    slide_area = slide_width * slide_height if slide_width and slide_height else None
    centers_y = []
    area_ratios = []
    for block in blocks:
        if slide_height:
            centers_y.append((block["y_pt"] + block["height_pt"] / 2) / slide_height)
        if slide_area:
            area_ratios.append(block["area_pt2"] / slide_area)

    by_slide = defaultdict(list)
    for block in blocks:
        by_slide[block["slide_number"]].append(block)

    below_other = 0
    comparisons = 0
    multi_on_slide = 0
    single_on_slide = 0
    for slide_blocks in by_slide.values():
        level_blocks = slide_blocks
        if len(level_blocks) >= 2:
            multi_on_slide += 1
        if len(level_blocks) == 1:
            single_on_slide += 1
        for block in level_blocks:
            others = [other for other in slide_blocks if other is not block]
            if not others:
                continue
            block_center = block["y_pt"] + block["height_pt"] / 2
            comparisons += 1
            if any(other["y_pt"] + other["height_pt"] / 2 < block_center for other in others):
                below_other += 1

    slide_count = len(by_slide)
    total_char_count = sum(block["char_count"] for block in blocks)
    return {
        "avg_area_ratio": round(sum(area_ratios) / len(area_ratios), 3) if area_ratios else None,
        "multiline_ratio": round(sum(block["line_count"] >= 2 for block in blocks) / len(blocks), 3),
        "y_spread": round(_std_dev(centers_y), 3) if centers_y else None,
        "below_other_ratio": round(below_other / comparisons, 3) if comparisons else 0.0,
        "multi_on_slide_ratio": round(multi_on_slide / slide_count, 3) if slide_count else 0.0,
        "single_on_slide_ratio": round(single_on_slide / slide_count, 3) if slide_count else 0.0,
        "top_zone_ratio": round(sum(center < 0.25 for center in centers_y) / len(centers_y), 3) if centers_y else 0.0,
        "avg_char_count": round(total_char_count / len(blocks), 1),
        "total_char_count": total_char_count,
    }


def _assign_role_probabilities(levels, scale_sizes):
    """Pick body/title competitively across the whole scale, not per level in isolation."""
    min_size = min(scale_sizes) if scale_sizes else min(level["size_pt"] for level in levels)
    max_size = max(scale_sizes) if scale_sizes else max(level["size_pt"] for level in levels)
    total_blocks = sum(level["block_count"] for level in levels)
    total_chars = sum(level["metrics"]["total_char_count"] for level in levels)

    body_scores = []
    title_scores = []
    for level in levels:
        metrics = level["metrics"]
        size_ratio = _size_ratio(level["size_pt"], min_size, max_size)
        char_share = metrics["total_char_count"] / total_chars if total_chars else 0.0
        block_share = level["block_count"] / total_blocks if total_blocks else 0.0
        body_scores.append(_body_raw_score(metrics, char_share, block_share, size_ratio, level["slide_count"]))
        title_scores.append(_title_raw_score(metrics, size_ratio))

    body_probs = _softmax(body_scores, temperature=0.25)
    title_probs = _softmax(title_scores, temperature=0.25)
    for index, level in enumerate(levels):
        level["body_probability"] = round(body_probs[index], 2)
        level["slide_title_probability"] = round(title_probs[index], 2)
        level["role_hint"] = _role_hint(body_probs[index], title_probs[index])
    return list(zip((level["scale_level"] for level in levels), body_scores))


def _body_raw_score(metrics, char_share, block_share, size_ratio, slide_count):
    avg_chars = metrics["avg_char_count"]
    if avg_chars < 8 or size_ratio > 0.45:
        return 0.0

    prior = _gaussian(size_ratio, center=0.22, spread=0.12)
    if avg_chars < 24:
        prior *= avg_chars / 24

    usage = 0.80 * char_share + 0.15 * block_share + 0.05 * min(slide_count / 20, 1.0)
    geometry = (
        0.35 * metrics["multiline_ratio"] +
        0.30 * metrics["below_other_ratio"] +
        0.20 * min((metrics["y_spread"] or 0) * 2.5, 1.0) +
        0.15 * _area_body_score(metrics["avg_area_ratio"])
    )
    return prior * (0.75 * usage + 0.25 * geometry)


def _title_raw_score(metrics, size_ratio):
    avg_chars = metrics["avg_char_count"]
    if avg_chars > 120 or avg_chars < 3:
        return 0.0

    prior = _gaussian(size_ratio, center=0.55, spread=0.14)
    if size_ratio > 0.72:
        prior *= 0.45
    if size_ratio < 0.18:
        prior *= 0.35

    short_text = 1.0 - min(avg_chars / 70, 1.0)
    signals = (
        0.35 * metrics["single_on_slide_ratio"] +
        0.30 * metrics["top_zone_ratio"] +
        0.20 * short_text +
        0.15 * (1 - metrics["multiline_ratio"])
    )
    return prior * signals


def _area_body_score(area):
    if area is None:
        return 0.5
    if 0.02 <= area <= 0.35:
        return 1.0 - min(abs(area - 0.12) / 0.18, 1.0)
    return max(0.0, 0.35 - min(abs(area - 0.12), 0.35)) / 0.35


def _role_hint(body_probability, title_probability):
    if body_probability >= 0.34 and body_probability > title_probability * 1.25:
        return "body"
    if title_probability >= 0.34 and title_probability > body_probability * 1.25:
        return "slide_title"
    if body_probability >= 0.22 and title_probability >= 0.22:
        return "mixed"
    return "other"


def _size_ratio(size_pt, min_size, max_size):
    if max_size <= min_size:
        return 0.5
    return (size_pt - min_size) / (max_size - min_size)


def _gaussian(value, center, spread):
    return math.exp(-((value - center) ** 2) / (2 * spread ** 2))


def _softmax(values, temperature=1.0):
    if not values:
        return []
    peak = max(values)
    if peak <= 0:
        return [0.0] * len(values)
    scale = max(temperature, 0.05)
    weights = [math.exp((value - peak) / scale) for value in values]
    total = sum(weights)
    return [weight / total for weight in weights]


def _std_dev(values):
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return variance ** 0.5
