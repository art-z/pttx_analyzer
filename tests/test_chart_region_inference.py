import json
import unittest
from pathlib import Path

from app.chart_region_inference import apply_chart_region_inference, infer_chart_region_on_slide
from app.chart_palette import build_chart_series_palette
from app.layout_table_inference import infer_layout_table_on_slide


class ChartRegionInferenceTests(unittest.TestCase):
    def setUp(self):
        self.report_path = Path("output/0159f80bf829/report.json")
        if not self.report_path.exists():
            self.skipTest("sample deck report missing")
        self.report = json.loads(self.report_path.read_text(encoding="utf-8"))
        size = self.report["typography"]["visibility"]["slide_size_pt"]
        self.slide_width = float(size["width"])
        self.slide_height = float(size["height"])

    def _slide(self, number: int):
        return next(slide for slide in self.report["slides"]["slides"] if slide["slide_number"] == number)

    def test_slide_43_detects_gantt_like_chart(self):
        result = infer_chart_region_on_slide(self._slide(43), self.slide_width, self.slide_height)
        self.assertIsNotNone(result, "expected pseudo-chart on slide 43")
        self.assertGreaterEqual(result["confidence"], 0.62)
        self.assertEqual(result["chart_type_guess"], "gantt")
        self.assertGreaterEqual(result["signals"]["x_axis_label_count"], 6)
        self.assertGreaterEqual(result["signals"]["y_axis_label_count"], 4)
        self.assertGreaterEqual(result["signals"]["plot_mark_count"], 5)

    def test_slide_43_is_not_table(self):
        slide = self._slide(43)
        self.assertFalse(infer_layout_table_on_slide(slide, self.slide_width, self.slide_height))

    def test_inferred_table_slide_is_not_chart(self):
        for slide in self.report["slides"]["slides"]:
            if slide.get("inferred_table"):
                result = infer_chart_region_on_slide(slide, self.slide_width, self.slide_height)
                self.assertIsNone(result, f"slide {slide['slide_number']} should not look like chart")

    def test_slide_51_detects_chart_from_labeled_legend(self):
        result = infer_chart_region_on_slide(self._slide(51), self.slide_width, self.slide_height)
        self.assertIsNotNone(result, "expected chart region from labeled legend on slide 51")
        self.assertIn(result["source"], {"labeled_legend_image", "labeled_legend"})
        self.assertGreaterEqual(result["confidence"], 0.68)
        self.assertEqual(result["signals"]["legend_pair_count"], 2)
        self.assertEqual(result["signals"]["plot_image_count"], 1)
        self.assertEqual(result["series_palette"], ["#0077FF", "#FF3885"])
        self.assertEqual(
            [item["name"] for item in result["series_preview"]],
            ["DAU", "MAU"],
        )

    def test_slide_51_is_not_table(self):
        slide = self._slide(51)
        self.assertFalse(infer_layout_table_on_slide(slide, self.slide_width, self.slide_height))

    def test_deck_chart_series_palette_aggregates_colors(self):
        slides = self.report["slides"]
        apply_chart_region_inference(slides, (self.slide_width, self.slide_height))
        palette = build_chart_series_palette(slides, self.report.get("graphic_components") or {})
        colors = palette.get("colors") or []
        self.assertIn("#0077FF", colors)
        self.assertIn("#FF3885", colors)

    def test_slide_52_extracts_axis_typography_and_horizontal_grid_style(self):
        report_path = Path("output/11a5ff043ce0/report.json")
        if not report_path.exists():
            self.skipTest("slide 52 sample report missing")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        slide = next(slide for slide in report["slides"]["slides"] if slide["slide_number"] == 52)
        size = report["typography"]["visibility"]["slide_size_pt"]
        result = infer_chart_region_on_slide(slide, float(size["width"]), float(size["height"]))

        self.assertIsNotNone(result)
        self.assertGreaterEqual(result["signals"]["y_axis_label_count"], 5)
        self.assertEqual(result["x_axis"]["typography"]["family"], "Play")
        self.assertEqual(result["x_axis"]["typography"]["size_pt"], 12.0)
        grid = result["style_tokens"]["grid_line"]
        self.assertTrue(grid["visible"])
        self.assertTrue(grid["horizontal_visible"])
        self.assertFalse(grid["vertical_visible"])
        self.assertEqual(grid["horizontal_count"], 5)
        self.assertEqual(grid["color"], "#FFFFFF")
        self.assertEqual(grid["width_pt"], 0.37)
        self.assertFalse(result["style_tokens"]["axis_line"]["visible"])


class SpatialChartRegionInferenceTests(unittest.TestCase):
    def setUp(self):
        self.report_path = Path("output/b13e9370de41/report.json")
        if not self.report_path.exists():
            self.skipTest("spatial deck report missing")
        self.report = json.loads(self.report_path.read_text(encoding="utf-8"))
        size = self.report["typography"]["visibility"]["slide_size_pt"]
        self.slide_width = float(size["width"])
        self.slide_height = float(size["height"])

    def _slide(self, number: int):
        return next(slide for slide in self.report["slides"]["slides"] if slide["slide_number"] == number)

    def test_slide_48_detects_chart_from_legend_above_image(self):
        result = infer_chart_region_on_slide(self._slide(48), self.slide_width, self.slide_height)
        self.assertIsNotNone(result, "expected legend+image chart on slide 48")
        self.assertEqual(result["source"], "labeled_legend_image")
        self.assertGreaterEqual(result["confidence"], 0.75)
        self.assertEqual(result["signals"]["legend_pair_count"], 2)
        self.assertEqual(result["signals"]["plot_image_count"], 1)
        self.assertEqual(len(result["consumed_element_ids"]), 5)
        self.assertEqual(
            [item["name"] for item in result["series_preview"]],
            ["DAU", "MAU"],
        )


class ChartLegendDistinctColorsTests(unittest.TestCase):
    def setUp(self):
        self.report_path = Path("output/c5479626ebed/report.json")
        if not self.report_path.exists():
            self.skipTest("slide 44 deck report missing")
        self.report = json.loads(self.report_path.read_text(encoding="utf-8"))
        size = self.report["typography"]["visibility"]["slide_size_pt"]
        self.slide_width = float(size["width"])
        self.slide_height = float(size["height"])

    def _slide(self, number: int):
        return next(slide for slide in self.report["slides"]["slides"] if slide["slide_number"] == number)

    def test_slide_44_legend_pairs_allow_duplicate_labels_with_distinct_swatch_colors(self):
        from app.chart_region_inference import _labeled_legend_pairs

        slide = self._slide(44)
        elements = slide["content_elements"]
        texts = [element for element in elements if element.get("kind") == "text"]
        marks = [element for element in elements if element.get("kind") in {"fill", "shape"}]
        pairs = _labeled_legend_pairs(texts, marks, self.slide_width, self.slide_height)
        self.assertEqual(len(pairs), 2)
        self.assertEqual({pair["color"] for pair in pairs}, {"#65CCFF", "#0077FF"})
        self.assertEqual({pair["text"] for pair in pairs}, {"Текст"})

    def test_legend_pairs_reject_duplicate_swatch_colors(self):
        from app.chart_region_inference import _labeled_legend_pairs

        texts = [
            {
                "element_id": "t1",
                "kind": "text",
                "text": "A",
                "geometry_norm": {"x": 0.80, "y": 0.30, "width": 0.08, "height": 0.04},
            },
            {
                "element_id": "t2",
                "kind": "text",
                "text": "B",
                "geometry_norm": {"x": 0.80, "y": 0.36, "width": 0.08, "height": 0.04},
            },
        ]
        marks = [
            {
                "element_id": "s1",
                "kind": "fill",
                "fill": {"color": "#0077FF"},
                "geometry_pt": {"width_pt": 12, "height_pt": 12},
                "geometry_norm": {"x": 0.76, "y": 0.30, "width": 0.015, "height": 0.022},
            },
            {
                "element_id": "s2",
                "kind": "fill",
                "fill": {"color": "#0077FF"},
                "geometry_pt": {"width_pt": 12, "height_pt": 12},
                "geometry_norm": {"x": 0.76, "y": 0.36, "width": 0.015, "height": 0.022},
            },
        ]
        pairs = _labeled_legend_pairs(texts, marks, 960.0, 540.0)
        self.assertEqual(pairs, [])

    def test_slide_44_detects_vertical_bar_chart(self):
        result = infer_chart_region_on_slide(self._slide(44), self.slide_width, self.slide_height)
        self.assertIsNotNone(result, "expected vertical bar chart on slide 44")
        self.assertEqual(result["source"], "vertical_bar_cluster")
        self.assertEqual(result["chart_type_guess"], "bar")
        self.assertGreaterEqual(result["signals"]["vertical_bar_count"], 5)
        self.assertGreaterEqual(result["signals"]["x_axis_label_count"], 3)
        self.assertEqual(result["series_palette"], ["#65CCFF", "#0077FF"])
        self.assertEqual(len(result["series_fill_variants"]), 2)
        self.assertEqual(result["legend"]["layout"], "column")

    def test_slide_13_is_not_vertical_bar_chart(self):
        result = infer_chart_region_on_slide(self._slide(13), self.slide_width, self.slide_height)
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
