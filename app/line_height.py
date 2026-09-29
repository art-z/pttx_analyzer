"""Heuristics for when PPTX lnSpc values should drive CSS line-height."""

# Ratios below ~0.75 usually come from single-line card labels / display numbers
# (e.g. spcPct 64300 → 0.643×), not real body copy rhythm.
LINE_HEIGHT_RATIO_MIN = 0.75
LINE_HEIGHT_RATIO_MAX = 2.5


def line_height_ratio_value(
    ratio: float | None,
    *,
    size_pt: float | None = None,
    line_height_pt: float | None = None,
) -> float | None:
    if ratio is not None:
        return float(ratio)
    if line_height_pt is not None and size_pt:
        return float(line_height_pt) / float(size_pt)
    return None


def line_height_applicable(
    ratio: float | None = None,
    *,
    size_pt: float | None = None,
    line_height_pt: float | None = None,
) -> bool:
    """True when lnSpc looks like a normal body-text line height, not a single-line artifact."""
    resolved = line_height_ratio_value(ratio, size_pt=size_pt, line_height_pt=line_height_pt)
    if resolved is None:
        return False
    return LINE_HEIGHT_RATIO_MIN <= resolved <= LINE_HEIGHT_RATIO_MAX
