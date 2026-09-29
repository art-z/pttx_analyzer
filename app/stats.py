from collections import Counter

def build_stats(
    assets,
    typography,
    colors,
    theme,
    slide_templates=None,
    slides=None,
    graphic_components=None,
    narrative_components=None,
):
    media = assets.get("media_files", [])
    exact_groups = assets.get("exact_groups", [])
    visual_groups = assets.get("visual_groups", [])
    background_candidates = assets.get("background_candidates", [])
    icon_groups = assets.get("icon_groups", [])

    ext = Counter((a.get("extension") or "unknown") for a in media)

    reused_exact = sum(1 for g in exact_groups if g["occurrences"] > 1 or g["file_count"] > 1)
    reused_visual = sum(1 for g in visual_groups if g["occurrences"] > 1 or g["file_count"] > 1)

    return {
        "assets": {
            "media_files": len(media),
            "unique_exact_assets": len(exact_groups),
            "visually_unique_raster_assets": len(visual_groups),
            "reused_exact_assets": reused_exact,
            "reused_visual_raster_assets": reused_visual,
            "total_asset_occurrences": sum(a.get("occurrences", 0) for a in media),
            "background_candidates": len(background_candidates),
            "icon_groups": len(icon_groups),
            "icon_files": sum(group["file_count"] for group in icon_groups),
            "by_type": dict(ext.most_common()),
        },
        "typography": {
            "font_families": len(typography.get("families", [])),
            "font_sizes": len(typography.get("sizes", [])),
            "styles": len(typography.get("styles", [])),
            "line_spacings": len(typography.get("line_spacings", [])),
            "template_slots": typography.get("text_slots", {}).get("summary", {}).get("template_slots", 0),
            "empty_template_slots": typography.get("text_slots", {}).get("summary", {}).get("empty_template_slots", 0),
            "spatial_components": len(typography.get("spatial", {}).get("components", [])),
            "detected_components": typography.get("components", {}).get("summary", {}).get("component_count", 0),
            "pagination_patterns": typography.get("pagination", {}).get("summary", {}).get("pattern_count", 0),
        },
        "colors": {"unique": len(colors.get("colors", []))},
        "theme": {"count": len(theme.get("themes", []))},
        "slide_templates": {
            "template_count": (slide_templates or {}).get("summary", {}).get("template_count", 0),
        },
        "slides": {
            "slide_count": (slides or {}).get("summary", {}).get("slide_count", 0),
            "element_totals": (slides or {}).get("summary", {}).get("element_totals", {}),
            "pattern_count": (slides or {}).get("summary", {}).get("pattern_count", 0),
        },
        "graphic_components": {
            "table_components": (graphic_components or {}).get("summary", {}).get("table_component_count", 0),
            "chart_components": (graphic_components or {}).get("summary", {}).get("chart_component_count", 0),
            "diagram_components": (graphic_components or {}).get("summary", {}).get("diagram_component_count", 0),
            "table_instances": (graphic_components or {}).get("summary", {}).get("table_instance_count", 0),
            "chart_instances": (graphic_components or {}).get("summary", {}).get("chart_instance_count", 0),
            "diagram_instances": (graphic_components or {}).get("summary", {}).get("diagram_instance_count", 0),
        },
        "narrative_components": {
            "quote_components": (narrative_components or {}).get("summary", {}).get("quote_component_count", 0),
            "snippet_components": (narrative_components or {}).get("summary", {}).get("snippet_component_count", 0),
            "quote_instances": (narrative_components or {}).get("summary", {}).get("quote_instance_count", 0),
            "snippet_instances": (narrative_components or {}).get("summary", {}).get("snippet_instance_count", 0),
        },
    }
