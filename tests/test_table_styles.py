import unittest
from xml.etree import ElementTree as ET

from app.colors import _build_theme_map
from app.graphic_elements import (
    ROW_SIZING_FIXED,
    ROW_SIZING_FIT_CONTENT,
    apply_table_intrinsic_geometry,
    detect_table_row_sizing_mode,
    dimensions_close,
    estimate_cell_content_height_pt,
    parse_table_element,
    refine_table_row_sizing_with_frame,
    table_intrinsic_height_pt,
    table_intrinsic_width_pt,
    table_recalculated_height_pt,
)
from app.table_styles import (
    INVISIBLE_TABLE_BORDER,
    cell_style_part_names,
    complete_style_grid_typography,
    enrich_table_styles,
    is_invisible_table_border,
    list_blank_stub_cells,
    load_table_style_registry,
    merge_cell_styles,
    parse_table_condition_flags,
    resolve_cell_style_from_table_style,
)

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}

TABLE_XML = """
<a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:tblPr firstRow="1" bandRow="1">
    <a:tableStyleId>{BANDED}</a:tableStyleId>
  </a:tblPr>
  <a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid>
  <a:tr h="300000">
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="1400"/><a:t>H1</a:t></a:r></a:p></a:txBody>
      <a:tcPr/>
    </a:tc>
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1" sz="1400"/><a:t>H2</a:t></a:r></a:p></a:txBody>
      <a:tcPr/>
    </a:tc>
  </a:tr>
  <a:tr h="300000">
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>A</a:t></a:r></a:p></a:txBody>
      <a:tcPr/>
    </a:tc>
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>B</a:t></a:r></a:p></a:txBody>
      <a:tcPr/>
    </a:tc>
  </a:tr>
  <a:tr h="300000">
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>C</a:t></a:r></a:p></a:txBody>
      <a:tcPr/>
    </a:tc>
    <a:tc>
      <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1200"/><a:t>D</a:t></a:r></a:p></a:txBody>
      <a:tcPr/>
    </a:tc>
  </a:tr>
</a:tbl>
"""

TABLE_STYLES_XML = """
<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{BANDED}">
  <a:tblStyle styleId="{BANDED}" styleName="Banded">
    <a:wholeTbl>
      <a:tcStyle><a:fill><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:fill></a:tcStyle>
      <a:tcTxStyle b="0"/>
    </a:wholeTbl>
    <a:firstRow>
      <a:tcStyle><a:fill><a:solidFill><a:srgbClr val="0077FF"/></a:solidFill></a:fill></a:tcStyle>
      <a:tcTxStyle b="1"/>
    </a:firstRow>
    <a:band1H>
      <a:tcStyle><a:fill><a:solidFill><a:srgbClr val="F0F0F0"/></a:solidFill></a:fill></a:tcStyle>
    </a:band1H>
    <a:band2H>
      <a:tcStyle><a:fill><a:solidFill><a:srgbClr val="E0E0E0"/></a:solidFill></a:fill></a:tcStyle>
    </a:band2H>
  </a:tblStyle>
</a:tblStyleLst>
"""


class StubPackage:
    def __init__(self, parts: dict[str, str]):
        self._parts = parts

    def exists(self, part: str) -> bool:
        return part in self._parts

    def xml(self, part: str):
        from lxml import etree

        return etree.fromstring(self._parts[part].encode("utf-8"))


class TableStylesTests(unittest.TestCase):
    def setUp(self):
        self.theme_map = _build_theme_map({"colors": {}})
        self.theme_fonts = {"+mn-lt": "Arial"}

    def test_parse_table_condition_flags(self):
        tbl_pr = ET.fromstring('<a:tblPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" firstRow="1" bandRow="1"/>')
        flags = parse_table_condition_flags(tbl_pr)
        self.assertTrue(flags["first_row"])
        self.assertTrue(flags["band_row"])
        self.assertFalse(flags["first_col"])

    def test_cell_style_part_names_banding(self):
        flags = {"first_row": True, "last_row": False, "first_col": False, "last_col": False, "band_row": True, "band_col": False}
        self.assertIn("firstRow", cell_style_part_names(flags, 0, 0, 3, 2))
        self.assertIn("band1H", cell_style_part_names(flags, 1, 0, 3, 2))
        self.assertIn("band2H", cell_style_part_names(flags, 2, 0, 3, 2))

    def test_cell_style_part_names_last_col(self):
        flags = {"first_row": True, "last_row": False, "first_col": True, "last_col": True, "band_row": False, "band_col": False}
        self.assertIn("lastCol", cell_style_part_names(flags, 1, 11, 7, 12))
        self.assertIn("firstCol", cell_style_part_names(flags, 1, 0, 7, 12))

    def test_load_table_style_registry(self):
        package = StubPackage({"ppt/tableStyles.xml": TABLE_STYLES_XML})
        registry = load_table_style_registry(package, self.theme_map, self.theme_fonts)
        self.assertIn("{BANDED}", registry)
        self.assertIn("firstRow", registry["{BANDED}"])
        self.assertEqual(registry["{BANDED}"]["firstRow"]["fill"]["color"], "#0077FF")

    def test_resolve_cell_style_from_table_style(self):
        package = StubPackage({"ppt/tableStyles.xml": TABLE_STYLES_XML})
        registry = load_table_style_registry(package, self.theme_map, self.theme_fonts)
        flags = {"first_row": True, "last_row": False, "first_col": False, "last_col": False, "band_row": True, "band_col": False}
        header = resolve_cell_style_from_table_style(registry, "{BANDED}", flags, 0, 0, 3, 2)
        band1 = resolve_cell_style_from_table_style(registry, "{BANDED}", flags, 1, 0, 3, 2)
        band2 = resolve_cell_style_from_table_style(registry, "{BANDED}", flags, 2, 0, 3, 2)
        self.assertEqual(header["fill"]["color"], "#0077FF")
        self.assertEqual(band1["fill"]["color"], "#F0F0F0")
        self.assertEqual(band2["fill"]["color"], "#E0E0E0")

    def test_table_intrinsic_width_pt(self):
        width = table_intrinsic_width_pt([100.0, 50.0])
        self.assertEqual(width, 150.0)

    def test_table_intrinsic_height_pt(self):
        height = table_intrinsic_height_pt([10.0, 20.0, 30.0], 3)
        self.assertEqual(height, 60.0)

    def test_dimensions_close(self):
        self.assertTrue(dimensions_close(100.0, 100.5))
        self.assertFalse(dimensions_close(100.0, 110.0))

    def test_estimate_cell_content_height_pt(self):
        height = estimate_cell_content_height_pt(
            {
                "text": "Line one\nLine two",
                "typography": {"size_pt": 10.0},
                "paragraph_spacing_pt": {"line_spacing_ratio": 1.2},
            },
            {"padding_pt": {"top": 2.0, "bottom": 2.0}},
        )
        self.assertGreater(height, 20.0)

    def test_table_recalculated_height_pt_prefers_content_when_larger(self):
        table_payload = {
            "content_model": {"rows": 1},
            "row_heights_pt": [12.0],
            "cell_text": [[{
                "text": "One\nTwo\nThree",
                "typography": {"size_pt": 12.0},
                "paragraph_spacing_pt": {"line_spacing_ratio": 1.0},
            }]],
            "cell_styles": [[{"padding_pt": {"top": 2.0, "bottom": 2.0}}]],
        }
        recalculated, meta = table_recalculated_height_pt(table_payload)
        self.assertGreater(recalculated or 0, 12.0)
        self.assertEqual(meta["grid_sum_pt"], 12.0)
        self.assertGreater(meta["content_estimate_pt"] or 0, 12.0)

    def test_apply_table_intrinsic_geometry(self):
        geometry_pt = {"x_pt": 50.0, "y_pt": 100.0, "width_pt": 236.22, "height_pt": 236.22}
        geometry_norm = {"x": 0.05, "y": 0.2, "width": 0.2461, "height": 0.4374}
        table_payload = {
            "content_model": {"rows": 3},
            "column_widths_pt": [176.4, 61.9, 61.9],
            "row_heights_pt": [49.8, 49.8, 49.8],
            "structure": {
                "row_sizing": {
                    "mode": ROW_SIZING_FIXED,
                    "reason": "uniform_row_heights",
                    "uniform_row_height_pt": 49.8,
                },
            },
            "cell_text": [[None, None], [None, None], [None, None]],
            "cell_styles": [[None, None], [None, None], [None, None]],
        }
        slide_width_emu = 960 * 12700
        slide_height_emu = 540 * 12700
        updated_pt, updated_norm = apply_table_intrinsic_geometry(
            geometry_pt,
            geometry_norm,
            table_payload,
            slide_width_emu=slide_width_emu,
            slide_height_emu=slide_height_emu,
        )
        self.assertEqual(updated_pt["width_pt"], 300.2)
        self.assertEqual(updated_pt["height_pt"], 236.22)
        self.assertEqual(updated_pt["x_pt"], 50.0)
        self.assertAlmostEqual(updated_norm["width"], 300.2 / 960, places=4)
        self.assertEqual(updated_norm["height"], 0.4374)
        self.assertEqual(table_payload["layout_height_pt"], 236.22)
        self.assertEqual(table_payload["max_height_pt"], 236.22)
        self.assertTrue(table_payload["dimension_sources"]["height"]["reconciled"])
        self.assertEqual(table_payload["available_height_pt"], 440.0)

    def test_apply_table_intrinsic_geometry_fit_content_uses_frame_height(self):
        geometry_pt = {"x_pt": 51.88, "y_pt": 120.61, "width_pt": 856.24, "height_pt": 236.22}
        table_payload = {
            "content_model": {"rows": 12},
            "column_widths_pt": [89.89, 137.74, 154.96, 473.65],
            "row_heights_pt": [
                13.99, 23.18, 23.18, 10.54, 29.5, 10.54,
                35.82, 10.54, 10.54, 29.5, 10.54, 10.54,
            ],
            "structure": {"row_sizing": {"mode": ROW_SIZING_FIXED, "reason": "default_fixed_grid"}},
            "cell_text": [[None] * 4 for _ in range(12)],
            "cell_styles": [[None] * 4 for _ in range(12)],
        }
        updated_pt, _updated_norm = apply_table_intrinsic_geometry(
            geometry_pt,
            {"x": 0.054, "y": 0.2234, "width": 0.8919, "height": 0.4374},
            table_payload,
            slide_width_emu=960 * 12700,
            slide_height_emu=540 * 12700,
        )
        sizing = table_payload["structure"]["row_sizing"]
        self.assertEqual(sizing["mode"], ROW_SIZING_FIT_CONTENT)
        self.assertEqual(sizing["reason"], "frame_exceeds_row_grid")
        self.assertEqual(updated_pt["height_pt"], 236.22)
        self.assertEqual(table_payload["layout_height_pt"], 236.22)
        self.assertAlmostEqual(sizing["grid_sum_pt"], 218.41, places=1)

    def test_refine_table_row_sizing_with_frame_uniform_rows(self):
        table_payload = {
            "content_model": {"rows": 7},
            "row_heights_pt": [49.8, 49.8, 49.8, 49.8, 49.8, 49.8, 49.8],
            "structure": {"row_sizing": {"mode": ROW_SIZING_FIXED, "reason": "uniform_row_heights"}},
        }
        sizing = refine_table_row_sizing_with_frame(table_payload, 348.6)
        self.assertEqual(sizing["mode"], ROW_SIZING_FIXED)
        self.assertEqual(sizing["reason"], "frame_matches_uniform_row_grid")
        self.assertEqual(sizing["uniform_row_height_pt"], 49.8)

    def test_detect_table_row_sizing_mode_uniform_rows(self):
        sizing = detect_table_row_sizing_mode(
            [50.0, 50.0, 50.0],
            [[None], [None], [None]],
            [[None], [None], [None]],
            3,
        )
        self.assertEqual(sizing["mode"], ROW_SIZING_FIXED)
        self.assertEqual(sizing["uniform_row_height_pt"], 50.0)

    def test_detect_table_row_sizing_mode_tracks_content(self):
        cell_text = [[{
            "text": "Short",
            "typography": {"size_pt": 10.0},
            "paragraph_spacing_pt": {"line_spacing_ratio": 1.0},
        }], [{
            "text": "Much longer\nsecond line",
            "typography": {"size_pt": 10.0},
            "paragraph_spacing_pt": {"line_spacing_ratio": 1.0},
        }]]
        cell_styles = [[{"padding_pt": {"top": 1.0, "bottom": 1.0}}], [{"padding_pt": {"top": 1.0, "bottom": 1.0}}]]
        sizing = detect_table_row_sizing_mode(
            [14.0, 26.0],
            cell_text,
            cell_styles,
            2,
        )
        self.assertEqual(sizing["mode"], ROW_SIZING_FIT_CONTENT)

    def test_apply_table_intrinsic_geometry_keeps_frame_when_dimensions_agree(self):
        geometry_pt = {"x_pt": 10.0, "y_pt": 20.0, "width_pt": 150.0, "height_pt": 60.0}
        geometry_norm = {"x": 0.01, "y": 0.04, "width": 0.1563, "height": 0.1111}
        table_payload = {
            "content_model": {"rows": 2},
            "column_widths_pt": [150.0],
            "row_heights_pt": [30.0, 30.0],
            "cell_text": [[None], [None]],
            "cell_styles": [[None], [None]],
        }
        updated_pt, updated_norm = apply_table_intrinsic_geometry(
            geometry_pt,
            geometry_norm,
            table_payload,
            slide_width_emu=960 * 12700,
            slide_height_emu=540 * 12700,
        )
        self.assertEqual(updated_pt["height_pt"], 60.0)
        self.assertFalse(table_payload["dimension_sources"]["height"]["reconciled"])
        self.assertAlmostEqual(updated_norm["height"], 60.0 / 540, places=4)

    def test_merge_cell_styles_invisible_border_suppresses_table_style_side(self):
        base = {
            "borders": {
                "left": {"width_pt": 1.0, "color": {"kind": "solid", "color": "#FFFFFF", "alpha": 1.0}},
                "top": {"width_pt": 1.0, "color": {"kind": "solid", "color": "#FFFFFF", "alpha": 1.0}},
            }
        }
        overlay = {
            "borders": {
                "left": dict(INVISIBLE_TABLE_BORDER),
                "right": {"width_pt": 0.75, "color": {"kind": "solid", "color": "#0077FF", "alpha": 0.502}},
            }
        }
        merged = merge_cell_styles(base, overlay)
        self.assertIn("left", merged.get("borders", {}))
        self.assertTrue(is_invisible_table_border(merged["borders"]["left"]))
        self.assertEqual(merged["borders"]["right"]["color"]["color"], "#0077FF")
        self.assertEqual(merged["borders"]["top"]["color"]["color"], "#FFFFFF")

    def test_merge_cell_styles_preserves_table_style_text_color(self):
        base = {"typography": {"color": "#111111", "family": "Calibri"}}
        overlay = {"typography": {"family": "Arial", "size_pt": 10.0, "bold": False}}
        merged = merge_cell_styles(base, overlay)
        self.assertEqual(merged["typography"]["family"], "Arial")
        self.assertEqual(merged["typography"]["size_pt"], 10.0)
        self.assertEqual(merged["typography"]["color"], "#111111")

    def test_complete_style_grid_typography_fills_missing_body_color(self):
        style_grid = [[
            {"typography": {"family": "Arial", "size_pt": 12.0}},
            {"typography": {"family": "Arial", "size_pt": 12.0, "color": "#222222"}},
        ]]
        preview = [["", "text"]]
        completed = complete_style_grid_typography(
            style_grid,
            style_rules={},
            style_tokens={},
            flags={"last_col": False},
            row_count=1,
            col_count=2,
            theme_map={"tx1": "#333333"},
            preview=preview,
        )
        self.assertNotIn("typography", completed[0][0])
        self.assertEqual(completed[0][1]["typography"]["color"], "#222222")
        self.assertEqual(completed[0][1]["typography"]["size_pt"], 12.0)

    def test_list_blank_stub_cells_marks_empty_header_corner(self):
        preview = [["", "Заголовок столбца, млн", "Заголовок столбца, млн"]]
        cell_text = [[
            {"text": ""},
            {"text": "Заголовок столбца, млн", "typography": {"size_pt": 16}},
            {"text": "Заголовок столбца, млн", "typography": {"size_pt": 16}},
        ]]
        self.assertEqual(
            list_blank_stub_cells(preview, cell_text, header_row=0),
            [[0, 0]],
        )
        self.assertEqual(
            list_blank_stub_cells([["A", "B"]], cell_text=None, header_row=0),
            [],
        )

    def test_parse_table_element_merges_table_styles(self):
        table = ET.fromstring(TABLE_XML)
        package = StubPackage({"ppt/tableStyles.xml": TABLE_STYLES_XML})
        payload = parse_table_element(table, self.theme_map, self.theme_fonts, package=package)
        table_payload = payload["table"]
        self.assertTrue(table_payload["structure"]["flags"]["band_row"])
        self.assertEqual(table_payload["structure"]["header_row"], 0)
        self.assertEqual(table_payload["cell_styles"][0][0]["fill"]["color"], "#0077FF")
        self.assertEqual(table_payload["cell_styles"][1][0]["fill"]["color"], "#F0F0F0")
        self.assertEqual(table_payload["cell_styles"][2][0]["fill"]["color"], "#E0E0E0")
        self.assertIn("band1_row_cell", table_payload["style_tokens"])
        self.assertIn("band2_row_cell", table_payload["style_tokens"])
        self.assertIn("firstRow", table_payload["style_rules"])
        self.assertEqual(len(table_payload["cell_styles"]), 3)
        self.assertEqual(len(table_payload["cell_styles"][0]), 2)
        self.assertEqual(len(table_payload["data_preview"]["rows"][0]), 2)
        self.assertEqual(table_payload["layout_width_pt"], 472.44)
        self.assertEqual(table_payload["content_model"]["cell_fields"], ["value"])
        self.assertEqual(payload["component"]["ds_binding"]["content_model"]["fields"], ["value"])

    def test_parse_table_element_keeps_all_columns(self):
        cols = []
        cells = []
        for index in range(12):
            cols.append(f'<a:gridCol w="600000"/>')
            cells.append(
                f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>C{index}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>'
            )
        table_xml = f"""
        <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:tblPr firstRow="1" lastCol="1"><a:tableStyleId>{{WIDE}}</a:tableStyleId></a:tblPr>
          <a:tblGrid>{''.join(cols)}</a:tblGrid>
          <a:tr h="300000">{''.join(cells)}</a:tr>
        </a:tbl>
        """
        styles_xml = """
        <a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{WIDE}">
          <a:tblStyle styleId="{WIDE}" styleName="Wide">
            <a:wholeTbl><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>
            <a:firstRow><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="0077FF"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>
            <a:lastCol><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:fill></a:tcStyle></a:lastCol>
          </a:tblStyle>
        </a:tblStyleLst>
        """
        table = ET.fromstring(table_xml)
        package = StubPackage({"ppt/tableStyles.xml": styles_xml})
        payload = parse_table_element(table, self.theme_map, self.theme_fonts, package=package)
        self.assertEqual(payload["cols"], 12)
        self.assertEqual(len(payload["preview"][0]), 12)
        self.assertEqual(len(payload["table"]["cell_styles"][0]), 12)
        last_cell = payload["table"]["cell_styles"][0][11]
        self.assertEqual(last_cell["fill"]["color"], "#FF0000")
        self.assertTrue(payload["table"]["structure"]["flags"]["last_col"])
        self.assertIn("lastCol", payload["table"]["style_rules"])

    def test_parse_table_element_handles_horizontal_merge(self):
        table_xml = """
        <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:tblGrid>
            <a:gridCol w="1000000"/><a:gridCol w="2000000"/>
            <a:gridCol w="2000000"/><a:gridCol w="2000000"/>
          </a:tblGrid>
          <a:tr h="300000">
            <a:tc>
              <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>10:25 – 10:40</a:t></a:r></a:p></a:txBody>
              <a:tcPr/>
            </a:tc>
            <a:tc>
              <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Обсуждение доклада</a:t></a:r></a:p></a:txBody>
              <a:tcPr/>
            </a:tc>
            <a:tc><a:tcPr hMerge="1"/><a:txBody><a:bodyPr/><a:lstStyle/></a:txBody></a:tc>
            <a:tc><a:tcPr hMerge="1"/><a:txBody><a:bodyPr/><a:lstStyle/></a:txBody></a:tc>
          </a:tr>
        </a:tbl>
        """
        table = ET.fromstring(table_xml)
        payload = parse_table_element(table, self.theme_map, self.theme_fonts)
        self.assertEqual(payload["cols"], 4)
        self.assertEqual(payload["preview"][0], ["10:25 – 10:40", "Обсуждение доклада", "", ""])
        self.assertEqual(payload["table"]["structure"]["merged_cells"], [{
            "row": 0,
            "col": 1,
            "row_span": 1,
            "col_span": 3,
        }])
        anchor = payload["table"]["cell_styles"][0][1]
        self.assertIn("typography", anchor)
        for col_index in (2, 3):
            continuation = payload["table"]["cell_styles"][0][col_index] or {}
            self.assertNotIn("typography", continuation)

    def test_horizontal_merge_continuation_ignores_last_col_style(self):
        table_xml = """
        <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:tblPr firstRow="1" lastCol="1"><a:tableStyleId>{WIDE}</a:tableStyleId></a:tblPr>
          <a:tblGrid>
            <a:gridCol w="1000000"/><a:gridCol w="2000000"/>
            <a:gridCol w="2000000"/><a:gridCol w="2000000"/>
          </a:tblGrid>
          <a:tr h="300000">
            <a:tc>
              <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>10:25 – 10:40</a:t></a:r></a:p></a:txBody>
              <a:tcPr/>
            </a:tc>
            <a:tc>
              <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Обсуждение доклада</a:t></a:r></a:p></a:txBody>
              <a:tcPr/>
            </a:tc>
            <a:tc><a:tcPr hMerge="1"/><a:txBody><a:bodyPr/><a:lstStyle/></a:txBody></a:tc>
            <a:tc><a:tcPr hMerge="1"/><a:txBody><a:bodyPr/><a:lstStyle/></a:txBody></a:tc>
          </a:tr>
        </a:tbl>
        """
        styles_xml = """
        <a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{WIDE}">
          <a:tblStyle styleId="{WIDE}" styleName="Wide">
            <a:wholeTbl><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>
            <a:firstRow><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="0077FF"/></a:solidFill></a:fill></a:tcStyle></a:firstRow>
            <a:lastCol><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:fill></a:tcStyle></a:lastCol>
          </a:tblStyle>
        </a:tblStyleLst>
        """
        table = ET.fromstring(table_xml)
        package = StubPackage({"ppt/tableStyles.xml": styles_xml})
        payload = parse_table_element(table, self.theme_map, self.theme_fonts, package=package)
        anchor = payload["table"]["cell_styles"][0][1]
        self.assertEqual(anchor["fill"]["color"], "#0077FF")
        self.assertIn("typography", anchor)
        for col_index in (2, 3):
            continuation = payload["table"]["cell_styles"][0][col_index] or {}
            self.assertEqual(continuation.get("fill"), anchor.get("fill"))
            self.assertNotIn("typography", continuation)
        self.assertNotEqual(payload["table"]["cell_styles"][0][3]["fill"]["color"], "#FF0000")

    def test_parse_table_cell_text_extracts_bullet_list(self):
        table_xml = """
        <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:tblGrid><a:gridCol w="6096000"/></a:tblGrid>
          <a:tr h="300000">
            <a:tc>
              <a:txBody>
                <a:bodyPr/><a:lstStyle/>
                <a:p>
                  <a:pPr marL="254000" indent="-254000">
                    <a:buChar char="•"/>
                    <a:buSzPts val="1200"/>
                  </a:pPr>
                  <a:r><a:t>First item</a:t></a:r>
                </a:p>
                <a:p>
                  <a:pPr marL="254000" indent="-254000">
                    <a:buChar char="•"/>
                    <a:buSzPts val="1200"/>
                  </a:pPr>
                  <a:r><a:t>Second item</a:t></a:r>
                </a:p>
              </a:txBody>
              <a:tcPr/>
            </a:tc>
          </a:tr>
        </a:tbl>
        """
        table = ET.fromstring(table_xml)
        payload = parse_table_element(table, self.theme_map, self.theme_fonts)
        cell_text = payload["table"]["cell_text"][0][0]
        self.assertEqual(cell_text["text"], "First item\nSecond item")
        self.assertEqual(len(cell_text["text_segments"]), 2)
        self.assertEqual(cell_text["text_segments"][0]["bullet"]["char"], "•")
        self.assertEqual(cell_text["text_segments"][0]["text"], "First item")
        self.assertEqual(cell_text["text_segments"][1]["text"], "Second item")

    def test_parse_table_cell_text_extracts_multiline_segments(self):
        table_xml = """
        <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:tblGrid><a:gridCol w="6096000"/></a:tblGrid>
          <a:tr h="300000">
            <a:tc>
              <a:txBody>
                <a:bodyPr/><a:lstStyle/>
                <a:p><a:r><a:rPr sz="1400"/><a:t>Name</a:t></a:r></a:p>
                <a:p><a:r><a:rPr sz="1000"/><a:t>Title</a:t></a:r></a:p>
              </a:txBody>
              <a:tcPr/>
            </a:tc>
          </a:tr>
        </a:tbl>
        """
        table = ET.fromstring(table_xml)
        payload = parse_table_element(table, self.theme_map, self.theme_fonts)
        cell_text = payload["table"]["cell_text"][0][0]
        self.assertEqual(cell_text["text"], "Name\nTitle")
        self.assertEqual(len(cell_text["text_segments"]), 2)
        self.assertEqual(cell_text["text_segments"][0]["typography"]["size_pt"], 14.0)
        self.assertEqual(cell_text["text_segments"][1]["typography"]["size_pt"], 10.0)
        self.assertEqual(cell_text["text_paragraphs"][0]["text"], "Name")
        self.assertEqual(cell_text["text_paragraphs"][1]["text"], "Title")

    def test_infer_horizontal_merges_from_trailing_empty_cells(self):
        from app.graphic_elements import _infer_horizontal_merges

        preview = [
            ["10:00", "Topic", "Owner", "Questions"],
            ["10:25", "Discussion", "", ""],
            ["12:40", "Подведение итогов первого дня сессии", "", ""],
        ]
        merges = _infer_horizontal_merges(preview, [])
        self.assertEqual(len(merges), 2)
        self.assertEqual(merges[0]["row"], 1)
        self.assertEqual(merges[0]["col"], 1)
        self.assertEqual(merges[0]["col_span"], 3)
        self.assertTrue(merges[0]["inferred"])
        self.assertEqual(merges[1]["col"], 1)
        self.assertEqual(merges[1]["col_span"], 3)

    def test_parse_table_element_infers_merge_without_hmerge_markers(self):
        table_xml = """
        <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:tblGrid>
            <a:gridCol w="1000000"/><a:gridCol w="2000000"/>
            <a:gridCol w="2000000"/><a:gridCol w="2000000"/>
          </a:tblGrid>
          <a:tr h="300000">
            <a:tc>
              <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>12:40 – 13:30</a:t></a:r></a:p></a:txBody>
              <a:tcPr/>
            </a:tc>
            <a:tc>
              <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Подведение итогов первого дня сессии</a:t></a:r></a:p></a:txBody>
              <a:tcPr/>
            </a:tc>
            <a:tc><a:txBody><a:bodyPr/><a:lstStyle/></a:txBody><a:tcPr/></a:tc>
            <a:tc><a:txBody><a:bodyPr/><a:lstStyle/></a:txBody><a:tcPr/></a:tc>
          </a:tr>
        </a:tbl>
        """
        table = ET.fromstring(table_xml)
        payload = parse_table_element(table, self.theme_map, self.theme_fonts)
        merges = payload["table"]["structure"]["merged_cells"]
        self.assertEqual(len(merges), 1)
        self.assertEqual(merges[0]["row"], 0)
        self.assertEqual(merges[0]["col"], 1)
        self.assertEqual(merges[0]["col_span"], 3)

    def test_parse_table_cell_text_keeps_percent_as_plain_value(self):
        table_xml = """
        <a:tbl xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:tblGrid><a:gridCol w="6096000"/></a:tblGrid>
          <a:tr h="300000">
            <a:tc>
              <a:txBody>
                <a:bodyPr/><a:lstStyle/>
                <a:p><a:r><a:rPr sz="1200"/><a:t>32%</a:t></a:r></a:p>
              </a:txBody>
              <a:tcPr/>
            </a:tc>
          </a:tr>
        </a:tbl>
        """
        table = ET.fromstring(table_xml)
        payload = parse_table_element(table, self.theme_map, self.theme_fonts)
        cell_text = payload["table"]["cell_text"][0][0]
        self.assertEqual(cell_text["text"], "32%")
        self.assertNotIn("metric", cell_text)
        self.assertEqual(payload["table"]["content_model"]["cell_fields"], ["value"])


if __name__ == "__main__":
    unittest.main()
