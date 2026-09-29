import unittest
import xml.etree.ElementTree as ET

from app.metric_text import (
    attach_metric_fields,
    detect_metric_text,
    paragraph_is_metric,
    segments_form_metric,
)
from app.template_layers import NS, _extract_text_paragraphs, _segments_need_split, _slide_text_elements, _text_line_segments

A = NS["a"]
P = NS["p"]


def _shape_with_body(body: ET.Element) -> ET.Element:
    shape = ET.Element(f"{{{P}}}sp")
    nv = ET.SubElement(shape, f"{{{P}}}nvSpPr")
    cnv = ET.SubElement(nv, f"{{{P}}}cNvPr")
    cnv.set("id", "42")
    cnv.set("name", "Metric")
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


class MetricTextTests(unittest.TestCase):
    def test_detect_metric_from_text_fallback(self):
        metric = detect_metric_text("33%", [], {"size_pt": 88.0, "bold": True})
        self.assertEqual(metric["value"], "33")
        self.assertEqual(metric["unit"], "%")
        self.assertEqual(metric["value_typography"]["size_pt"], 88.0)

    def test_detect_metric_from_mixed_runs(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run_value = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_value = ET.SubElement(run_value, f"{{{A}}}rPr")
        rpr_value.set("sz", "8800")
        rpr_value.set("b", "1")
        ET.SubElement(run_value, f"{{{A}}}t").text = "23"
        run_unit = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_unit = ET.SubElement(run_unit, f"{{{A}}}rPr")
        rpr_unit.set("sz", "4400")
        ET.SubElement(run_unit, f"{{{A}}}t").text = "%"

        paragraphs = _extract_text_paragraphs(body, {}, {})
        runs = []
        for paragraph in paragraphs:
            runs.extend(paragraph.get("runs") or [])
        metric = detect_metric_text("23%", runs, {"size_pt": 88.0, "bold": True})
        self.assertEqual(metric["value"], "23")
        self.assertEqual(metric["unit"], "%")
        self.assertEqual(metric["value_typography"]["size_pt"], 88.0)
        self.assertEqual(metric["unit_typography"]["size_pt"], 44.0)
        self.assertEqual(metric["split_source"], "runs")

    def test_slide_text_element_exports_metric(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run_value = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_value = ET.SubElement(run_value, f"{{{A}}}rPr")
        rpr_value.set("sz", "8800")
        rpr_value.set("b", "1")
        ET.SubElement(run_value, f"{{{A}}}t").text = "23"
        run_unit = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_unit = ET.SubElement(run_unit, f"{{{A}}}rPr")
        rpr_unit.set("sz", "4400")
        ET.SubElement(run_unit, f"{{{A}}}t").text = "%"

        elements = _slide_text_elements(
            None,
            "",
            _shape_with_body(body),
            960 * 12700,
            540 * 12700,
            {},
            {},
            {},
            18,
            None,
        )
        self.assertEqual(len(elements), 1)
        self.assertEqual(elements[0]["text"], "23%")
        self.assertIn("metric", elements[0])
        self.assertEqual(elements[0]["metric"]["unit"], "%")
        self.assertIn("text_runs", elements[0])

    def test_attach_metric_fields_on_element(self):
        paragraphs = [{
            "alignment": "l",
            "runs": [
                {"text": "43", "size_pt": 239.0, "bold": True, "family": "Play", "color": "#0077FF"},
                {"text": "%", "size_pt": 88.0, "bold": False, "family": "Play", "color": "#0077FF"},
            ],
            "text": "43%",
        }]
        element = {"text": "43%", "typography": {"size_pt": 239.0, "bold": True, "family": "Play", "color": "#0077FF"}}
        attach_metric_fields(element, paragraphs)
        self.assertEqual(element["metric"]["value"], "43")
        self.assertEqual(element["metric"]["unit"], "%")
        self.assertEqual(element["metric"]["unit_typography"]["size_pt"], 88.0)

    def test_paragraph_is_metric_across_soft_break(self):
        body = self._metric_multiline_body()
        paragraphs = _extract_text_paragraphs(body, {}, {})
        self.assertFalse(paragraph_is_metric(paragraphs[0]))

    def test_metric_with_soft_break_stays_split_for_vertical_stack(self):
        elements = _slide_text_elements(
            None,
            "",
            _shape_with_body(self._metric_multiline_body()),
            960 * 12700,
            540 * 12700,
            {},
            {},
            {},
            18,
            None,
        )
        self.assertEqual(len(elements), 2)
        self.assertTrue(all(element.get("text_group_id") for element in elements))
        self.assertEqual({element["text"] for element in elements}, {"23", "%"})

    def test_segments_form_metric_guard(self):
        segments = [
            {"text": "23", "typography": {"size_pt": 88.0, "bold": True}},
            {"text": "%", "typography": {"size_pt": 44.0, "bold": False}},
        ]
        self.assertFalse(segments_form_metric(segments))

    def test_detect_metric_with_cyrillic_unit(self):
        metric = detect_metric_text("10млн", [], {"size_pt": 44.0, "family": "Play"})
        self.assertEqual(metric["value"], "10")
        self.assertEqual(metric["unit"], "млн")

    def test_metric_with_cyrillic_soft_break_stays_split_for_vertical_stack(self):
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run_value = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_value = ET.SubElement(run_value, f"{{{A}}}rPr")
        rpr_value.set("sz", "4400")
        ET.SubElement(run_value, f"{{{A}}}t").text = "10"
        ET.SubElement(paragraph, f"{{{A}}}br")
        run_unit = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_unit = ET.SubElement(run_unit, f"{{{A}}}rPr")
        rpr_unit.set("sz", "2000")
        ET.SubElement(run_unit, f"{{{A}}}t").text = "млн"

        elements = _slide_text_elements(
            None,
            "",
            _shape_with_body(body),
            960 * 12700,
            540 * 12700,
            {},
            {},
            {},
            18,
            None,
        )
        self.assertEqual(len(elements), 2)
        self.assertTrue(all(element.get("text_group_id") for element in elements))
        self.assertEqual({element["text"] for element in elements}, {"10", "млн"})
        self.assertEqual(elements[0]["typography"]["size_pt"], 44.0)
        self.assertEqual(elements[1]["typography"]["size_pt"], 20.0)

    @staticmethod
    def _metric_multiline_body() -> ET.Element:
        body = ET.Element(f"{{{P}}}txBody")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        run_value = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_value = ET.SubElement(run_value, f"{{{A}}}rPr")
        rpr_value.set("sz", "8800")
        rpr_value.set("b", "1")
        ET.SubElement(run_value, f"{{{A}}}t").text = "23"
        ET.SubElement(paragraph, f"{{{A}}}br")
        run_unit = ET.SubElement(paragraph, f"{{{A}}}r")
        rpr_unit = ET.SubElement(run_unit, f"{{{A}}}rPr")
        rpr_unit.set("sz", "4400")
        ET.SubElement(run_unit, f"{{{A}}}t").text = "%"
        return body


if __name__ == "__main__":
    unittest.main()
