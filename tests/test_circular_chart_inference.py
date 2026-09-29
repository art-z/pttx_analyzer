import json
import unittest
from pathlib import Path

from app.circular_chart_inference import (
    apply_circular_chart_inference,
    build_circular_chart_size_profiles,
    extract_deck_circular_style,
    fit_center_metric_typography,
    infer_circular_charts_on_slide,
)


class CircularChartInferenceUnitTests(unittest.TestCase):
    def test_centered_non_metric_text_over_image_is_not_a_doughnut_candidate(self):
        slide = {
            "slide_number": 18,
            "content_elements": [
                {
                    "element_id": "photo",
                    "kind": "image",
                    "z_index": 10,
                    "geometry_norm": {"x": 0.25, "y": 0.25, "width": 0.3, "height": 0.5333},
                },
                {
                    "element_id": "body",
                    "kind": "text",
                    "z_index": 11,
                    "text": "Безопасность",
                    "geometry_norm": {"x": 0.31, "y": 0.48, "width": 0.18, "height": 0.06},
                    "typography": {"family": "Play", "size_pt": 32},
                },
            ],
        }
        self.assertEqual(infer_circular_charts_on_slide(slide, 960, 540), [])

    def test_centered_bare_number_over_image_is_a_doughnut_candidate(self):
        slide = {
            "slide_number": 1,
            "content_elements": [
                {
                    "element_id": "ring",
                    "kind": "image",
                    "z_index": 10,
                    "geometry_norm": {"x": 0.2, "y": 0.24, "width": 0.25, "height": 0.4444},
                },
                {
                    "element_id": "metric",
                    "kind": "text",
                    "z_index": 11,
                    "text": "42",
                    "geometry_norm": {"x": 0.29, "y": 0.43, "width": 0.07, "height": 0.06},
                    "typography": {"family": "Play", "size_pt": 28},
                },
            ],
        }
        instances = infer_circular_charts_on_slide(slide, 960, 540)
        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0]["center_metric"]["value"], "42")

    def test_center_metric_controls_required_hole_size(self):
        slide = {
            "slide_number": 1,
            "content_elements": [
                {
                    "element_id": "ring",
                    "kind": "image",
                    "geometry_norm": {"x": 0.2, "y": 0.24, "width": 0.25, "height": 0.4444},
                },
                {
                    "element_id": "metric",
                    "kind": "text",
                    "text": "75%",
                    "geometry_norm": {"x": 0.27, "y": 0.41, "width": 0.11, "height": 0.08},
                    "typography": {"family": "Play", "size_pt": 32},
                },
            ],
        }
        instances = infer_circular_charts_on_slide(slide, 960, 540)
        self.assertEqual(len(instances), 1)
        fit = instances[0]["center_metric_fit"]
        self.assertGreaterEqual(fit["required_hole_size"], 64)
        self.assertGreater(fit["inner_free_radius_pt"], 0)
        self.assertEqual(instances[0]["signals"]["has_center_metric"], True)

    def test_native_circular_chart_has_priority(self):
        slide = {
            "slide_number": 1,
            "content_elements": [{
                "element_id": "native_donut",
                "kind": "chart",
                "chart_type": "doughnut",
                "subtype": {"hole_size": 64},
                "geometry_norm": {"x": 0.2, "y": 0.2, "width": 0.3, "height": 0.5},
            }],
        }
        instances = infer_circular_charts_on_slide(slide, 960, 540)
        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0]["source"], "native_chart")
        self.assertEqual(instances[0]["confidence"], 1.0)
        self.assertEqual(instances[0]["center_metric_fit"]["required_hole_size"], 64)

    def test_unrelated_title_typography_is_not_used_for_default_center_metric(self):
        style = extract_deck_circular_style({"slides": [{
            "slide_number": 1,
            "content_elements": [{
                "kind": "text",
                "placeholder_type": "title",
                "geometry_norm": {"x": 0.05, "y": 0.05, "width": 0.8, "height": 0.1},
                "typography": {"family": "Play", "size_pt": 48, "bold": True},
            }],
        }]})
        self.assertEqual(style["center_metric_preview"], {"value": "42", "unit": "%"})
        self.assertNotIn("family", style["center_metric_template"]["value_typography"])
        self.assertEqual(style["center_metric_template"]["value_typography"]["size_pt"], 24.0)

    def test_center_metric_regular_weight_is_preserved(self):
        instance = {
            "confidence": 0.95,
            "chart_type_guess": "doughnut",
            "plot_region_pt": {"width_pt": 320, "height_pt": 300},
            "plot_region_norm": {"x": 0.1, "y": 0.2, "width": 0.33, "height": 0.56},
            "center_metric": {
                "value": "22",
                "unit": "%",
                "value_typography": {"family": "Play", "size_pt": 88, "bold": False},
                "unit_typography": {"family": "Play", "size_pt": 60, "bold": False},
            },
            "center_metric_fit": {"required_hole_size": 64, "inner_free_radius_pt": 96},
        }
        style = extract_deck_circular_style({"slides": [{
            "slide_number": 46,
            "inferred_circular_charts": [instance],
        }]})
        metric = style["center_metric_template"]
        self.assertIs(metric["value_typography"]["bold"], False)
        self.assertIs(metric["unit_typography"]["bold"], False)

    def test_center_metric_fit_only_shrinks_oversized_type(self):
        metric = {
            "value": "1000",
            "unit": "%",
            "value_typography": {"size_pt": 96},
            "unit_typography": {"size_pt": 60},
        }
        fitted, fit = fit_center_metric_typography(metric, diameter_pt=180, hole_size=64)
        self.assertLess(fitted["value_typography"]["size_pt"], 96)
        self.assertLess(fitted["unit_typography"]["size_pt"], 60)
        self.assertLess(fit["typography_scale"], 1)
        self.assertLessEqual(fit["estimated_text_width_pt"], fit["safe_text_width_pt"])


class CircularChartInferenceTests(unittest.TestCase):
    def setUp(self):
        self.report_path = Path("output/b13e9370de41/report.json")
        if not self.report_path.exists():
            self.skipTest("sample deck report missing")
        self.report = json.loads(self.report_path.read_text(encoding="utf-8"))
        size = self.report["typography"]["visibility"]["slide_size_pt"]
        self.slide_width = float(size["width"])
        self.slide_height = float(size["height"])

    def _slide(self, number: int):
        return next(slide for slide in self.report["slides"]["slides"] if slide["slide_number"] == number)

    def test_slide_45_detects_two_large_doughnuts(self):
        instances = infer_circular_charts_on_slide(self._slide(45), self.slide_width, self.slide_height)
        self.assertEqual(len(instances), 2)
        for instance in instances:
            self.assertGreaterEqual(instance["confidence"], 0.58)
            self.assertIn(instance["chart_type_guess"], {"pie", "doughnut"})
            self.assertGreaterEqual(instance["plot_region_norm"]["width"], 0.40)
            self.assertGreaterEqual(instance["signals"]["image_width_norm"], 0.40)

    def test_slide_46_detects_metric_center_doughnuts(self):
        instances = infer_circular_charts_on_slide(self._slide(46), self.slide_width, self.slide_height)
        self.assertGreaterEqual(len(instances), 5)
        metric_instances = [item for item in instances if item["signals"]["has_center_metric"]]
        self.assertGreaterEqual(len(metric_instances), 5)
        percent_instances = [item for item in instances if item["signals"]["metric_unit"] == "%"]
        self.assertGreaterEqual(len(percent_instances), 5)
        small = [item for item in instances if item["plot_region_norm"]["width"] < 0.25]
        large = [item for item in instances if item["plot_region_norm"]["width"] >= 0.25]
        self.assertGreaterEqual(len(small), 4)
        self.assertGreaterEqual(len(large), 1)

    def test_slide_46_small_doughnuts_consume_caption_texts(self):
        instances = infer_circular_charts_on_slide(self._slide(46), self.slide_width, self.slide_height)
        small = [item for item in instances if item["plot_region_norm"]["width"] < 0.25]
        self.assertEqual(len(small), 4)
        for instance in small:
            self.assertTrue(instance["signals"]["has_caption"])
            self.assertEqual((instance.get("caption_text") or {}).get("text"), "пояснение")
            caption_id = (instance.get("caption_text") or {}).get("element_id")
            self.assertIn(caption_id, instance["consumed_element_ids"])

    def test_size_profiles_from_slides_45_46(self):
        slides = {"slides": [self._slide(45), self._slide(46)]}
        apply_circular_chart_inference(slides, (self.slide_width, self.slide_height))
        profiles = slides["summary"]["circular_chart_size_profiles"]
        self.assertGreaterEqual(len(profiles), 2)
        size_classes = {profile["size_class"] for profile in profiles}
        self.assertIn("large", size_classes)
        self.assertIn("small", size_classes)
        large = next(profile for profile in profiles if profile["size_class"] == "large")
        small = next(profile for profile in profiles if profile["size_class"] == "small")
        self.assertGreater(large["width_norm"]["median"], small["width_norm"]["median"])
        self.assertGreaterEqual(large["width_pt"]["median"], 400)
        self.assertLess(small["width_pt"]["median"], 250)

    def test_inferred_table_slide_is_not_circular_chart(self):
        for slide in self.report["slides"]["slides"]:
            if slide.get("inferred_table"):
                instances = infer_circular_charts_on_slide(slide, self.slide_width, self.slide_height)
                self.assertEqual(instances, [], f"slide {slide['slide_number']} should not have circular charts")


if __name__ == "__main__":
    unittest.main()
