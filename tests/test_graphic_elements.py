import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

from app.colors import _build_theme_map
from app.graphic_components import extract_graphic_components
from app.graphic_elements import parse_chart_element, parse_table_element
from app.pptx import PPTXPackage
from app.theme import extract_theme

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


TABLE_XML = """
<a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:tblPr><a:tableStyleId>{TEST}</a:tableStyleId></a:tblPr>
  <a:tblGrid><a:gridCol w="6096000"/><a:gridCol w="6096000"/></a:tblGrid>
  <a:tr h="389400">
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr b="1" sz="1400"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:latin typeface="Play"/></a:rPr><a:t>Header</a:t></a:r></a:p></a:txBody>
      <a:tcPr marT="108000" marB="108000"><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="0077FF"/></a:gs><a:gs pos="100000"><a:srgbClr val="00AEE8"/></a:gs></a:gsLst><a:lin ang="14400000" scaled="0"/></a:gradFill><a:lnB w="9525"><a:solidFill><a:srgbClr val="0077FF"/></a:solidFill></a:lnB></a:tcPr>
    </a:tc>
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr b="1" sz="1400"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:latin typeface="Play"/></a:rPr><a:t>Header</a:t></a:r></a:p></a:txBody>
      <a:tcPr marT="108000" marB="108000"><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="0077FF"/></a:gs><a:gs pos="100000"><a:srgbClr val="00AEE8"/></a:gs></a:gsLst><a:lin ang="14400000" scaled="0"/></a:gradFill></a:tcPr>
    </a:tc>
  </a:tr>
  <a:tr h="300000">
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr sz="1200"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill><a:latin typeface="Play"/></a:rPr><a:t>Body</a:t></a:r></a:p></a:txBody>
      <a:tcPr marT="72000" marB="72000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:tcPr>
    </a:tc>
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr sz="1200"><a:solidFill><a:schemeClr val="dk1"/></a:solidFill><a:latin typeface="Play"/></a:rPr><a:t>Body</a:t></a:r></a:p></a:txBody>
      <a:tcPr marT="72000" marB="72000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:tcPr>
    </a:tc>
  </a:tr>
</a:tbl>
"""


class GraphicElementsTests(unittest.TestCase):
    def setUp(self):
        pptx = Path("output/0182ecf29b63/source.pptx")
        if not pptx.exists():
            self.skipTest("sample deck missing")
        with PPTXPackage(pptx) as package:
            self.theme = extract_theme(package)
        self.theme_map = _build_theme_map(self.theme)

    def test_parse_table_element_extracts_style_tokens(self):
        table = ET.fromstring(TABLE_XML)
        payload = parse_table_element(table, self.theme_map, {"+mn-lt": "Play"})
        self.assertEqual(payload["rows"], 2)
        self.assertEqual(payload["cols"], 2)
        self.assertEqual(payload["table"]["table_style_id"], "{TEST}")
        self.assertEqual(payload["table"]["structure"]["header_row"], 0)
        self.assertEqual(len(payload["table"]["cell_styles"]), 2)
        self.assertEqual(payload["table"]["cell_styles"][0][0]["typography"]["bold"], True)
        self.assertEqual(payload["table"]["style_tokens"]["header_cell"]["typography"]["family"], "Play")
        self.assertEqual(payload["table"]["style_tokens"]["header_cell"]["typography"]["bold"], True)
        self.assertEqual(payload["table"]["style_tokens"]["body_cell"]["typography"]["size_pt"], 12.0)
        self.assertEqual(payload["component"]["kind"], "table")
        self.assertEqual(payload["component"]["slot_role"], "table")
        self.assertIn("DsTable", payload["component"]["ds_binding"]["component"])

    def test_parse_chart_element_from_sample_deck(self):
        pptx = Path("output/2a8ae2a8161e/source.pptx")
        if not pptx.exists():
            self.skipTest("chart sample deck missing")
        with PPTXPackage(pptx) as package:
            theme = extract_theme(package)
            theme_map = _build_theme_map(theme)
            slide_part = None
            graphic_data = None
            for part in package.list("ppt/slides/"):
                if not part.endswith(".xml"):
                    continue
                root = package.xml(part)
                frame = root.find(".//{http://schemas.openxmlformats.org/presentationml/2006/main}graphicFrame")
                if frame is None:
                    continue
                data = frame.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}graphicData")
                if data is None or data.get("uri") != "http://schemas.openxmlformats.org/drawingml/2006/chart":
                    continue
                slide_part = part
                graphic_data = data
                break
            self.assertIsNotNone(slide_part)
            payload = parse_chart_element(package, slide_part, graphic_data, theme_map)
        self.assertEqual(payload["chart_type"], "bar")
        self.assertEqual(payload["chart"]["subtype"]["direction"], "col")
        self.assertGreaterEqual(len(payload["chart"]["series"]), 1)
        self.assertTrue(payload["chart"]["categories_preview"])
        self.assertEqual(payload["component"]["kind"], "chart")

    def test_extract_graphic_components_clusters_instances(self):
        slides = {
            "slides": [
                {
                    "slide_number": 1,
                    "template_id": "tmpl_001",
                    "content_elements": [
                        {
                            "element_id": "slide_table_1",
                            "kind": "table",
                            "rows": 2,
                            "cols": 2,
                            "preview": [["A"]],
                            "table": {"style_tokens": {"header_cell": {"fill": {"color": "#0077FF"}}}, "structure": {"header_row": 0}},
                            "component": {"kind": "table", "slot_role": "table", "variant_signature": "table|sig-a"},
                        },
                        {
                            "element_id": "slide_table_2",
                            "kind": "table",
                            "rows": 2,
                            "cols": 2,
                            "preview": [["B"]],
                            "table": {"style_tokens": {"header_cell": {"fill": {"color": "#0077FF"}}}, "structure": {"header_row": 0}},
                            "component": {"kind": "table", "slot_role": "table", "variant_signature": "table|sig-a"},
                        },
                    ],
                }
            ]
        }
        result = extract_graphic_components(slides)
        self.assertEqual(result["summary"]["table_component_count"], 1)
        self.assertEqual(result["summary"]["table_instance_count"], 2)
        self.assertEqual(result["tables"][0]["frequency"]["instance_count"], 2)


if __name__ == "__main__":
    unittest.main()
