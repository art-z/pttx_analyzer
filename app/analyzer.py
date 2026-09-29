import json
from pathlib import Path
from .pptx import PPTXPackage
from .assets import extract_assets
from .theme import extract_theme
from .typography import extract_typography
from .colors import extract_colors
from .stats import build_stats
from .content_margins import analyze_content_margins, apply_content_margins_to_slides
from .spatial_analysis import analyze_spatial_rules
from .catalog_component_detection import detect_catalog_components
from .pagination_detection import detect_pagination
from .slide_catalog import extract_slide_catalog
from .slide_patterns import detect_slide_patterns
from .slide_templates import extract_slide_templates
from .graphic_components import extract_graphic_components
from .graphic_baselines import enrich_graphic_components_with_baselines
from .chart_palette import (
    build_chart_series_palette,
    extract_design_system_chart_colors,
    extract_design_system_text_colors,
)
from .visual_component_detection import detect_visual_components, merge_component_catalogs
from .slide_semantics import build_slide_semantics
from .layout_table_inference import apply_layout_table_inference
from .chart_region_inference import apply_chart_region_inference
from .circular_chart_inference import apply_circular_chart_inference
from .diagram_region_inference import apply_diagram_region_inference
from .narrative_components import apply_narrative_component_inference
from .rectangle_radius_inference import apply_rectangle_radius_inference
from .terminal_slide_candidates import annotate_terminal_slide_candidates


def analyze(pptx: Path, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    with PPTXPackage(pptx) as package:
        assets = extract_assets(package, output)
        theme = extract_theme(package)
        typography = extract_typography(package, theme)
        colors = extract_colors(package, theme)
        slide_size = None
        slide_size_pt = typography.get("visibility", {}).get("slide_size_pt")
        if slide_size_pt:
            slide_size = (slide_size_pt["width"], slide_size_pt["height"])
        typography["spatial"] = analyze_spatial_rules(
            typography["scale_usage"]["text_blocks"],
            typography["scale_usage"]["scale_roles"],
            slide_size,
            typography.get("text_slots"),
            assets,
        )
        typography["pagination"] = detect_pagination(
            package,
            typography["scale_usage"]["text_blocks"],
            assets,
            slide_size,
            theme,
        )
        slide_templates = extract_slide_templates(
            package,
            theme,
            typography.get("text_slots"),
            assets,
            colors,
            slide_size,
        )
        slides = extract_slide_catalog(
            package,
            theme,
            slide_templates,
            slide_size,
        )
        pattern_result = detect_slide_patterns(slides, assets)
        slides["patterns"] = pattern_result["patterns"]
        slides["summary"]["pattern_count"] = pattern_result["summary"]["pattern_count"]
        slides["summary"]["pattern_instance_count"] = pattern_result["summary"]["instance_count"]
        typography["components"] = detect_catalog_components(
            slides,
            assets,
            typography["scale_usage"]["text_blocks"],
        )
        visual_components = detect_visual_components(slides, assets)
        typography["components"] = merge_component_catalogs(
            typography["components"],
            visual_components,
        )
        slide_semantics = build_slide_semantics(
            slides,
            slide_templates,
            typography["components"],
        )
        slides = slide_semantics["slides"]
        typography["components"] = slide_semantics["component_registry"]
        content_margins = analyze_content_margins(
            slides.get("slides"),
            typography.get("visibility", {}).get("slide_size_pt"),
        )
        apply_content_margins_to_slides(slides, content_margins)
        apply_layout_table_inference(slides, slide_size)
        apply_chart_region_inference(slides, slide_size)
        apply_diagram_region_inference(slides, slide_size)
        apply_rectangle_radius_inference(slides, slide_size)
        apply_circular_chart_inference(slides, slide_size)
        narrative_components = apply_narrative_component_inference(
            slides,
            slide_templates,
            slide_semantics["shell_templates"],
        )
        annotate_terminal_slide_candidates(slides, typography, slide_templates)
        graphic_components = extract_graphic_components(slides)
        chart_series_palette = build_chart_series_palette(slides, graphic_components)
        graphic_components["chart_series_palette"] = chart_series_palette
        graphic_components["circular_chart_size_profiles"] = slides.get("summary", {}).get("circular_chart_size_profiles") or []
        design_system_palette = extract_design_system_chart_colors(colors)
        design_system_text_colors = extract_design_system_text_colors(colors)
        graphic_components = enrich_graphic_components_with_baselines(
            graphic_components,
            slides,
            slide_semantics["shell_templates"],
            chart_series_palette=chart_series_palette,
            design_system_palette=design_system_palette,
            design_system_text_colors=design_system_text_colors,
            spatial=typography.get("spatial"),
            content_margins=content_margins,
        )
    report = {
        "source": pptx.name,
        "theme": theme,
        "assets": assets,
        "typography": typography,
        "colors": colors,
        "slide_templates": slide_templates,
        "slides": slides,
        "layout": {
            "content_margins": content_margins,
        },
        "slide_semantics": {
            "component_registry": slide_semantics["component_registry"],
            "shell_templates": slide_semantics["shell_templates"],
            "summary": slide_semantics["summary"],
        },
        "graphic_components": graphic_components,
        "narrative_components": narrative_components,
    }
    report["stats"] = build_stats(
        assets,
        typography,
        colors,
        theme,
        slide_templates,
        slides,
        graphic_components,
        narrative_components,
    )
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
