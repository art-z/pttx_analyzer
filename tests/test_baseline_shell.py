import json
import unittest
from pathlib import Path

from app.baseline_shell import BaselineShellResolver, attach_baseline_previews, infer_spatial_content_bbox
from app.graphic_baselines import enrich_graphic_components_with_baselines


class BaselineShellTests(unittest.TestCase):
    @staticmethod
    def _spatial_fixture():
        counts = [
            [10 if 1 <= row <= 2 and 1 <= col <= 6 else 0 for col in range(8)]
            for row in range(4)
        ]
        free_ratios = [[0.1 if value else 1.0 for value in row] for row in counts]
        return {
            "components": [
                {"id": "text_regions", "heatmap": {"cols": 8, "rows": 4, "counts": counts, "max_count": 10}},
                {"id": "image_regions", "heatmap": {"cols": 8, "rows": 4, "counts": counts, "max_count": 10}},
                {"id": "repeated_groups", "heatmap": {"cols": 8, "rows": 4, "counts": counts, "max_count": 10}},
                {"id": "safe_space", "heatmap": {"cols": 8, "rows": 4, "free_ratios": free_ratios}},
            ]
        }

    def _load_report(self):
        for report_id in ("dc7dc3380500", "d44226b714c3", "fa721249ff0b"):
            path = Path(f"output/{report_id}/report.json")
            if path.exists():
                return json.loads(path.read_text(encoding="utf-8"))
        self.skipTest("sample deck report missing")

    def test_attach_baseline_previews_for_all_baselines(self):
        report = self._load_report()
        catalog = enrich_graphic_components_with_baselines(
            {"tables": [], "charts": [], "diagrams": [], "summary": {}},
            report.get("slides"),
            report.get("slide_semantics", {}).get("shell_templates"),
        )
        baselines = [
            *(catalog.get("tables") or []),
            *(catalog.get("charts") or []),
            *(catalog.get("diagrams") or []),
        ]
        self.assertGreater(len(baselines), 0)
        for item in baselines:
            preview = item.get("baseline_preview")
            self.assertIsNotNone(preview, item["component_id"])
            self.assertIn(
                preview["match_strategy"],
                {
                    "replace_graphic",
                    "replace_fullwidth_content",
                    "replace_split_graphic",
                    "title_top_canvas",
                    "title_only_shell",
                    "synthetic",
                    "circular_chart_example",
                },
            )
            self.assertIn("geometry_norm", preview)
            self.assertIn("geometry_pt", preview)

    def test_prefers_replace_graphic_when_slide_has_single_chart(self):
        report = self._load_report()
        resolver = BaselineShellResolver(
            report.get("slides"),
            report.get("slide_semantics", {}).get("shell_templates"),
        )
        has_chart_slide = False
        for slide in report["slides"]["slides"]:
            charts = [element for element in slide.get("content_elements") or [] if element.get("kind") == "chart"]
            if len(charts) == 1:
                has_chart_slide = True
                preview = resolver.resolve({
                    "component_id": "cht_baseline_bar",
                    "kind": "chart",
                    "is_baseline": True,
                    "chart_type": "bar",
                })
                if preview["match_strategy"] == "replace_graphic":
                    self.assertEqual(preview["slide_number"], slide["slide_number"])
                    self.assertEqual(preview["replaced_element_id"], charts[0]["element_id"])
                break
        if not has_chart_slide:
            self.skipTest("deck has no single-chart slides")

    def test_area_baseline_prefers_fullwidth_canvas_over_title_shell(self):
        report_path = Path("output/ec18f26be3d1/report.json")
        if not report_path.exists():
            self.skipTest("sample deck report missing")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        resolver = BaselineShellResolver(
            report.get("slides"),
            report.get("slide_semantics", {}).get("shell_templates"),
        )
        preview = resolver.resolve({
            "component_id": "cht_baseline_area",
            "kind": "chart",
            "is_baseline": True,
            "chart_type": "area",
        })
        self.assertIn(
            preview["match_strategy"],
            {"replace_fullwidth_content", "replace_graphic", "title_top_canvas"},
        )
        self.assertNotEqual(preview["match_strategy"], "title_only_shell")
        self.assertGreater(preview["geometry_norm"]["height"], 0.45)
        self.assertEqual(preview["slide_number"], 14)

    def test_cartesian_chart_uses_full_available_content_height(self):
        resolver = BaselineShellResolver({"slides": []}, [])
        region = {"x": 0.04, "y": 0.2, "width": 0.92, "height": 0.72}
        slide = {"render": {"slide_size_pt": {"width": 960, "height": 540}}}

        geometry = resolver._fit_geometry_in_region(
            region,
            "chart",
            slide,
            {"chart_type": "area"},
        )

        self.assertEqual(geometry["norm"]["height"], region["height"])

    def test_spatial_heatmap_bbox_overrides_cartesian_baseline_geometry(self):
        spatial = self._spatial_fixture()
        bbox = infer_spatial_content_bbox(
            spatial,
            {"left_norm": 0.04, "right_norm": 0.04, "top_norm": 0.05, "bottom_norm": 0.08},
        )
        self.assertIsNotNone(bbox)
        self.assertGreater(bbox["width"], 0.8)

        resolver = BaselineShellResolver({"slides": []}, [], spatial)
        preview = resolver.resolve({
            "component_id": "cht_baseline_area",
            "kind": "chart",
            "is_baseline": True,
            "chart_type": "area",
        })
        self.assertEqual(preview["geometry_source"], "spatial_heatmap")
        self.assertEqual(preview["geometry_norm"]["width"], bbox["width"])

    def test_spatial_chart_starts_after_title_plus_deck_gap(self):
        spatial = self._spatial_fixture()
        slides = {"slides": [{
            "slide_number": 1,
            "render": {"slide_size_pt": {"width": 960, "height": 540}},
            "content_elements": [{
                "element_id": "title",
                "kind": "text",
                "placeholder_type": "title",
                "geometry_norm": {"x": 0.05, "y": 0.06, "width": 0.9, "height": 0.1},
            }],
        }]}
        resolver = BaselineShellResolver(
            slides,
            [],
            spatial,
            {"title_content_gap_norm": 0.06},
        )
        preview = resolver.resolve({
            "component_id": "cht_baseline_area",
            "kind": "chart",
            "is_baseline": True,
            "chart_type": "area",
        })
        self.assertEqual(preview["geometry_source"], "spatial_heatmap")
        self.assertAlmostEqual(preview["geometry_norm"]["y"], 0.22, places=3)
        self.assertAlmostEqual(
            preview["geometry_norm"]["y"] + preview["geometry_norm"]["height"],
            0.875,
            places=3,
        )

    def test_doughnut_baseline_uses_circular_chart_example(self):
        report_path = Path("output/0159f80bf829/report.json")
        if not report_path.exists():
            self.skipTest("sample deck report missing")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        from app.circular_chart_inference import apply_circular_chart_inference
        from app.graphic_baselines import enrich_graphic_components_with_baselines

        slides = report["slides"]
        size = report["typography"]["visibility"]["slide_size_pt"]
        apply_circular_chart_inference(slides, (float(size["width"]), float(size["height"])))
        catalog = enrich_graphic_components_with_baselines(
            {"tables": [], "charts": [], "diagrams": [], "summary": {}},
            slides,
            report.get("slide_semantics", {}).get("shell_templates"),
        )
        doughnut = next(item for item in catalog["charts"] if item.get("component_id") == "cht_baseline_doughnut")
        preview = doughnut["baseline_preview"]
        self.assertEqual(preview["match_strategy"], "circular_chart_example")
        self.assertIn(preview["slide_number"], {45, 46})
        self.assertIn("plot_region_norm", preview)
        self.assertTrue(doughnut.get("center_metric_preview"))
        self.assertTrue(doughnut["style_tokens"]["circular_layout"]["center_metric"]["enabled"])

    def test_native_circular_chart_beats_inferred_image_and_stays_physically_square(self):
        slides = {"slides": [{
            "slide_number": 1,
            "render": {"slide_size_pt": {"width": 960, "height": 540}},
            "content_elements": [{
                "element_id": "native",
                "kind": "chart",
                "chart_type": "doughnut",
                "geometry_norm": {"x": 0.2, "y": 0.22, "width": 0.4, "height": 0.5},
            }],
            "inferred_circular_charts": [{
                "source": "image_center_label",
                "confidence": 0.95,
                "chart_type_guess": "doughnut",
                "plot_region_norm": {"x": 0.1, "y": 0.2, "width": 0.2, "height": 0.3},
            }],
        }]}
        preview = BaselineShellResolver(slides, []).resolve({
            "kind": "chart",
            "chart_type": "doughnut",
            "style_tokens": {"circular_layout": {"legend_band_ratio": 0.16}},
        })
        self.assertEqual(preview["match_strategy"], "native_circular_chart")
        plot_height_pt = preview["geometry_pt"]["height_pt"] * preview["plot_region_norm"]["height"]
        self.assertAlmostEqual(preview["geometry_pt"]["width_pt"], plot_height_pt, delta=0.2)


if __name__ == "__main__":
    unittest.main()
