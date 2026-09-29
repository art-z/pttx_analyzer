import unittest
import xml.etree.ElementTree as ET

from app.shape_stroke import arrow_end_size_pt, parse_shape_stroke
from app.template_layers import NS

A = NS["a"]
P = NS["p"]


class ShapeStrokeTest(unittest.TestCase):
    def test_parse_solid_stroke(self):
        sp_pr = ET.Element(f"{{{P}}}spPr")
        line = ET.SubElement(sp_pr, f"{{{A}}}ln")
        line.set("w", str(int(1.5 * 12700)))
        line.set("cap", "flat")
        line.set("cmpd", "sng")
        solid = ET.SubElement(line, f"{{{A}}}solidFill")
        scheme = ET.SubElement(solid, f"{{{A}}}schemeClr")
        scheme.set("val", "accent1")
        ET.SubElement(line, f"{{{A}}}prstDash").set("val", "solid")

        stroke = parse_shape_stroke(sp_pr, {"accent1": "#0077FF"})
        self.assertIsNotNone(stroke)
        self.assertEqual(stroke["width_pt"], 1.5)
        self.assertEqual(stroke["color"]["color"], "#0077FF")
        self.assertEqual(stroke["color"]["kind"], "solid")
        self.assertEqual(stroke["dash"], "solid")

    def test_no_fill_stroke_is_none(self):
        sp_pr = ET.Element(f"{{{P}}}spPr")
        line = ET.SubElement(sp_pr, f"{{{A}}}ln")
        ET.SubElement(line, f"{{{A}}}noFill")
        self.assertIsNone(parse_shape_stroke(sp_pr, {}))

    def test_missing_ln_is_none(self):
        sp_pr = ET.Element(f"{{{P}}}spPr")
        self.assertIsNone(parse_shape_stroke(sp_pr, {}))

    def test_triangle_tail_exports_size_pt_from_line_width(self):
        end = {"type": "triangle", "width": "lg", "length": "lg"}
        size = arrow_end_size_pt(1.0, end)
        self.assertEqual(size, {"length_pt": 5.0, "width_pt": 4.0})

    def test_stealth_tail_exports_size_pt_from_line_width(self):
        end = {"type": "stealth", "width": "med", "length": "med"}
        size = arrow_end_size_pt(2.25, end)
        self.assertEqual(size, {"length_pt": 7.88, "width_pt": 6.75})


if __name__ == "__main__":
    unittest.main()
