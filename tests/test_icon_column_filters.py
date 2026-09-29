import json
import unittest
from pathlib import Path

from app.catalog_component_detection import detect_catalog_components
from app.visual_component_detection import detect_visual_components, _extract_icon_column_atoms
from app.slide_patterns import _content_elements_for_clustering, _icon_files, _slide_size_pt, is_icon_asset_sheet


class IconColumnFilterTests(unittest.TestCase):
    def setUp(self):
        report_path = Path("output/9462c7a015b1/report.json")
        if not report_path.exists():
            self.skipTest("9462c7a015b1 sample report missing")
        self.report = json.loads(report_path.read_text(encoding="utf-8"))
        self.slides = self.report["slides"]
        self.assets = self.report.get("assets")
        self.text_blocks = self.report["typography"]["scale_usage"]["text_blocks"]

    def test_slide_25_is_icon_asset_sheet(self):
        slide25 = next(slide for slide in self.slides["slides"] if slide["slide_number"] == 25)
        elements = _content_elements_for_clustering(slide25["content_elements"], _icon_files(self.assets))
        self.assertTrue(is_icon_asset_sheet(elements))

    def test_slide_25_has_no_footer_icon_column_component(self):
        visual = detect_visual_components(self.slides, self.assets)
        icon_columns = [
            component
            for component in visual["components"]
            if component.get("name") == "ICON_COLUMN"
            and 25 in (component.get("frequency") or {}).get("slide_numbers", [])
        ]
        self.assertEqual(icon_columns, [])

        catalog = detect_catalog_components(self.slides, self.assets, self.text_blocks)
        slide_25_instances = [
            instance
            for component in catalog["components"]
            for instance in component.get("instances", [])
            if instance.get("slide_number") == 25
        ]
        self.assertEqual(slide_25_instances, [])

    def test_icon_does_not_pair_with_wide_footer_caption(self):
        slide25 = next(slide for slide in self.slides["slides"] if slide["slide_number"] == 25)
        elements = _content_elements_for_clustering(slide25["content_elements"], _icon_files(self.assets))
        bottom_icons = [
            element
            for element in elements
            if element.get("kind") in {"icon", "image"} and element["geometry_norm"]["y"] > 0.65
        ]
        atoms = _extract_icon_column_atoms(bottom_icons + [
            element for element in elements if element.get("kind") == "text"
        ], *_slide_size_pt(slide25))
        self.assertEqual(atoms, [])


if __name__ == "__main__":
    unittest.main()
