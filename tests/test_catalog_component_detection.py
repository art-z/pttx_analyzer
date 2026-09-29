import json
import unittest
from pathlib import Path

from app.catalog_component_detection import detect_catalog_components
from app.visual_component_detection import detect_visual_components, merge_component_catalogs


class CatalogComponentDetectionTests(unittest.TestCase):
    def setUp(self):
        report_path = Path("output/f371b6c2a0b0/report.json")
        if not report_path.exists():
            self.skipTest("sample deck report missing")
        self.report = json.loads(report_path.read_text(encoding="utf-8"))
        self.slides = self.report.get("slides")
        self.text_blocks = self.report["typography"]["scale_usage"]["text_blocks"]
        self.assets = self.report.get("assets")

    def test_slide_20_media_cards_are_atomic_not_merged_pairs(self):
        result = detect_catalog_components(self.slides, self.assets, self.text_blocks)
        slide_20_instances = [
            instance
            for component in result["components"]
            for instance in component.get("instances", [])
            if instance.get("slide_number") == 20
        ]
        self.assertGreaterEqual(len(slide_20_instances), 8)

        card_names = {
            component["name"]
            for component in result["components"]
            if any(instance.get("slide_number") == 20 for instance in component.get("instances", []))
        }
        self.assertNotIn("CARD", card_names)
        self.assertIn("MEDIA_CARD", card_names)

        widths = sorted(
            {
                round(instance["container"]["width_pt"])
                for instance in slide_20_instances
            }
        )
        self.assertEqual(widths, [212])
        self.assertFalse(
            any(instance["container"]["width_pt"] > 300 for instance in slide_20_instances),
            "slide 20 should not contain merged double-width card containers",
        )

    def test_slide_20_merged_has_atomic_media_cards_only(self):
        catalog = detect_catalog_components(self.slides, self.assets, self.text_blocks)
        visual = detect_visual_components(self.slides, self.assets)
        merged = merge_component_catalogs(catalog, visual)

        slide_20_names = {
            component["name"]
            for component in merged["components"]
            if any(instance.get("slide_number") == 20 for instance in component.get("instances", []))
        }
        self.assertEqual(slide_20_names, {"MEDIA_CARD"})

        slide_20_instances = [
            instance
            for component in merged["components"]
            for instance in component.get("instances", [])
            if instance.get("slide_number") == 20
        ]
        self.assertEqual(len(slide_20_instances), 8)
        self.assertTrue(
            all(instance["container"]["height_pt"] < 200 for instance in slide_20_instances),
            "lower-row cards must not span into the upper row",
        )

    def test_components_use_catalog_source(self):
        result = detect_catalog_components(self.slides, self.assets, self.text_blocks)
        if not result["components"]:
            self.skipTest("no catalog components in sample report")
        self.assertTrue(all(component.get("source") == "catalog" for component in result["components"]))


if __name__ == "__main__":
    unittest.main()
