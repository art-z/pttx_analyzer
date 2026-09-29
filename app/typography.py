from collections import Counter, defaultdict
import re
from .pptx import PPTXPackage
from .slide_geometry import has_visible_slide_text, slide_size_pt, visible_shape_context
from .line_height import line_height_applicable
from .text_slots import extract_text_slots
from .typography_usage import analyze_typography_usage

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}

def extract_typography(package: PPTXPackage, theme: dict) -> dict:
    slide_size = slide_size_pt(package)
    use_visible_slides = has_visible_slide_text(package, slide_size)
    styles = Counter()
    families = Counter()
    sizes = Counter()
    actual_uses = Counter()
    run_heights = defaultdict(Counter)
    pptx_line_spacing_ratios = defaultdict(Counter)
    text_slides = defaultdict(set)

    slide_parts = [part for part in package.list("ppt/slides/") if part.endswith(".xml")]
    template_parts = [part for part in package.list("ppt/slideLayouts/") + package.list("ppt/slideMasters/") if part.endswith(".xml")]
    parts = slide_parts if use_visible_slides else slide_parts + template_parts

    for part in parts:
        root = package.xml(part)
        slide_match = re.search(r"ppt/slides/slide(\d+)\.xml$", part)
        slide_number = int(slide_match.group(1)) if slide_match else None
        from_slides = slide_number is not None

        for run in root.findall(".//a:r", NS):
            text = run.find("a:t", NS)
            has_text = text is not None and bool((text.text or "").strip())
            if from_slides and use_visible_slides:
                if not has_text:
                    continue
                if visible_shape_context(run, slide_size) is None:
                    continue

            rpr = run.find("a:rPr", NS)
            if rpr is None:
                continue
            latin = rpr.find("a:latin", NS)
            family = latin.get("typeface") if latin is not None else None
            size_raw = rpr.get("sz")
            size_pt = int(size_raw) / 100 if size_raw is not None else None
            bold = _bool(rpr.get("b"))
            italic = _bool(rpr.get("i"))
            underline = rpr.get("u")
            spacing_raw = rpr.get("spc")
            letter_spacing_pt = int(spacing_raw) / 100 if spacing_raw is not None else None

            style = (family, size_pt, bold, italic, underline, letter_spacing_pt)
            styles[style] += 1
            if size_pt is not None and has_text:
                key = (family or "Наследуется", size_pt)
                actual_uses[key] += 1
                if slide_number is not None:
                    text_slides[key].add(slide_number)
                height = _paragraph_line_height(run.getparent(), size_pt)
                if height is not None:
                    run_heights[key][height] += 1
                paragraph = run.getparent()
                ln = paragraph.find("a:pPr/a:lnSpc", NS) if paragraph is not None else None
                if ln is not None and len(ln):
                    child = ln[0]
                    if child.tag.endswith("spcPct") and child.get("val") is not None:
                        try:
                            ratio = round(int(child.get("val")) / 100000, 3)
                            pptx_line_spacing_ratios[key][ratio] += 1
                        except ValueError:
                            pass
            if family:
                families[family] += 1
            if size_pt is not None:
                sizes[size_pt] += 1

    line_spacings = Counter()
    for part in parts:
        root = package.xml(part)
        slide_match = re.search(r"ppt/slides/slide(\d+)\.xml$", part)
        from_slides = slide_match is not None
        for ppr in root.findall(".//a:pPr", NS):
            if from_slides and use_visible_slides:
                paragraph = ppr.getparent()
                if paragraph is None or visible_shape_context(paragraph, slide_size) is None:
                    continue
                if not any((run.find("a:t", NS) is not None and (run.find("a:t", NS).text or "").strip()) for run in paragraph.findall("a:r", NS)):
                    continue
            ln = ppr.find("a:lnSpc", NS)
            if ln is None or len(ln) == 0:
                continue
            child = ln[0]
            kind = child.tag.split("}")[-1]
            val = child.get("val")
            if val:
                line_spacings[(kind, val)] += 1

    text_slots = extract_text_slots(package, theme, slide_size=slide_size, use_visible_slides=use_visible_slides)
    slot_slides = defaultdict(set)
    for slot in text_slots["slide_instances"]:
        for level in slot["levels"]:
            if level.get("size_pt") is not None:
                key = (level.get("family") or "Наследуется", level["size_pt"])
                slot_slides[key].update(slot["slide_numbers"])
    type_scales = _build_type_scales(
        text_slots["slot_styles"],
        actual_uses,
        run_heights,
        text_slides,
        slot_slides,
        pptx_line_spacing_ratios,
    )
    scale_usage = analyze_typography_usage(package, theme, type_scales, slide_size=slide_size, use_visible_slides=use_visible_slides)
    return {
        "text_slots": text_slots,
        "type_scales": type_scales,
        "scale_usage": scale_usage,
        "visibility": {
            "uses_visible_slide_text": use_visible_slides,
            "slide_size_pt": {"width": slide_size[0], "height": slide_size[1]} if slide_size else None,
        },
        "families": [{"family": k, "occurrences": v} for k, v in families.most_common()],
        "sizes": [{"size_pt": k, "occurrences": v} for k, v in sizes.most_common()],
        "styles": [{
            "family": k[0], "size_pt": k[1], "bold": k[2], "italic": k[3],
            "underline": k[4], "letter_spacing_pt": k[5], "occurrences": v
        } for k, v in styles.most_common()],
        "line_spacings": [{
            "type": k[0], "raw": k[1],
            "value": (int(k[1]) / 100000 if k[0] == "spcPct" else int(k[1]) / 100),
            "unit": ("ratio" if k[0] == "spcPct" else "pt"),
            "occurrences": v
        } for k, v in line_spacings.most_common()]
    }

def _bool(value):
    return value in {"1", "true", "True"}


def _paragraph_line_height(paragraph, size_pt):
    spacing = paragraph.find("a:pPr/a:lnSpc", NS)
    if spacing is None or len(spacing) == 0:
        return None
    child = spacing[0]
    try:
        value = int(child.get("val"))
    except (TypeError, ValueError):
        return None
    if child.tag.endswith("spcPct"):
        ratio = value / 100000
        if not line_height_applicable(ratio, size_pt=size_pt):
            return None
        return round(size_pt * ratio, 2)
    if child.tag.endswith("spcPts"):
        line_height_pt = round(value / 100, 2)
        if not line_height_applicable(size_pt=size_pt, line_height_pt=line_height_pt):
            return None
        return line_height_pt
    return None


def _build_type_scales(slot_styles, actual_uses, run_heights, text_slides, slot_slides, pptx_line_spacing_ratios=None):
    pptx_line_spacing_ratios = pptx_line_spacing_ratios or {}
    slot_by_pair = {(style["family"], style["size_pt"]): style for style in slot_styles}
    pairs = set(slot_by_pair) | set(actual_uses)
    by_family = defaultdict(list)
    for family, size in pairs:
        slot = slot_by_pair.get((family, size), {})
        slot_heights = Counter()
        if slot.get("line_height_source") == "font_size":
            slot_heights.update({item["height_pt"]: item["occurrences"] for item in slot.get("line_height_variants", [])})
        text_heights = run_heights.get((family, size), Counter())
        heights = Counter()
        heights.update(slot_heights)
        heights.update(text_heights)
        if heights:
            height = sorted(heights.items(), key=lambda item: (-item[1], item[0]))[0][0]
            height_source = "font_size"
        else:
            height = slot.get("line_height_pt")
            height_source = slot.get("line_height_source")
        ratio = round(height / size, 2) if height is not None and size else None
        pptx_ratios = pptx_line_spacing_ratios.get((family, size), Counter())
        common_pptx_ratio = sorted(pptx_ratios.items(), key=lambda item: (-item[1], item[0]))[0][0] if pptx_ratios else None
        applicable = ratio is not None and line_height_applicable(ratio)
        by_family[family].append({
            "size_pt": size,
            "line_height_pt": height if applicable else None,
            "line_height_ratio": ratio if applicable else None,
            "line_height_applicable": applicable,
            "pptx_line_spacing_ratio": common_pptx_ratio if common_pptx_ratio is not None and not applicable else None,
            "line_height_source": height_source,
            "line_height_samples": heights[height] if heights else slot.get("line_height_samples", 0),
            "height_text_occurrences": text_heights[height] if height is not None else 0,
            "height_slot_occurrences": slot_heights[height] if height is not None else 0,
            "text_occurrences": actual_uses[(family, size)],
            "slot_occurrences": slot.get("occurrences", 0),
            "text_slide_numbers": sorted(text_slides.get((family, size), set())),
            "slot_slide_numbers": sorted(slot_slides.get((family, size), set())),
        })

    scales = []
    for family, entries in by_family.items():
        sizes = sorted(_unify_near_sizes(entries), key=lambda item: item["size_pt"])
        _mark_display_extensions(sizes)
        for index, item in enumerate(sizes):
            item["scale_level"] = index
        scales.append({
            "family": family,
            "text_occurrences": sum(item["text_occurrences"] for item in sizes),
            "levels": list(reversed(sizes)),
        })
    return sorted(scales, key=lambda scale: (-scale["text_occurrences"], scale["family"]))


def _mark_display_extensions(sizes):
    """Accept observed display sizes that continue above the confirmed scale.

    These remain an inference: the text exists, but the size has no matching
    template slot. A plausible successive modular jump is 1.2–2.1 times.
    """
    confirmed = [item["size_pt"] for item in sizes if item["size_confidence"] == "high"]
    if not confirmed:
        return
    anchor = max(confirmed)
    for item in sizes:
        size = item["size_pt"]
        if size <= anchor or item["size_confidence"] != "medium" or not item["text_occurrences"]:
            continue
        ratio = size / anchor
        if 1.2 <= ratio <= 2.1:
            item["size_confidence"] = "extended"
            item["extension_from_pt"] = anchor
            item["extension_ratio"] = round(ratio, 2)
            anchor = size


def _unify_near_sizes(entries):
    """Group raw size noise, then merge adjacent groups with matching rhythm."""
    ordered = sorted(entries, key=lambda item: (-_evidence_weight(item["text_occurrences"], item["slot_occurrences"]), item["size_pt"]))
    groups = []
    for entry in ordered:
        options = []
        for group in groups:
            anchor = group[0]["size_pt"]
            tolerance = max(0.35, anchor * 0.025)
            sizes = [item["size_pt"] for item in group]
            if abs(entry["size_pt"] - anchor) <= tolerance and max(sizes + [entry["size_pt"]]) - min(sizes + [entry["size_pt"]]) <= tolerance:
                options.append((abs(entry["size_pt"] - anchor), group))
        if options:
            min(options, key=lambda option: option[0])[1].append(entry)
        else:
            groups.append([entry])

    # The first pass keeps a narrow size tolerance. A second pass can join
    # neighboring groups when their dominant line heights and ratios agree.
    # This catches e.g. 6.38 pt next to a 6.75/7 pt group without merging
    # unrelated adjacent sizes solely because they are close numerically.
    second_pass = []
    for group in sorted(groups, key=lambda items: -sum(_evidence_weight(item["text_occurrences"], item["slot_occurrences"]) for item in items)):
        anchor = group[0]
        destination = None
        for existing in second_pass:
            main = existing[0]
            size_tolerance = max(0.45, min(0.75, main["size_pt"] * 0.04))
            if abs(anchor["size_pt"] - main["size_pt"]) > size_tolerance:
                continue
            main_height = _dominant_height(existing)
            other_height = _dominant_height(group)
            if main_height is None or other_height is None:
                continue
            main_ratio = main_height["line_height_pt"] / main_height["size_pt"]
            other_ratio = other_height["line_height_pt"] / other_height["size_pt"]
            if abs(main_ratio - other_ratio) > 0.1:
                continue
            height_tolerance = max(0.5, min(1.0, main_height["line_height_pt"] * 0.05))
            if abs(main_height["line_height_pt"] - other_height["line_height_pt"]) > height_tolerance:
                continue
            destination = existing
            break
        if destination is None:
            second_pass.append(group)
        else:
            destination.extend(group)

    unified = []
    used_sizes = set()
    for group in second_pass:
        anchor = group[0]
        original_size = anchor["size_pt"]
        snapped = round(original_size * 2) / 2
        snap_tolerance = max(0.3 if len(group) > 1 else 0.2, original_size * 0.02)
        canonical = snapped if abs(snapped - original_size) <= snap_tolerance else original_size
        if canonical in used_sizes:
            canonical = original_size
        used_sizes.add(canonical)

        height_anchor = _dominant_height(group)
        ratio = round(height_anchor["line_height_pt"] / height_anchor["size_pt"], 2) if height_anchor else None
        text_count = sum(item["text_occurrences"] for item in group)
        slot_count = sum(item["slot_occurrences"] for item in group)
        matching_heights = [item for item in group if ratio is not None and item["line_height_pt"] is not None
                            and abs(item["line_height_pt"] / item["size_pt"] - ratio) <= 0.06]
        height_text_count = sum(item.get("height_text_occurrences", 0) for item in matching_heights)
        height_slot_count = sum(item.get("height_slot_occurrences", 0) for item in matching_heights)
        line_height_pt = round(canonical * ratio, 2) if ratio is not None else None
        applicable = ratio is not None and line_height_applicable(ratio)
        pptx_ratio = next((item.get("pptx_line_spacing_ratio") for item in group if item.get("pptx_line_spacing_ratio") is not None), None)
        unified.append({
            "size_pt": canonical,
            "line_height_pt": line_height_pt if applicable else None,
            "line_height_ratio": ratio if applicable else None,
            "line_height_applicable": applicable,
            "pptx_line_spacing_ratio": pptx_ratio if not applicable else None,
            "line_height_source": height_anchor["line_height_source"] if height_anchor else None,
            "line_height_samples": height_anchor["line_height_samples"] if height_anchor else 0,
            "height_confidence": "high" if height_text_count and height_slot_count else "medium" if height_text_count or height_slot_count else "low" if ratio is not None else "unknown",
            "text_occurrences": text_count,
            "slot_occurrences": slot_count,
            "text_slide_numbers": sorted({number for item in group for number in item.get("text_slide_numbers", [])}),
            "slot_slide_numbers": sorted({number for item in group for number in item.get("slot_slide_numbers", [])}),
            "size_confidence": "high" if text_count and slot_count else "medium" if text_count else "low",
            "evidence_weight": round(_evidence_weight(text_count, slot_count), 2),
            "original_sizes_pt": sorted(item["size_pt"] for item in group),
        })
    return unified


def _dominant_height(group):
    known = [item for item in group if item["line_height_pt"] is not None]
    exact = [item for item in known if item["line_height_source"] != "size"]
    candidates = exact or known
    return sorted(candidates, key=lambda item: (
        -_evidence_weight(item["text_occurrences"], item["slot_occurrences"]), -item["line_height_samples"], item["size_pt"]
    ))[0] if candidates else None


def _evidence_weight(text_count, slot_count):
    if text_count:
        return text_count * (1.5 if slot_count else 1.0) + min(slot_count, text_count) * 0.25
    return min(slot_count, 20) * 0.1
