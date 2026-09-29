import unittest
import xml.etree.ElementTree as ET

from app.fill_styles import (
    parse_gradient_fill,
    parse_solid_fill,
    resolve_color_node,
    solid_css_color,
)
from app.template_layers import NS

A = NS["a"]


class FillStylesTest(unittest.TestCase):
    def test_alpha_on_scheme_color(self):
        node = ET.Element(f"{{{A}}}schemeClr")
        node.set("val", "accent1")
        alpha = ET.SubElement(node, f"{{{A}}}alpha")
        alpha.set("val", "60000")

        parsed = resolve_color_node(node, {"accent1": "#0077FF"})
        self.assertEqual(parsed["color"], "#0077FF")
        self.assertEqual(parsed["alpha"], 0.6)
        self.assertEqual(solid_css_color(parsed), "rgba(0, 119, 255, 0.6)")

    def test_tint_modifier(self):
        node = ET.Element(f"{{{A}}}srgbClr")
        node.set("val", "0077FF")
        tint = ET.SubElement(node, f"{{{A}}}tint")
        tint.set("val", "50000")

        parsed = resolve_color_node(node, {})
        self.assertEqual(parsed["color"], "#80BBFF")

    def test_linear_gradient_fill(self):
        grad = ET.Element(f"{{{A}}}gradFill")
        stops = ET.SubElement(grad, f"{{{A}}}gsLst")
        stop_a = ET.SubElement(stops, f"{{{A}}}gs")
        stop_a.set("pos", "0")
        color_a = ET.SubElement(stop_a, f"{{{A}}}schemeClr")
        color_a.set("val", "accent1")
        stop_b = ET.SubElement(stops, f"{{{A}}}gs")
        stop_b.set("pos", "100000")
        color_b = ET.SubElement(stop_b, f"{{{A}}}srgbClr")
        color_b.set("val", "FFFFFF")
        alpha = ET.SubElement(color_b, f"{{{A}}}alpha")
        alpha.set("val", "0")
        lin = ET.SubElement(grad, f"{{{A}}}lin")
        lin.set("ang", "5400000")

        parsed = parse_gradient_fill(grad, {"accent1": "#0077FF"})
        self.assertEqual(parsed["kind"], "linear_gradient")
        self.assertEqual(len(parsed["stops"]), 2)
        self.assertEqual(parsed["stops"][0]["color"], "#0077FF")
        self.assertEqual(parsed["stops"][1]["alpha"], 0.0)

    def test_solid_fill_wrapper(self):
        solid = ET.Element(f"{{{A}}}solidFill")
        scheme = ET.SubElement(solid, f"{{{A}}}schemeClr")
        scheme.set("val", "dk1")
        parsed = parse_solid_fill(solid, {"dk1": "#000000"})
        self.assertEqual(parsed["kind"], "solid")
        self.assertEqual(parsed["color"], "#000000")


if __name__ == "__main__":
    unittest.main()
