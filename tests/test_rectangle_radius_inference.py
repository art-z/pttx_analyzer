from app.rectangle_radius_inference import apply_rectangle_radius_inference
from app.graphic_baselines import enrich_graphic_components_with_baselines


def rectangle(element_id: str, radius_pt: float, *, x: float = 0.1) -> dict:
    payload = {
        "element_id": element_id,
        "kind": "fill",
        "geometry_pt": {"x_pt": x * 960, "y_pt": 160, "width_pt": 40, "height_pt": 120},
        "geometry_norm": {"x": x, "y": 0.3, "width": 40 / 960, "height": 120 / 540},
    }
    if radius_pt:
        payload["mask"] = {
            "kind": "roundRect",
            "corner_radius_pt": radius_pt,
            "corner_radii_pt": [radius_pt] * 4,
        }
    return payload


def test_bar_candidate_radii_outweigh_generic_rectangles():
    generic = [rectangle(f"generic-{index}", 0, x=0.05 + index * 0.05) for index in range(6)]
    bars = [rectangle("bar-1", 8, x=0.5), rectangle("bar-2", 8, x=0.6)]
    slide = {
        "slide_number": 1,
        "content_elements": generic + bars,
        "inferred_chart": {
            "chart_type_guess": "bar",
            "bar_element_ids": ["bar-1", "bar-2"],
            "style_tokens": {},
        },
    }
    slides = {"slides": [slide], "summary": {}}
    apply_rectangle_radius_inference(slides, (960, 540))

    series = slide["inferred_chart"]["style_tokens"]["series_geometry"]
    assert series["corner_radius_pt"] == 8
    assert series["corner_radius_ratio"] == 0.2
    profile = slides["summary"]["rectangle_radius_profile"]
    assert profile["corner_radius_pt"] == 8
    assert profile["source"] == "bar_chart_candidate"
    assert slides["summary"]["rectangle_radius_profiles"]["bar_chart"]["sample_count"] == 2


def test_sharp_bar_candidate_is_not_overridden_by_rounded_decorations():
    decorations = [rectangle(f"card-{index}", 10, x=0.05 + index * 0.05) for index in range(5)]
    bars = [rectangle("bar-1", 0, x=0.5), rectangle("bar-2", 0, x=0.6)]
    slide = {
        "slide_number": 1,
        "content_elements": decorations + bars,
        "inferred_chart": {
            "chart_type_guess": "bar",
            "bar_element_ids": ["bar-1", "bar-2"],
            "style_tokens": {},
        },
    }
    slides = {"slides": [slide], "summary": {}}
    apply_rectangle_radius_inference(slides, (960, 540))
    assert slide["inferred_chart"]["style_tokens"]["series_geometry"]["corner_radius_pt"] == 0
    assert slides["summary"]["rectangle_radius_profile"]["corner_radius_pt"] == 0
    assert slides["summary"]["rectangle_radius_profiles"]["bar_chart"]["corner_radius_pt"] == 0


def test_diagram_candidate_radius_is_written_to_node_style():
    nodes = [rectangle("node-1", 6), rectangle("node-2", 6, x=0.4)]
    slide = {
        "slide_number": 1,
        "content_elements": nodes,
        "inferred_diagram": {
            "diagram_type_guess": "flow",
            "node_element_ids": ["node-1", "node-2"],
            "style_tokens": {"node": {"fill": {"color": "#FFFFFF"}}},
        },
    }
    slides = {"slides": [slide], "summary": {}}
    apply_rectangle_radius_inference(slides, (960, 540))
    node = slide["inferred_diagram"]["style_tokens"]["node"]
    assert node["radius_pt"] == 6
    assert node["radius_ratio"] == 0.15
    assert node["radius_source"] == "diagram_candidate"


def test_role_specific_profiles_are_applied_to_graphic_baselines():
    slides = {
        "slides": [],
        "summary": {
            "rectangle_radius_profile": {"sample_count": 20, "corner_radius_pt": 0, "corner_radius_ratio": 0},
            "rectangle_radius_profiles": {
                "bar_chart": {
                    "sample_count": 6,
                    "corner_radius_pt": 7.5,
                    "corner_radius_ratio": 0.12,
                    "source": "bar_chart_candidate",
                },
                "diagram": {
                    "sample_count": 4,
                    "corner_radius_pt": 10,
                    "corner_radius_ratio": 0.2,
                    "source": "diagram_candidate",
                },
            },
        },
    }
    catalog = enrich_graphic_components_with_baselines(
        {"tables": [], "charts": [], "diagrams": [], "summary": {}},
        slides,
    )
    bar = next(item for item in catalog["charts"] if item.get("chart_type") == "bar")
    flow = next(item for item in catalog["diagrams"] if item.get("diagram_type") == "flow")
    assert bar["style_tokens"]["series_geometry"]["corner_radius_ratio"] == 0.12
    assert flow["style_tokens"]["node"]["radius_pt"] == 10
