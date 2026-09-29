import unittest

from app.content_margins import analyze_content_margins, apply_content_margins_to_slides


class ContentMarginsTests(unittest.TestCase):
    def test_analyze_content_margins_uses_top_left_for_bottom_safe_zone(self):
        slides = [
            {
                "content_elements": [
                    {"kind": "text", "geometry_norm": {"x": 0.08, "y": 0.12, "width": 0.4, "height": 0.08}},
                    {"kind": "table", "geometry_norm": {"x": 0.08, "y": 0.24, "width": 0.84, "height": 0.5}},
                ],
            },
            {
                "content_elements": [
                    {"kind": "text", "geometry_norm": {"x": 0.07, "y": 0.11, "width": 0.35, "height": 0.07}},
                    {"kind": "text", "geometry_norm": {"x": 0.08, "y": 0.82, "width": 0.2, "height": 0.04}},
                ],
            },
        ]
        margins = analyze_content_margins(slides, {"width": 960, "height": 540})
        self.assertEqual(margins["slide_count_analyzed"], 2)
        self.assertAlmostEqual(margins["left_norm"], 0.075, places=3)
        self.assertAlmostEqual(margins["top_norm"], 0.115, places=3)
        self.assertGreaterEqual(margins["bottom_norm"], margins["top_norm"])
        self.assertAlmostEqual(margins["bottom_pt"], margins["bottom_norm"] * 540, places=1)

    def test_title_gap_uses_median_distance_to_content_below(self):
        slides = [
            {
                "content_elements": [
                    {"kind": "text", "placeholder_type": "title", "geometry_norm": {"x": 0.05, "y": 0.06, "width": 0.9, "height": 0.1}},
                    {"kind": "chart", "geometry_norm": {"x": 0.05, "y": 0.22, "width": 0.9, "height": 0.6}},
                ],
            },
            {
                "content_elements": [
                    {"kind": "text", "placeholder_type": "title", "geometry_norm": {"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.1}},
                    {"kind": "table", "geometry_norm": {"x": 0.05, "y": 0.23, "width": 0.9, "height": 0.6}},
                ],
            },
        ]
        margins = analyze_content_margins(slides, {"width": 960, "height": 540})
        self.assertAlmostEqual(margins["title_content_gap_norm"], 0.07, places=3)
        self.assertAlmostEqual(margins["title_content_gap_pt"], 37.8, places=1)

    def test_apply_content_margins_to_slides_limits_table_height(self):
        slide_catalog = {
            "slides": [{
                "render": {"slide_size_pt": {"width": 960, "height": 540}},
                "content_elements": [{
                    "kind": "table",
                    "geometry_pt": {"y_pt": 100.0},
                    "table": {"available_height_pt": 440.0},
                }],
            }],
        }
        margins = {"bottom_norm": 0.08, "bottom_pt": 43.2}
        apply_content_margins_to_slides(slide_catalog, margins)
        table = slide_catalog["slides"][0]["content_elements"][0]["table"]
        self.assertEqual(table["content_bottom_margin_pt"], 43.2)
        self.assertEqual(table["available_height_pt"], 396.8)


if __name__ == "__main__":
    unittest.main()
