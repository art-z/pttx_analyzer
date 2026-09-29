import unittest
import xml.etree.ElementTree as ET

from app.text_slots import effective_run_typography
from app.template_layers import (
    NS,
    _extract_text_content,
    _extract_text_paragraphs,
    _flatten_text_runs,
    _paragraphs_to_text,
    _parse_bullet_color,
    _resolve_paragraph_spacing,
    _segments_need_split,
    _shape_layer,
    _slide_text_elements,
    _text_line_segments,
)

A = NS["a"]
P = NS["p"]


def _shape_with_body(body: ET.Element) -> ET.Element:
    shape = ET.Element(f"{{{P}}}sp")
    nv = ET.SubElement(shape, f"{{{P}}}nvSpPr")
    cnv = ET.SubElement(nv, f"{{{P}}}cNvPr")
    cnv.set("id", "42")
    cnv.set("name", "TextBox")
    sp_pr = ET.SubElement(shape, f"{{{P}}}spPr")
    xfrm = ET.SubElement(sp_pr, f"{{{A}}}xfrm")
    off = ET.SubElement(xfrm, f"{{{A}}}off")
    off.set("x", str(100 * 12700))
    off.set("y", str(200 * 12700))
    ext = ET.SubElement(xfrm, f"{{{A}}}ext")
    ext.set("cx", str(400 * 12700))
    ext.set("cy", str(100 * 12700))
    shape.append(body)
    return shape


class TextRunsExtractionTest(unittest.TestCase):
    def test_soft_break_inside_paragraph(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run1 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr1 = ET.SubElement(run1, f"{{{A}}}rPr")
        rpr1.set("b", "1")
        latin = ET.SubElement(rpr1, f"{{{A}}}latin")
        latin.set("typeface", "Play")
        t1 = ET.SubElement(run1, f"{{{A}}}t")
        t1.text = "Имя Фамилия"
        ET.SubElement(paragraph, f"{{{A}}}br")
        run2 = ET.SubElement(paragraph, f"{{{A}}}r")
        t2 = ET.SubElement(run2, f"{{{A}}}t")
        t2.text = "Описание"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        text = _paragraphs_to_text(paragraphs)
        runs = _flatten_text_runs(paragraphs)

        self.assertEqual(text, "Имя Фамилия\nОписание")
        self.assertEqual(runs[0]["text"], "Имя Фамилия")
        self.assertTrue(runs[0]["bold"])
        self.assertEqual(runs[1]["break"], "line")
        self.assertEqual(runs[2]["text"], "Описание")
        self.assertFalse(runs[2]["bold"])

    def test_paragraph_break(self):
        body = ET.Element(f"{{{P}}}txBody")
        for line in ("Line one", "Line two"):
            paragraph = ET.SubElement(body, f"{{{A}}}p")
            run = ET.SubElement(paragraph, f"{{{A}}}r")
            text = ET.SubElement(run, f"{{{A}}}t")
            text.text = line

        text = _extract_text_content(body)
        runs = _flatten_text_runs(_extract_text_paragraphs(body, {}, {}))

        self.assertEqual(text, "Line one\nLine two")
        self.assertEqual(runs[1]["break"], "paragraph")

    def test_mixed_styles_should_split(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run1 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr1 = ET.SubElement(run1, f"{{{A}}}rPr")
        rpr1.set("b", "1")
        ET.SubElement(run1, f"{{{A}}}t").text = "Bold line"
        ET.SubElement(paragraph, f"{{{A}}}br")
        run2 = ET.SubElement(paragraph, f"{{{A}}}r")
        ET.SubElement(run2, f"{{{A}}}t").text = "Regular line"

        segments = _text_line_segments(_extract_text_paragraphs(body, {}, {}))
        self.assertTrue(_segments_need_split(segments))

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 7, None)
        self.assertEqual(len(elements), 2)
        self.assertTrue(elements[0]["split_from_shape"])
        self.assertTrue(elements[0]["typography"]["bold"])
        self.assertFalse(elements[1]["typography"]["bold"])
        self.assertEqual(elements[0]["text_group_id"], elements[1]["text_group_id"])
        self.assertEqual(elements[0]["text_group_geometry_norm"], elements[1]["text_group_geometry_norm"])
        self.assertEqual(elements[0]["geometry_norm"], elements[0]["text_group_geometry_norm"])

    def test_split_text_group_exports_spacing_from_lns_pc(self):
        body = ET.Element(f"{{{P}}}txBody")
        body_pr = ET.SubElement(body, f"{{{A}}}bodyPr")
        body_pr.set("anchor", "ctr")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
        ln_spc = ET.SubElement(ppr, f"{{{A}}}lnSpc")
        spc_pct = ET.SubElement(ln_spc, f"{{{A}}}spcPct")
        spc_pct.set("val", "60000")
        run1 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr1 = ET.SubElement(run1, f"{{{A}}}rPr")
        rpr1.set("sz", "4400")
        ET.SubElement(run1, f"{{{A}}}t").text = "10"
        ET.SubElement(paragraph, f"{{{A}}}br")
        run2 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr2 = ET.SubElement(run2, f"{{{A}}}rPr")
        rpr2.set("sz", "2000")
        ET.SubElement(run2, f"{{{A}}}t").text = "млн"

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 14, None)
        self.assertEqual(len(elements), 2)
        spacing = elements[0]["text_group_spacing_pt"]
        self.assertEqual(spacing["line_step_pt"], 26.4)
        self.assertEqual(spacing["line_gap_pt"], 0.0)
        self.assertEqual(spacing["render_line_height_ratio"], 0.6)
        self.assertEqual(spacing["flex_stack_layout"], "compact_display")
        self.assertEqual(elements[0]["vertical_anchor"], "ctr")
        self.assertEqual(elements[1]["text_group_spacing_pt"], spacing)

    def test_same_style_multiline_stays_single_element(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run1 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr = ET.SubElement(run1, f"{{{A}}}rPr")
        rpr.set("sz", "4800")
        ET.SubElement(run1, f"{{{A}}}t").text = "Line one"
        ET.SubElement(paragraph, f"{{{A}}}br")
        run2 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr2 = ET.SubElement(run2, f"{{{A}}}rPr")
        rpr2.set("sz", "4800")
        ET.SubElement(run2, f"{{{A}}}t").text = "Line two"

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 8, None)
        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["text"], "Line one\nLine two")
        self.assertNotIn("text_runs", elements[0])

    def test_quote_like_shape_splits_only_on_size_change(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        for line in ("VK активно развивается", "и стремится стать центром технологической", "экспертизы в России."):
            run = ET.SubElement(paragraph, f"{{{A}}}r")
            rpr = ET.SubElement(run, f"{{{A}}}rPr")
            rpr.set("sz", "4000")
            ET.SubElement(run, f"{{{A}}}t").text = line
            ET.SubElement(paragraph, f"{{{A}}}br")

        spacer = ET.SubElement(body, f"{{{A}}}p")
        spacer_end = ET.SubElement(spacer, f"{{{A}}}endParaRPr")
        spacer_end.set("sz", "800")

        body_paragraph = ET.SubElement(body, f"{{{A}}}p")
        body_run = ET.SubElement(body_paragraph, f"{{{A}}}r")
        body_rpr = ET.SubElement(body_run, f"{{{A}}}rPr")
        body_rpr.set("sz", "2000")
        ET.SubElement(body_run, f"{{{A}}}t").text = "Уверен, что опыт коллег поможет."

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 19, None)
        self.assertEqual(len(elements), 2)
        self.assertTrue(elements[0]["split_from_shape"])
        self.assertEqual(elements[0]["typography"]["size_pt"], 40.0)
        self.assertEqual(
            elements[0]["text"],
            "VK активно развивается\nи стремится стать центром технологической\nэкспертизы в России.",
        )
        self.assertEqual(elements[1]["typography"]["size_pt"], 20.0)
        self.assertEqual(elements[1]["paragraph_spacing_pt"]["space_before"], 40.0)

    def test_inherited_lst_style_color(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr = ET.SubElement(run, f"{{{A}}}rPr")
        rpr.set("sz", "4800")
        ET.SubElement(run, f"{{{A}}}t").text = "Section title"

        levels = {1: {"family": "Play", "size_pt": 48.0, "color": "#FFFFFF", "bold": False}}
        typography = effective_run_typography(levels, paragraph, rpr, {}, {})
        self.assertEqual(typography["color"], "#FFFFFF")
        self.assertEqual(typography["family"], "Play")
        self.assertEqual(typography["size_pt"], 48.0)

    def test_run_color_overrides_inherited_level_color(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr = ET.SubElement(run, f"{{{A}}}rPr")
        rpr.set("sz", "3200")
        solid = ET.SubElement(rpr, f"{{{A}}}solidFill")
        ET.SubElement(solid, f"{{{A}}}schemeClr").set("val", "lt2")
        ET.SubElement(run, f"{{{A}}}t").text = "1"

        levels = {1: {"family": "Play", "size_pt": 16.0, "color": "#000000", "bold": False}}
        theme_map = {"lt2": "#FFFFFF", "dk1": "#000000"}
        typography = effective_run_typography(levels, paragraph, rpr, theme_map, {})
        self.assertEqual(typography["color"], "#FFFFFF")

    def test_paragraph_spacing_and_body_insets(self):
        body = ET.Element(f"{{{P}}}txBody")
        body_pr = ET.SubElement(body, f"{{{A}}}bodyPr")
        body_pr.set("lIns", str(int(7.2 * 12700)))
        body_pr.set("rIns", str(int(3.6 * 12700)))
        body_pr.set("tIns", str(int(3.6 * 12700)))
        body_pr.set("bIns", str(int(3.6 * 12700)))
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
        ppr.set("marL", str(int(14.12 * 12700)))
        ppr.set("indent", "0")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        ET.SubElement(run, f"{{{A}}}t").text = "Indented line"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        self.assertEqual(paragraphs[0]["margin_left_pt"], 14.12)

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 9, None)
        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["body_insets_pt"]["left"], 7.2)
        self.assertEqual(elements[0]["paragraph_spacing_pt"]["margin_left"], 14.12)

    def test_asymmetric_body_insets_are_ignored(self):
        body = ET.Element(f"{{{P}}}txBody")
        body_pr = ET.SubElement(body, f"{{{A}}}bodyPr")
        body_pr.set("lIns", "0")
        body_pr.set("rIns", str(int(7.2 * 12700)))
        body_pr.set("tIns", str(int(3.6 * 12700)))
        body_pr.set("bIns", str(int(3.6 * 12700)))
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        ET.SubElement(run, f"{{{A}}}t").text = "Body placeholder"

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 21, None)
        self.assertEqual(len(elements), 1)
        self.assertNotIn("body_insets_pt", elements[0])

    def test_split_card_lines_export_paragraph_margin(self):
        body = ET.Element(f"{{{P}}}txBody")
        body_pr = ET.SubElement(body, f"{{{A}}}bodyPr")
        body_pr.set("lIns", str(int(7.2 * 12700)))
        body_pr.set("rIns", str(int(7.2 * 12700)))
        body_pr.set("tIns", str(int(3.6 * 12700)))
        body_pr.set("bIns", str(int(3.6 * 12700)))
        for line in ("Title line", "Body line"):
            paragraph = ET.SubElement(body, f"{{{A}}}p")
            ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
            ppr.set("marL", str(int(14.12 * 12700)))
            ppr.set("indent", "0")
            run = ET.SubElement(paragraph, f"{{{A}}}r")
            rpr = ET.SubElement(run, f"{{{A}}}rPr")
            rpr.set("b", "1" if line.startswith("Title") else "0")
            ET.SubElement(run, f"{{{A}}}t").text = line

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 14, None)
        self.assertEqual(len(elements), 2)
        self.assertEqual(elements[0]["paragraph_spacing_pt"]["margin_left"], 14.12)
        self.assertEqual(elements[1]["paragraph_spacing_pt"]["margin_left"], 14.12)

    def test_bu_none_multiline_paragraph_block(self):
        body = ET.Element(f"{{{P}}}txBody")
        for index in range(5):
            before_pts = "0" if index == 0 else "750"
            paragraph = ET.SubElement(body, f"{{{A}}}p")
            ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
            ET.SubElement(ppr, f"{{{A}}}buNone")
            ppr.set("marL", str(int(13.5 * 12700)))
            ppr.set("indent", str(int(-13.5 * 12700)))
            ln_spc = ET.SubElement(ppr, f"{{{A}}}lnSpc")
            ET.SubElement(ln_spc, f"{{{A}}}spcPct").set("val", "90000")
            if before_pts != "0":
                spc_bef = ET.SubElement(ppr, f"{{{A}}}spcBef")
                ET.SubElement(spc_bef, f"{{{A}}}spcPts").set("val", before_pts)
            run = ET.SubElement(paragraph, f"{{{A}}}r")
            rpr = ET.SubElement(run, f"{{{A}}}rPr")
            rpr.set("sz", "1400")
            ET.SubElement(run, f"{{{A}}}t").text = f"Пункт {index + 1}"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        self.assertEqual(paragraphs[0].get("space_before_pt", 0.0), 0.0)
        self.assertEqual(paragraphs[1]["space_before_pt"], 7.5)
        self.assertEqual(paragraphs[1]["line_spacing_ratio"], 0.9)

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 10, None)
        self.assertEqual(len(elements), 1)
        element = elements[0]
        self.assertEqual(element["text"].count("\n"), 4)
        self.assertIsNone(element.get("bullet"))
        self.assertIn("text_paragraphs", element)
        self.assertEqual(len(element["text_paragraphs"]), 5)
        self.assertEqual(element["text_paragraphs"][1]["paragraph_spacing_pt"]["space_before"], 7.5)
        self.assertNotIn("margin_left", element["text_paragraphs"][0].get("paragraph_spacing_pt") or {})
        self.assertEqual(element["paragraph_spacing_pt"]["line_spacing_ratio"], 0.9)

    def test_vertical_anchor_exported(self):
        body = ET.Element(f"{{{P}}}txBody")
        body_pr = ET.SubElement(body, f"{{{A}}}bodyPr")
        body_pr.set("anchor", "ctr")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        ET.SubElement(run, f"{{{A}}}t").text = "Centered block"

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 10, None)
        self.assertEqual(elements[0]["vertical_anchor"], "ctr")

    def test_shape_with_fill_and_text_emits_both_layers(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        ET.SubElement(run, f"{{{A}}}t").text = "Card title"

        shape = _shape_with_body(body)
        sp_pr = shape.find(f"{{{P}}}spPr")
        solid = ET.SubElement(sp_pr, f"{{{A}}}solidFill")
        srgb = ET.SubElement(solid, f"{{{A}}}srgbClr")
        srgb.set("val", "FF0000")

        fill = _shape_layer(None, "", "slide", shape, 960 * 12700, 540 * 12700, {}, 11, None)
        text_layers = _slide_text_elements(None, "", shape, 960 * 12700, 540 * 12700, {}, {}, {}, 11, None)

        self.assertIsNotNone(fill)
        self.assertEqual(fill["kind"], "fill")
        self.assertEqual(fill["fill"]["color"], "#FF0000")
        self.assertEqual(len(text_layers), 1)
        self.assertEqual(text_layers[0]["text"], "Card title")

    def test_shape_fill_includes_stroke(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        ET.SubElement(run, f"{{{A}}}t").text = "Outlined"

        shape = _shape_with_body(body)
        sp_pr = shape.find(f"{{{P}}}spPr")
        solid = ET.SubElement(sp_pr, f"{{{A}}}solidFill")
        srgb = ET.SubElement(solid, f"{{{A}}}srgbClr")
        srgb.set("val", "FFFFFF")
        line = ET.SubElement(sp_pr, f"{{{A}}}ln")
        line.set("w", str(int(1.5 * 12700)))
        line_fill = ET.SubElement(line, f"{{{A}}}solidFill")
        line_color = ET.SubElement(line_fill, f"{{{A}}}srgbClr")
        line_color.set("val", "0077FF")

        fill = _shape_layer(None, "", "slide", shape, 960 * 12700, 540 * 12700, {}, 12, None)
        self.assertEqual(fill["stroke"]["width_pt"], 1.5)
        self.assertEqual(fill["stroke"]["color"]["color"], "#0077FF")

    def test_bullet_list_splits_into_items(self):
        body = ET.Element(f"{{{P}}}txBody")
        for line in ("First item", "Second item"):
            paragraph = ET.SubElement(body, f"{{{A}}}p")
            ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
            ppr.set("marL", str(int(20.13 * 12700)))
            ppr.set("indent", str(int(-20.13 * 12700)))
            ppr.set("lvl", "1")
            ET.SubElement(ppr, f"{{{A}}}buChar").set("char", "•")
            ET.SubElement(ppr, f"{{{A}}}buSzPts").set("val", "1600")
            run = ET.SubElement(paragraph, f"{{{A}}}r")
            ET.SubElement(run, f"{{{A}}}t").text = f"\u200b\u200b{line}"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        self.assertEqual(len(paragraphs), 2)
        self.assertEqual(paragraphs[0]["bullet"]["char"], "•")
        self.assertEqual(paragraphs[0]["bullet"]["size_pt"], 16.0)
        self.assertEqual(paragraphs[0]["margin_left_pt"], 20.13)
        self.assertEqual(paragraphs[0]["indent_pt"], -20.13)

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 13, None)
        self.assertEqual(len(elements), 2)
        self.assertTrue(elements[0]["split_from_shape"])
        self.assertEqual(elements[0]["bullet"]["char"], "•")
        self.assertEqual(elements[0]["text"], "First item")

    def test_bullet_color_uses_same_level_not_lower_level(self):
        slide_body = ET.Element(f"{{{P}}}txBody")
        ET.SubElement(slide_body, f"{{{A}}}lstStyle")

        layout_body = ET.Element(f"{{{P}}}txBody")
        layout_lst = ET.SubElement(layout_body, f"{{{A}}}lstStyle")
        layout_lvl1 = ET.SubElement(layout_lst, f"{{{A}}}lvl1pPr")
        layout_bu_clr = ET.SubElement(layout_lvl1, f"{{{A}}}buClr")
        ET.SubElement(layout_bu_clr, f"{{{A}}}schemeClr").set("val", "dk1")
        layout_lvl2 = ET.SubElement(layout_lst, f"{{{A}}}lvl2pPr")
        ET.SubElement(layout_lvl2, f"{{{A}}}buChar").set("char", "•")

        master_body = ET.Element(f"{{{P}}}txBody")
        master_lst = ET.SubElement(master_body, f"{{{A}}}lstStyle")
        master_lvl2 = ET.SubElement(master_lst, f"{{{A}}}lvl2pPr")
        master_bu_clr = ET.SubElement(master_lvl2, f"{{{A}}}buClr")
        ET.SubElement(master_bu_clr, f"{{{A}}}schemeClr").set("val", "accent1")

        paragraph = ET.SubElement(slide_body, f"{{{A}}}p")
        ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
        ppr.set("lvl", "1")
        ET.SubElement(ppr, f"{{{A}}}buChar").set("char", "•")

        theme_map = {"accent1": "#0077FF", "dk1": "#000000"}
        color = _parse_bullet_color(
            ppr,
            [slide_body, layout_body, master_body],
            1,
            theme_map,
        )
        self.assertEqual(color, "#0077FF")

    def test_display_number_lnSpc_not_used_for_line_height(self):
        body = ET.Element(f"{{{P}}}txBody")
        for size_hundredths, pct_val in ((16600, "16150"), (9600, "27927")):
            paragraph = ET.SubElement(body, f"{{{A}}}p")
            ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
            ln_spc = ET.SubElement(ppr, f"{{{A}}}lnSpc")
            ET.SubElement(ln_spc, f"{{{A}}}spcPct").set("val", pct_val)
            run = ET.SubElement(paragraph, f"{{{A}}}r")
            rpr = ET.SubElement(run, f"{{{A}}}rPr")
            rpr.set("sz", str(size_hundredths))
            ET.SubElement(run, f"{{{A}}}t").text = "7"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        self.assertEqual(paragraphs[0]["line_spacing_ratio"], 0.162)
        self.assertFalse(paragraphs[0]["line_height_applicable"])
        self.assertNotIn("line_height_pt", paragraphs[0])
        self.assertEqual(paragraphs[1]["line_spacing_ratio"], 0.279)
        self.assertFalse(paragraphs[1]["line_height_applicable"])

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 42, None)
        typography = elements[0]["typography"]
        self.assertEqual(typography["pptx_line_spacing_ratio"], 0.162)
        self.assertFalse(typography["line_height_applicable"])
        self.assertNotIn("line_height_ratio", typography)
        spacing = elements[0]["paragraph_spacing_pt"]
        self.assertEqual(spacing["line_spacing_ratio"], 0.162)
        self.assertFalse(spacing["line_height_applicable"])

    def test_line_spacing_points_not_mistaken_for_ratio(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
        ln_spc = ET.SubElement(ppr, f"{{{A}}}lnSpc")
        ET.SubElement(ln_spc, f"{{{A}}}spcPts").set("val", "2700")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr = ET.SubElement(run, f"{{{A}}}rPr")
        rpr.set("sz", "9600")
        ET.SubElement(run, f"{{{A}}}t").text = "91%"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        self.assertEqual(paragraphs[0]["line_spacing_ratio"], 0.281)
        self.assertFalse(paragraphs[0]["line_height_applicable"])
        self.assertNotIn("line_height_pt", paragraphs[0])
        self.assertEqual(paragraphs[0]["line_spacing_unit"], "pt")

    def test_list_item_spacing_before_one_line(self):
        body = ET.Element(f"{{{P}}}txBody")
        for index, before_pts in enumerate(("0", "500")):
            paragraph = ET.SubElement(body, f"{{{A}}}p")
            ppr = ET.SubElement(paragraph, f"{{{A}}}pPr")
            ppr.set("lvl", "1")
            ln_spc = ET.SubElement(ppr, f"{{{A}}}lnSpc")
            ET.SubElement(ln_spc, f"{{{A}}}spcPct").set("val", "110000")
            spc_bef = ET.SubElement(ppr, f"{{{A}}}spcBef")
            ET.SubElement(spc_bef, f"{{{A}}}spcPts").set("val", before_pts)
            ET.SubElement(ppr, f"{{{A}}}buChar").set("char", "•")
            run = ET.SubElement(paragraph, f"{{{A}}}r")
            rpr = ET.SubElement(run, f"{{{A}}}rPr")
            rpr.set("sz", "1600")
            ET.SubElement(run, f"{{{A}}}t").text = f"Item {index + 1}"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        self.assertEqual(paragraphs[0]["space_before_pt"], 0.0)
        self.assertEqual(paragraphs[0]["line_spacing_ratio"], 1.1)
        self.assertEqual(paragraphs[1]["space_before_pt"], 16.0)
        self.assertEqual(paragraphs[1]["line_spacing_ratio"], 1.1)

        payload = _text_line_segments(paragraphs)
        self.assertEqual(payload[1]["space_before_pt"], 16.0)


    def test_strikethrough_run_is_exported(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run1 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr1 = ET.SubElement(run1, f"{{{A}}}rPr")
        rpr1.set("sz", "2400")
        ET.SubElement(run1, f"{{{A}}}t").text = "259 ₽ "
        run2 = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr2 = ET.SubElement(run2, f"{{{A}}}rPr")
        rpr2.set("sz", "1600")
        rpr2.set("strike", "sngStrike")
        ET.SubElement(run2, f"{{{A}}}t").text = "279 ₽"

        runs = _flatten_text_runs(_extract_text_paragraphs(body, {}, {}))
        self.assertFalse(runs[0].get("strike"))
        self.assertTrue(runs[1].get("strike"))

        elements = _slide_text_elements(None, "", _shape_with_body(body), 960 * 12700, 540 * 12700, {}, {}, {}, 50, None)
        self.assertEqual(len(elements), 1)
        self.assertIn("text_runs", elements[0])
        self.assertTrue(elements[0]["text_runs"][1].get("strike"))

    def test_strikethrough_child_element(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr = ET.SubElement(run, f"{{{A}}}rPr")
        ET.SubElement(rpr, f"{{{A}}}strike")
        ET.SubElement(run, f"{{{A}}}t").text = "Old price"

        runs = _flatten_text_runs(_extract_text_paragraphs(body, {}, {}))
        self.assertTrue(runs[0].get("strike"))


if __name__ == "__main__":
    unittest.main()
