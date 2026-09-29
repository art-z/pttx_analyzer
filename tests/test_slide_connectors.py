import json
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from app.pptx import PPTXPackage
from app.shape_stroke import parse_shape_stroke
from app.template_layers import NS, build_slide_content_layers

A = NS["a"]
P = NS["p"]


class SlideConnectorLayersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.package = PPTXPackage(Path("output/cb5ba5e5122e/source.pptx"))
        cls.theme = json.loads(Path("output/cb5ba5e5122e/report.json").read_text())["theme"]

    def test_slide13_exports_connectors_as_line_elements(self):
        elements = build_slide_content_layers(
            self.package,
            "ppt/slides/slide13.xml",
            (960.0, 540.0),
            self.theme,
        )
        lines = [element for element in elements if element.get("kind") == "line"]
        self.assertEqual(len(lines), 15)
        first = lines[0]
        self.assertEqual(first["name"], "Google Shape;354;p45")
        self.assertEqual(first["element_id"], "slide13_slide_line_112")
        self.assertEqual(first["line"]["preset"], "straightConnector1")
        self.assertEqual(first["stroke"]["tail"]["type"], "triangle")
        self.assertEqual(first["stroke"]["width_pt"], 1.0)
        self.assertEqual(first["stroke"]["tail"]["size_pt"], {"length_pt": 5.0, "width_pt": 4.0})
        self.assertGreater(first["geometry_norm"]["width"], 0)
        self.assertGreater(first["geometry_norm"]["height"], 0)

    def test_horizontal_connector_endpoints(self):
        elements = build_slide_content_layers(
            self.package,
            "ppt/slides/slide13.xml",
            (960.0, 540.0),
            self.theme,
        )
        connector = next(
            element for element in elements
            if element.get("name") == "Google Shape;354;p45"
        )
        self.assertEqual(connector["line"]["y1"], connector["line"]["y2"])
        self.assertLess(connector["line"]["x1"], connector["line"]["x2"])

    def test_vertical_connector_endpoints(self):
        elements = build_slide_content_layers(
            self.package,
            "ppt/slides/slide13.xml",
            (960.0, 540.0),
            self.theme,
        )
        connector = next(
            element for element in elements
            if element.get("name") == "Google Shape;361;p45"
        )
        self.assertEqual(connector["line"]["x1"], connector["line"]["x2"])
        self.assertLess(connector["line"]["y1"], connector["line"]["y2"])


class ShapeStrokeArrowTest(unittest.TestCase):
    def test_parse_arrow_heads(self):
        sp_pr = ET.Element(f"{{{P}}}spPr")
        line = ET.SubElement(sp_pr, f"{{{A}}}ln")
        line.set("w", str(int(1.0 * 12700)))
        solid = ET.SubElement(line, f"{{{A}}}solidFill")
        scheme = ET.SubElement(solid, f"{{{A}}}schemeClr")
        scheme.set("val", "accent1")
        ET.SubElement(line, f"{{{A}}}headEnd").attrib.update({"type": "none"})
        ET.SubElement(line, f"{{{A}}}tailEnd").attrib.update({"type": "triangle", "w": "lg", "len": "lg"})

        stroke = parse_shape_stroke(sp_pr, {"accent1": "#0077FF"})
        self.assertIsNotNone(stroke)
        self.assertNotIn("head", stroke)
        self.assertEqual(stroke["tail"]["type"], "triangle")
        self.assertEqual(stroke["tail"]["width"], "lg")
        self.assertEqual(stroke["tail"]["size_pt"], {"length_pt": 5.0, "width_pt": 4.0})


if __name__ == "__main__":
    unittest.main()
