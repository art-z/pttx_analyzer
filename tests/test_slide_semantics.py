import json
import unittest
from pathlib import Path

from app.analyzer import analyze
from app.catalog_component_detection import detect_catalog_components
from app.slide_semantics import build_slide_semantics
from app.visual_component_detection import detect_visual_components, merge_component_catalogs


class SlideSemanticsTests(unittest.TestCase):
    def setUp(self):
        report_path = Path("output/f371b6c2a0b0/report.json")
        if not report_path.exists():
            self.skipTest("sample deck report missing")
        self.report = json.loads(report_path.read_text(encoding="utf-8"))

    def _semantics(self):
        catalog = detect_catalog_components(
            self.report["slides"],
            self.report["assets"],
            self.report["typography"]["scale_usage"]["text_blocks"],
        )
        visual = detect_visual_components(self.report["slides"], self.report["assets"])
        merged = merge_component_catalogs(catalog, visual)
        return build_slide_semantics(
            self.report["slides"],
            self.report["slide_templates"],
            merged,
        )

    def test_catalog_elements_receive_component_ref(self):
        semantics = self._semantics()
        slide8 = next(
            slide for slide in semantics["slides"]["slides"] if slide["slide_number"] == 8
        )
        refs = [element.get("component_ref") for element in slide8["content_elements"] if element.get("component_ref")]
        self.assertGreaterEqual(len(refs), 6)
        self.assertTrue(all(ref.get("name") == "MEDIA_CARD" for ref in refs))

    def test_shell_template_lists_media_card_capacity(self):
        semantics = self._semantics()
        shell = next(
            item
            for item in semantics["shell_templates"]
            if 8 in item["slide_numbers"]
        )
        media = next(
            (entry for entry in shell["allowed_components"] if entry["name"] == "MEDIA_CARD"),
            None,
        )
        self.assertIsNotNone(media, "expected MEDIA_CARD on Заголовок shell")
        self.assertGreaterEqual(media["max_count"], 6)
        self.assertIn(8, media["source_slides"])

    def test_registry_unifies_duplicate_media_cards(self):
        semantics = self._semantics()
        media_components = [
            component
            for component in semantics["component_registry"]["components"]
            if component["name"] == "MEDIA_CARD"
        ]
        self.assertEqual(len(media_components), 1)


if __name__ == "__main__":
    unittest.main()
