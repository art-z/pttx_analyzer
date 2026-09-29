import unittest

from app.circular_chart_inference import build_circular_chart_size_profiles
from app.graphic_baselines import enrich_graphic_components_with_baselines


class GraphicBaselinesTests(unittest.TestCase):
    def test_largest_circular_size_controls_default_geometry_and_center_type(self):
        def instance(diameter, size, confidence, index):
            return {
                "source": "image_center_label",
                "confidence": confidence,
                "chart_type_guess": "doughnut",
                "plot_region_norm": {
                    "x": 0.1 + index * 0.17,
                    "y": 0.3,
                    "width": diameter / 960,
                    "height": diameter / 540,
                },
                "plot_region_pt": {
                    "x_pt": 100 + index * 160,
                    "y_pt": 160,
                    "width_pt": diameter,
                    "height_pt": diameter,
                },
                "squareness": 1.0,
                "center_metric": {
                    "value": str(index + 1),
                    "unit": "%",
                    "value_typography": {"family": "Play", "size_pt": size},
                    "unit_typography": {"family": "Play", "size_pt": size * 0.6},
                },
                "center_metric_fit": {"required_hole_size": 64, "inner_free_radius_pt": diameter * 0.32},
            }

        instances = [
            instance(150, 18, 0.82, 0),
            instance(152, 20, 0.83, 1),
            instance(148, 20, 0.84, 2),
            instance(151, 22, 0.85, 3),
            instance(330, 48, 0.99, 4),
        ]
        slides = {
            "slides": [{
                "slide_number": 46,
                "render": {"slide_size_pt": {"width": 960, "height": 540}},
                "content_elements": [],
                "inferred_circular_charts": instances,
            }],
            "summary": {"circular_chart_size_profiles": build_circular_chart_size_profiles(instances)},
        }
        catalog = enrich_graphic_components_with_baselines(
            {"tables": [], "charts": [], "diagrams": [], "summary": {}},
            slides,
        )
        doughnut = next(item for item in catalog["charts"] if item["chart_type"] == "doughnut")
        self.assertAlmostEqual(doughnut["default_geometry_pt"]["width_pt"], 330, delta=1)
        self.assertAlmostEqual(doughnut["baseline_preview"]["geometry_pt"]["width_pt"], 330, delta=3)
        center = doughnut["style_tokens"]["circular_layout"]["center_metric"]
        self.assertEqual(center["value_typography"]["size_pt"], 48)

    def test_pie_reuses_doughnut_geometry_and_doughnut_uses_metric_hole(self):
        instance = {
            "source": "image_center_label",
            "confidence": 0.92,
            "chart_type_guess": "doughnut",
            "plot_region_norm": {"x": 0.2, "y": 0.24, "width": 0.25, "height": 0.44},
            "center_text": {"element_id": "metric", "text": "75%"},
            "center_metric": {
                "value": "75",
                "unit": "%",
                "value_typography": {"family": "Play", "size_pt": 30},
                "unit_typography": {"family": "Play", "size_pt": 18},
            },
            "center_metric_fit": {"required_hole_size": 62, "inner_free_radius_pt": 70},
            "consumed_element_ids": ["ring", "metric"],
        }
        slides = {"slides": [{
            "slide_number": 1,
            "render": {"slide_size_pt": {"width": 960, "height": 540}},
            "content_elements": [],
            "inferred_circular_charts": [instance],
        }]}
        catalog = enrich_graphic_components_with_baselines(
            {"tables": [], "charts": [], "diagrams": [], "summary": {}},
            slides,
        )
        pie = next(item for item in catalog["charts"] if item["chart_type"] == "pie")
        doughnut = next(item for item in catalog["charts"] if item["chart_type"] == "doughnut")
        self.assertEqual(pie["baseline_preview"]["geometry_pt"], doughnut["baseline_preview"]["geometry_pt"])
        self.assertEqual(doughnut["subtype"]["hole_size"], 64)
        self.assertEqual(doughnut["center_metric_preview"], {"value": "75", "unit": "%"})

    def test_rectangular_source_image_uses_min_side_as_circle_diameter(self):
        instance = {
            "source": "image_center_label",
            "confidence": 0.95,
            "chart_type_guess": "doughnut",
            "plot_region_norm": {"x": 0.1, "y": 0.2, "width": 400 / 960, "height": 300 / 540},
            "plot_region_pt": {"x_pt": 96, "y_pt": 108, "width_pt": 400, "height_pt": 300},
            "center_metric": {
                "value": "42",
                "unit": "%",
                "value_typography": {"size_pt": 48, "bold": False},
                "unit_typography": {"size_pt": 30, "bold": False},
            },
            "center_metric_fit": {"required_hole_size": 64, "inner_free_radius_pt": 96},
        }
        slides = {
            "slides": [{
                "slide_number": 46,
                "render": {"slide_size_pt": {"width": 960, "height": 540}},
                "content_elements": [],
                "inferred_circular_charts": [instance],
            }],
            "summary": {"circular_chart_size_profiles": build_circular_chart_size_profiles([instance])},
        }
        catalog = enrich_graphic_components_with_baselines(
            {"tables": [], "charts": [], "diagrams": [], "summary": {}},
            slides,
        )
        doughnut = next(item for item in catalog["charts"] if item["chart_type"] == "doughnut")
        self.assertEqual(doughnut["default_geometry_pt"], {"width_pt": 300.0, "height_pt": 300.0})
        preview = doughnut["baseline_preview"]
        plot_height = preview["geometry_pt"]["height_pt"] * preview["plot_region_norm"]["height"]
        self.assertAlmostEqual(preview["geometry_pt"]["width_pt"], 300, delta=0.2)
        self.assertAlmostEqual(plot_height, 300, delta=0.2)

    def test_adds_missing_chart_and_diagram_baselines(self):
        catalog = enrich_graphic_components_with_baselines({
            "tables": [],
            "charts": [{"chart_type": "bar", "variant_signature": "chart|bar|native", "component_id": "cht_001"}],
            "diagrams": [],
            "summary": {},
        })

        chart_types = {item["chart_type"] for item in catalog["charts"]}
        self.assertIn("bar", chart_types)
        self.assertIn("line", chart_types)
        self.assertIn("area", chart_types)
        self.assertIn("pie", chart_types)
        self.assertIn("doughnut", chart_types)

        diagram_types = {item["diagram_type"] for item in catalog["diagrams"]}
        self.assertEqual(diagram_types, {"flow", "process"})

        self.assertIn("groups", catalog)
        self.assertEqual(catalog["groups"]["charts"]["label"], "Графики")
        self.assertGreaterEqual(catalog["summary"]["baseline_chart_count"], 4)

    def test_adds_table_baselines_when_missing(self):
        catalog = enrich_graphic_components_with_baselines({
            "tables": [],
            "charts": [],
            "diagrams": [],
            "summary": {},
        })

        signatures = {item["variant_signature"] for item in catalog["tables"]}
        self.assertIn("table|native|baseline", signatures)
        self.assertIn("table|inferred_grid|baseline", signatures)
        self.assertEqual(catalog["summary"]["baseline_table_count"], 2)

    def test_inferred_pseudo_chart_styles_enrich_missing_chart_baselines(self):
        style_tokens = {
            "category_axis": {"visible": True, "typography": {"family": "Play", "size_pt": 12}},
            "value_axis": {"visible": True, "typography": {"family": "Play", "size_pt": 12}},
            "axis_line": {"visible": False, "color": "#FFFFFF", "width_pt": 0.37},
            "grid_line": {
                "visible": True,
                "horizontal_visible": True,
                "vertical_visible": False,
                "horizontal_count": 5,
                "vertical_count": 0,
                "color": "#FFFFFF",
                "width_pt": 0.37,
            },
        }
        catalog = enrich_graphic_components_with_baselines(
            {"tables": [], "charts": [], "diagrams": [], "summary": {}},
            {"slides": [{
                "slide_number": 52,
                "inferred_chart": {
                    "confidence": 0.98,
                    "style_tokens": style_tokens,
                    "signals": {"x_axis_label_count": 6, "y_axis_label_count": 5},
                },
            }]},
        )
        area = next(item for item in catalog["charts"] if item["chart_type"] == "area")
        self.assertEqual(area["style_tokens"]["grid_line"]["width_pt"], 0.37)
        self.assertFalse(area["style_tokens"]["grid_line"]["vertical_visible"])
        self.assertFalse(area["style_tokens"]["axis_line"]["visible"])


if __name__ == "__main__":
    unittest.main()
