import json
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from app.colors import _build_theme_map
from app.pptx import PPTXPackage
from app.slide_catalog import extract_slide_catalog
from app.text_slots import NS, effective_run_typography

A = NS["a"]
P = NS["p"]


class ThemeColorAliasesTest(unittest.TestCase):
    def test_scheme_aliases_are_resolved(self):
        theme_map = _build_theme_map({
            "themes": [{
                "colors": {
                    "dk1": {"type": "srgbClr", "value": "000000"},
                    "lt1": {"type": "srgbClr", "value": "FFFFFF"},
                },
            }],
        })
        self.assertEqual(theme_map["tx1"], "#000000")
        self.assertEqual(theme_map["bg1"], "#FFFFFF")


class EffectiveRunTypographyColorTest(unittest.TestCase):
    def test_title_style_bg1_resolves_to_lt1(self):
        theme_map = _build_theme_map({
            "themes": [{
                "colors": {
                    "lt1": {"type": "srgbClr", "value": "FFFFFF"},
                },
            }],
        })
        paragraph = ET.Element(f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr = ET.SubElement(run, f"{{{A}}}rPr")
        rpr.set("b", "1")
        ET.SubElement(run, f"{{{A}}}t").text = "Title"

        typography = effective_run_typography(
            {1: {"color_scheme": "bg1", "size_pt": 20, "bold": True}},
            paragraph,
            rpr,
            theme_map,
            {},
        )
        self.assertEqual(typography["color"], "#FFFFFF")

    def test_missing_color_falls_back_to_tx1(self):
        theme_map = _build_theme_map({
            "themes": [{
                "colors": {
                    "dk1": {"type": "srgbClr", "value": "112233"},
                },
            }],
        })
        paragraph = ET.Element(f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr = ET.SubElement(run, f"{{{A}}}rPr")
        ET.SubElement(run, f"{{{A}}}t").text = "Body"

        typography = effective_run_typography({}, paragraph, rpr, theme_map, {})
        self.assertEqual(typography["color"], "#112233")


class SlideBackgroundOverrideTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path("output/9deb32f8cd1a")
        cls.package = PPTXPackage(cls.root / "source.pptx")
        cls.theme = json.loads((cls.root / "report.json").read_text())["theme"]
        cls.slide_templates = json.loads((cls.root / "report.json").read_text())["slide_templates"]

    def test_slide_background_replaces_master_image(self):
        catalog = extract_slide_catalog(
            self.package,
            self.theme,
            self.slide_templates,
        )
        for slide_number, expected_asset in ((10, "image30.png"), (15, "image4.png")):
            slide = next(item for item in catalog["slides"] if item["slide_number"] == slide_number)
            bg_layers = [
                layer for layer in slide["render"]["layers"]
                if (layer.get("source_scope") or "").endswith("_bg")
            ]
            self.assertEqual(len(bg_layers), 1, slide_number)
            self.assertEqual(bg_layers[0]["source_scope"], "slide_bg")
            self.assertEqual(bg_layers[0]["asset"], expected_asset)

    def test_slide_30_title_color_is_resolved(self):
        catalog = extract_slide_catalog(
            self.package,
            self.theme,
            self.slide_templates,
        )
        slide = next(item for item in catalog["slides"] if item["slide_number"] == 30)
        title = next(
            element for element in slide["content_elements"]
            if "Полезные материалы" in (element.get("text") or "")
        )
        self.assertEqual(title["typography"]["color"], "#FFFFFF")

    def test_slide_30_stroke_boxes_use_outline_not_diagonal(self):
        from app.template_layers import build_slide_content_layers

        elements = build_slide_content_layers(
            self.package,
            "ppt/slides/slide30.xml",
            (960.0, 540.0),
            self.theme,
        )
        rect_outline = next(
            element for element in elements
            if element.get("kind") == "line" and element.get("name") == "Прямоугольник 11"
        )
        self.assertEqual(rect_outline["line"]["outline"], "rect")
        self.assertNotIn("x1", rect_outline["line"])

        tab_outline = next(
            element for element in elements
            if element.get("kind") == "line" and element.get("name") == "ïśḷîďè"
        )
        self.assertTrue(tab_outline.get("outline_path", "").startswith("M "))
        self.assertIn(" C ", tab_outline["outline_path"])
        self.assertIn("1.0 0.5", tab_outline["outline_path"])


if __name__ == "__main__":
    unittest.main()
