import unittest

from app.chart_palette import (
    collect_series_fill_variants_from_elements,
    extract_design_system_chart_colors,
    extract_design_system_text_colors,
    merge_chart_palette,
    normalize_chart_fill,
    resolve_chart_palette_for_baselines,
)


class ChartPaletteTests(unittest.TestCase):
    def test_merge_supplements_single_chart_color_from_design_system(self):
        merged = merge_chart_palette(
            ["#0077FF"],
            ["#00A86B", "#FF6B35", "#7B61FF"],
            min_colors=2,
        )
        self.assertGreaterEqual(len(merged), 2)
        self.assertEqual(merged[0], "#0077FF")
        self.assertIn("#00A86B", merged)

    def test_resolve_baseline_palette_never_single_color(self):
        palette = resolve_chart_palette_for_baselines(
            {"colors": ["#FF3885"]},
            ["#0077FF", "#00A86B"],
            ["#FFB020", "#7B61FF"],
        )
        self.assertGreaterEqual(len(palette), 2)
        self.assertIn("#FF3885", palette)

    def test_merge_keeps_chart_colors_first(self):
        merged = merge_chart_palette(
            ["#0077FF", "#FF3885"],
            ["#0077FF", "#00A86B"],
            min_colors=2,
        )
        self.assertEqual(merged[:2], ["#0077FF", "#FF3885"])

    def test_collects_gradient_fill_variants_from_bar_elements(self):
        elements = [
            {
                "element_id": "bar_1",
                "fill": {
                    "kind": "linear_gradient",
                    "angle_deg": 90.0,
                    "stops": [
                        {"position": 0.0, "color": "#65CCFF"},
                        {"position": 1.0, "color": "#0077FF"},
                    ],
                },
            },
            {
                "element_id": "bar_2",
                "fill": {"kind": "solid", "color": "#0077FF"},
            },
        ]
        variants = collect_series_fill_variants_from_elements(elements)
        self.assertEqual(len(variants), 2)
        self.assertEqual(variants[0]["kind"], "linear_gradient")
        self.assertEqual(normalize_chart_fill(variants[0])["stops"][0]["color"], "#65CCFF")

    def test_extract_design_system_chart_colors_skips_text_bucket(self):
        colors = {
            "context_palettes": {
                "text": [{"color": "#17212D"}],
                "fill": [{"color": "#0077FF"}],
            },
        }
        result = extract_design_system_chart_colors(colors)
        self.assertIn("#0077FF", result)
        self.assertNotIn("#17212D", result)

    def test_merge_chart_palette_skips_reserved_text_colors(self):
        merged = merge_chart_palette(
            ["#17212D"],
            ["#0077FF", "#00A86B"],
            reserved_colors=["#17212D"],
        )
        self.assertNotIn("#17212D", merged)
        self.assertIn("#0077FF", merged)


if __name__ == "__main__":
    unittest.main()
