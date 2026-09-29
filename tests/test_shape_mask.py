import unittest
from xml.etree import ElementTree as ET

from app.shape_mask import apply_mask_geometry, corner_radius_pt, corner_radii_pt, parse_shape_mask

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


class ShapeMaskTests(unittest.TestCase):
    def test_corner_radius_pt_uses_min_dimension(self):
        self.assertEqual(corner_radius_pt(0.07, 164.13, 357.86), 11.49)
        self.assertEqual(corner_radius_pt(0.16667, 100, 50), 8.33)

    def test_apply_mask_geometry_round_rect(self):
        mask = {"kind": "roundRect", "adj": 0.07, "radius_pct": 7.0}
        enriched = apply_mask_geometry(mask, {"width_pt": 164.13, "height_pt": 357.86})
        self.assertEqual(enriched["corner_radius_pt"], 11.49)
        self.assertEqual(enriched["corner_radii_pt"], [11.49, 11.49, 11.49, 11.49])

    def test_parse_shape_mask_round_rect_adj(self):
        sp_pr = ET.fromstring(
            """
            <spPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:prstGeom prst="roundRect">
                <a:avLst>
                  <a:gd fmla="val 7000" name="adj"/>
                </a:avLst>
              </a:prstGeom>
            </spPr>
            """
        )
        mask = parse_shape_mask(sp_pr)
        self.assertEqual(mask["kind"], "roundRect")
        self.assertEqual(mask["adj"], 0.07)
        self.assertEqual(mask["radius_pct"], 7.0)

    def test_parse_shape_mask_round2_same_rect_reads_adj_values_as_is(self):
        sp_pr = ET.fromstring(
            """
            <spPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:prstGeom prst="round2SameRect">
                <a:avLst>
                  <a:gd fmla="val 17490" name="adj1"/>
                  <a:gd fmla="val 0" name="adj2"/>
                </a:avLst>
              </a:prstGeom>
            </spPr>
            """
        )
        mask = parse_shape_mask(sp_pr)
        self.assertEqual(mask["kind"], "round2SameRect")
        self.assertEqual(mask["adj1"], 0.1749)
        self.assertEqual(mask["adj2"], 0.0)
        self.assertEqual(mask["radius_pct"], 17.49)
        self.assertEqual(mask["radius_pct2"], 0.0)

        enriched = apply_mask_geometry(mask, {"width_pt": 270.48, "height_pt": 57.7})
        self.assertEqual(enriched["corner_radii_pt"], [10.09, 0.0, 0.0, 10.09])
        self.assertEqual(enriched["corner_radius_pt"], 10.09)

    def test_corner_radii_pt_round2_same_rect_asymmetric(self):
        radii = corner_radii_pt(
            "round2SameRect",
            100,
            50,
            adj1=0.1,
            adj2=0.2,
        )
        self.assertEqual(radii, [5.0, 10.0, 10.0, 5.0])

    def test_corner_radii_pt_round2_diag_rect(self):
        radii = corner_radii_pt(
            "round2DiagRect",
            100,
            50,
            adj1=0.1,
            adj2=0.2,
        )
        self.assertEqual(radii, [5.0, 10.0, 5.0, 10.0])


if __name__ == "__main__":
    unittest.main()
