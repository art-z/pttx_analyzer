import copy
import json
import unittest
from pathlib import Path

from app.layout_table_inference import apply_layout_table_inference, infer_layout_table_on_slide


def _text_element(
    element_id: str,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
    z_index: int = 10,
) -> dict:
    return {
        "element_id": element_id,
        "kind": "text",
        "source_scope": "slide",
        "z_index": z_index,
        "shape_id": element_id,
        "geometry_pt": {
            "x_pt": x,
            "y_pt": y,
            "width_pt": width,
            "height_pt": height,
        },
        "geometry_norm": {
            "x": x / 720,
            "y": y / 405,
            "width": width / 720,
            "height": height / 405,
        },
        "text": text,
        "text_sample": text[:40],
        "typography": {
            "family": "Arial",
            "size_pt": 10.0,
            "bold": False,
            "color": "#000000",
            "alignment": "l",
        },
    }


def _hline_element(element_id: str, *, y: float, width: float = 600.0, z_index: int = 20) -> dict:
    return {
        "element_id": element_id,
        "kind": "image",
        "source_scope": "slide",
        "z_index": z_index,
        "geometry_pt": {
            "x_pt": 40.0,
            "y_pt": y,
            "width_pt": width,
            "height_pt": 0.54,
        },
        "geometry_norm": {
            "x": 40.0 / 720,
            "y": y / 405,
            "width": width / 720,
            "height": 0.54 / 405,
        },
        "name": element_id,
    }


def _frame_element(
    element_id: str,
    *,
    x: float,
    y: float,
    width: float,
    height: float,
    z_index: int = 5,
) -> dict:
    return {
        "element_id": element_id,
        "kind": "image",
        "source_scope": "slide",
        "z_index": z_index,
        "geometry_pt": {
            "x_pt": x,
            "y_pt": y,
            "width_pt": width,
            "height_pt": height,
        },
        "geometry_norm": {
            "x": x / 720,
            "y": y / 405,
            "width": width / 720,
            "height": height / 405,
        },
        "name": element_id,
    }


class LayoutTableInferenceTests(unittest.TestCase):
    def test_title_with_different_font_size_stays_outside_table(self):
        title = _text_element("title", x=14, y=22, width=534, height=57, text="Slide title", z_index=1)
        title["typography"] = {"family": "Play", "size_pt": 24.0, "bold": False, "color": "#000000"}
        title["placeholder_type"] = "title"

        slide = {
            "slide_number": 36,
            "content_elements": [
                title,
                _text_element("h1", x=120, y=112, width=54, height=13, text="Metric", z_index=2),
                _text_element("h2", x=203, y=112, width=54, height=13, text="Metric", z_index=3),
                _text_element("h3", x=287, y=112, width=54, height=13, text="Metric", z_index=4),
                _text_element("d1", x=120, y=134, width=24, height=13, text=">50*", z_index=5),
                _text_element("d2", x=203, y=134, width=24, height=13, text=">50*", z_index=6),
                _text_element("d3", x=287, y=134, width=24, height=13, text=">50*", z_index=7),
                _text_element("d4", x=120, y=156, width=24, height=13, text=">50*", z_index=8),
                _text_element("d5", x=203, y=156, width=24, height=13, text=">50*", z_index=9),
                _text_element("d6", x=287, y=156, width=24, height=13, text=">50*", z_index=10),
            ],
        }

        self.assertTrue(infer_layout_table_on_slide(slide, 720.0, 405.0))
        self.assertEqual(slide["element_summary"].get("table"), 1)
        self.assertEqual(slide["element_summary"].get("text"), 1)
        remaining_title = next(
            element for element in slide["content_elements"]
            if element.get("element_id") == "title"
        )
        self.assertEqual(remaining_title.get("text"), "Slide title")

    def test_infer_simple_grid_replaces_text_shapes_with_table(self):
        slide = {
            "slide_number": 36,
            "content_elements": [
                _text_element("h1", x=120, y=112, width=54, height=13, text="Metric", z_index=2),
                _text_element("h2", x=203, y=112, width=54, height=13, text="Metric", z_index=3),
                _text_element("h3", x=287, y=112, width=54, height=13, text="Metric", z_index=4),
                _text_element("d1", x=120, y=134, width=24, height=13, text=">50*", z_index=5),
                _text_element("d2", x=203, y=134, width=24, height=13, text=">50*", z_index=6),
                _text_element("d3", x=287, y=134, width=24, height=13, text=">50*", z_index=7),
                _text_element("d4", x=120, y=156, width=24, height=13, text=">50*", z_index=8),
                _text_element("d5", x=203, y=156, width=24, height=13, text=">50*", z_index=9),
                _text_element("d6", x=287, y=156, width=24, height=13, text=">50*", z_index=10),
                _hline_element("line1", y=150.1, z_index=11),
            ],
        }

        self.assertTrue(infer_layout_table_on_slide(slide, 720.0, 405.0))
        self.assertEqual(slide["element_summary"].get("table"), 1)
        self.assertEqual(slide["element_summary"].get("text", 0), 0)

        table = next(element for element in slide["content_elements"] if element["kind"] == "table")
        self.assertEqual(table["table"]["source"], "inferred_grid")
        self.assertGreaterEqual(table["rows"], 2)
        self.assertGreaterEqual(table["cols"], 2)
        self.assertEqual(table["inference"]["typography_size_pt"], 10.0)
        self.assertIn("layout_width_pt", table["table"])
        self.assertIn("layout_height_pt", table["table"])
        cell_styles = table["table"]["cell_styles"]
        cell_text = table["table"]["cell_text"]
        self.assertIn("typography", cell_text[0][0])
        self.assertIn("typography", cell_styles[0][0])
        self.assertNotIn("typography", table["table"]["style_tokens"]["body_cell"])
        if "header_cell" in table["table"]["style_tokens"]:
            self.assertNotIn("typography", table["table"]["style_tokens"]["header_cell"])

    def test_inferred_grid_keeps_typography_out_of_empty_cells(self):
        slide = {
            "slide_number": 99,
            "content_elements": [
                _text_element("a1", x=100, y=100, width=40, height=12, text="A1", z_index=2),
                _text_element("a2", x=160, y=100, width=40, height=12, text="A2", z_index=3),
                _text_element("a3", x=220, y=100, width=40, height=12, text="A3", z_index=4),
                _text_element("b1", x=100, y=120, width=40, height=12, text="B1", z_index=5),
                _text_element("b2", x=160, y=120, width=40, height=12, text="B2", z_index=6),
                _text_element("b3", x=220, y=120, width=40, height=12, text="B3", z_index=7),
                _text_element("c1", x=100, y=140, width=40, height=12, text="C1", z_index=8),
                _text_element("c3", x=220, y=140, width=40, height=12, text="C3", z_index=9),
                _text_element("d1", x=100, y=160, width=40, height=12, text="D1", z_index=10),
                _text_element("d2", x=160, y=160, width=40, height=12, text="D2", z_index=11),
                _text_element("d3", x=220, y=160, width=40, height=12, text="D3", z_index=12),
            ],
        }

        self.assertTrue(infer_layout_table_on_slide(slide, 720.0, 405.0))
        table = next(element for element in slide["content_elements"] if element["kind"] == "table")
        cell_styles = table["table"]["cell_styles"]
        cell_text = table["table"]["cell_text"]
        self.assertIsNone(cell_styles[2][1])
        self.assertIsNone(cell_text[2][1])
        self.assertIn("typography", cell_styles[0][0])
        self.assertIn("typography", cell_text[0][0])

    def test_inferred_table_variant_signature_uses_cell_text_typography(self):
        from app.graphic_elements import _table_variant_signature

        slide = {
            "slide_number": 36,
            "content_elements": [
                _text_element("h1", x=120, y=112, width=54, height=13, text="Metric", z_index=2),
                _text_element("h2", x=203, y=112, width=54, height=13, text="Metric", z_index=3),
                _text_element("h3", x=287, y=112, width=54, height=13, text="Metric", z_index=4),
                _text_element("d1", x=120, y=134, width=24, height=13, text=">50*", z_index=5),
                _text_element("d2", x=203, y=134, width=24, height=13, text=">50*", z_index=6),
                _text_element("d3", x=287, y=134, width=24, height=13, text=">50*", z_index=7),
                _text_element("d4", x=120, y=156, width=24, height=13, text=">50*", z_index=8),
                _text_element("d5", x=203, y=156, width=24, height=13, text=">50*", z_index=9),
                _text_element("d6", x=287, y=156, width=24, height=13, text=">50*", z_index=10),
            ],
        }

        self.assertTrue(infer_layout_table_on_slide(slide, 720.0, 405.0))
        table = next(element for element in slide["content_elements"] if element["kind"] == "table")
        signature = _table_variant_signature(table["table"])
        self.assertTrue(signature.startswith("table|inferred_grid|"))
        self.assertIn("10.0", signature)
        self.assertIn("Arial", signature)
        self.assertNotIn("typography", table["table"]["style_tokens"]["body_cell"])

    def test_background_frame_sets_table_geometry_and_keeps_background(self):
        slide = {
            "slide_number": 36,
            "content_elements": [
                _frame_element("bg", x=100, y=100, width=320, height=120, z_index=5),
                _text_element("h1", x=120, y=112, width=54, height=13, text="Metric", z_index=10),
                _text_element("h2", x=203, y=112, width=54, height=13, text="Metric", z_index=11),
                _text_element("h3", x=287, y=112, width=54, height=13, text="Metric", z_index=12),
                _text_element("d1", x=120, y=134, width=24, height=13, text=">50*", z_index=13),
                _text_element("d2", x=203, y=134, width=24, height=13, text=">50*", z_index=14),
                _text_element("d3", x=287, y=134, width=24, height=13, text=">50*", z_index=15),
                _text_element("d4", x=120, y=156, width=24, height=13, text=">50*", z_index=16),
                _text_element("d5", x=203, y=156, width=24, height=13, text=">50*", z_index=17),
                _text_element("d6", x=287, y=156, width=24, height=13, text=">50*", z_index=18),
            ],
        }

        self.assertTrue(infer_layout_table_on_slide(slide, 720.0, 405.0))
        table = next(element for element in slide["content_elements"] if element["kind"] == "table")
        self.assertEqual(table["table"]["frame_source"], "background_shape")
        self.assertEqual(table["geometry_pt"]["x_pt"], 100.0)
        self.assertEqual(table["geometry_pt"]["y_pt"], 100.0)
        self.assertEqual(table["geometry_pt"]["width_pt"], 320.0)
        self.assertEqual(table["geometry_pt"]["height_pt"], 120.0)
        self.assertIn("padding_pt", table["table"])
        self.assertGreater(table["table"]["padding_pt"]["left"], 0)
        self.assertLess(table["table"]["layout_width_pt"], 320.0)
        self.assertEqual(table["table"]["structure"]["row_sizing"]["mode"], "fit_content")
        self.assertEqual(table["inference"]["frame_element_id"], "bg")
        self.assertIn("bg", [element.get("element_id") for element in slide["content_elements"]])
        self.assertEqual(slide["element_summary"].get("image"), 1)

    def test_skips_slide_with_native_table(self):
        slide = {
            "slide_number": 1,
            "content_elements": [
                {"element_id": "native", "kind": "table", "table": {}},
                _text_element("cell", x=10, y=10, width=20, height=10, text="A"),
            ],
        }
        self.assertFalse(infer_layout_table_on_slide(slide, 720.0, 405.0))

    def test_slide_36_from_report_if_available(self):
        report_path = Path("output/fa721249ff0b/report.json")
        if not report_path.exists():
            self.skipTest("report missing")

        report = json.loads(report_path.read_text())
        slides = copy.deepcopy(report["slides"])
        slide_size = (
            report["typography"]["visibility"]["slide_size_pt"]["width"],
            report["typography"]["visibility"]["slide_size_pt"]["height"],
        )
        apply_layout_table_inference(slides, slide_size)

        slide = next(item for item in slides["slides"] if item["slide_number"] == 36)
        self.assertIn("inferred_table", slide)
        self.assertEqual(slide["element_summary"].get("table"), 1)
        table = next(element for element in slide["content_elements"] if element["kind"] == "table")
        self.assertEqual(table["rows"], 10)
        self.assertEqual(table["cols"], 8)
        self.assertEqual(table["inference"]["filled_cells"], 80)
        self.assertEqual(table["inference"]["typography_size_pt"], 6.75)
        self.assertEqual(slide["element_summary"].get("text"), 1)
        title = next(element for element in slide["content_elements"] if element.get("placeholder_type") == "title")
        self.assertIn("Заголовок", title.get("text", ""))
        self.assertGreaterEqual(table["inference"]["hline_count"], 8)
        self.assertGreaterEqual(len(table["inference"]["consumed_element_ids"]), 88)
        self.assertEqual(table["table"]["frame_source"], "background_shape")
        self.assertEqual(table["inference"]["frame_element_id"], "slide_pic_100")
        self.assertIn("padding_pt", table["table"])
        self.assertAlmostEqual(table["table"]["padding_pt"]["left"], 17.33, delta=0.5)
        self.assertAlmostEqual(table["table"]["padding_pt"]["top"], 17.33, delta=0.5)
        self.assertAlmostEqual(table["geometry_pt"]["width_pt"], 672.37, delta=0.5)
        self.assertAlmostEqual(table["geometry_pt"]["height_pt"], 251.67, delta=0.5)
        self.assertAlmostEqual(table["geometry_pt"]["x_pt"], 22.5, delta=0.5)
        self.assertAlmostEqual(table["geometry_pt"]["y_pt"], 94.51, delta=0.5)
        self.assertLess(table["table"]["layout_width_pt"], 672.0)
        self.assertLess(table["table"]["layout_height_pt"], 251.0)
        self.assertEqual(table["table"]["structure"]["row_sizing"]["mode"], "fit_content")
        self.assertIn("slide_pic_100", [element.get("element_id") for element in slide["content_elements"]])
        self.assertEqual(slide["element_summary"].get("image"), 1)

    def test_extra_fill_shape_blocks_inference(self):
        slide = {
            "slide_number": 47,
            "content_elements": [
                _text_element("h1", x=120, y=112, width=54, height=13, text="Metric", z_index=2),
                _text_element("h2", x=203, y=112, width=54, height=13, text="Metric", z_index=3),
                _text_element("h3", x=287, y=112, width=54, height=13, text="Metric", z_index=4),
                _text_element("d1", x=120, y=134, width=24, height=13, text=">50*", z_index=5),
                _text_element("d2", x=203, y=134, width=24, height=13, text=">50*", z_index=6),
                _text_element("d3", x=287, y=134, width=24, height=13, text=">50*", z_index=7),
                _text_element("d4", x=120, y=156, width=24, height=13, text=">50*", z_index=8),
                _text_element("d5", x=203, y=156, width=24, height=13, text=">50*", z_index=9),
                _text_element("d6", x=287, y=156, width=24, height=13, text=">50*", z_index=10),
                {
                    "element_id": "icon",
                    "kind": "fill",
                    "source_scope": "slide",
                    "z_index": 1,
                    "geometry_pt": {"x_pt": 120.0, "y_pt": 110.0, "width_pt": 10.0, "height_pt": 10.0},
                    "geometry_norm": {"x": 0.1, "y": 0.1, "width": 0.01, "height": 0.01},
                },
            ],
        }

        self.assertFalse(infer_layout_table_on_slide(slide, 720.0, 405.0))

    def test_slide_47_card_layout_is_not_inferred(self):
        report_path = Path("output/fa721249ff0b/report.json")
        if not report_path.exists():
            self.skipTest("report missing")

        report = json.loads(report_path.read_text())
        slide = copy.deepcopy(next(item for item in report["slides"]["slides"] if item["slide_number"] == 47))
        slide_size = (
            report["typography"]["visibility"]["slide_size_pt"]["width"],
            report["typography"]["visibility"]["slide_size_pt"]["height"],
        )

        self.assertFalse(infer_layout_table_on_slide(slide, *slide_size))
        self.assertNotIn("inferred_table", slide)
        self.assertFalse(any(element.get("kind") == "table" for element in slide["content_elements"]))

    def test_slide_33_kpi_panel_outside_table_region_is_inferred(self):
        report_path = Path("output/fa721249ff0b/report.json")
        if not report_path.exists():
            self.skipTest("report missing")

        report = json.loads(report_path.read_text())
        slides = copy.deepcopy(report["slides"])
        slide_size = (
            report["typography"]["visibility"]["slide_size_pt"]["width"],
            report["typography"]["visibility"]["slide_size_pt"]["height"],
        )
        apply_layout_table_inference(slides, slide_size)

        slide = next(item for item in slides["slides"] if item["slide_number"] == 33)
        self.assertIn("inferred_table", slide)
        table = next(element for element in slide["content_elements"] if element["kind"] == "table")
        self.assertEqual(table["rows"], 10)
        self.assertEqual(table["cols"], 3)
        self.assertEqual(table["inference"]["filled_cells"], 30)
        self.assertEqual(table["inference"]["typography_size_pt"], 8.12)
        self.assertEqual(table["table"]["frame_source"], "background_shape")
        self.assertIn("slide_pic_100", [element.get("element_id") for element in slide["content_elements"]])
        kpi = next(element for element in slide["content_elements"] if element.get("element_id") == "slide_text_142")
        self.assertEqual(kpi.get("text"), "91%")
        self.assertEqual(slide["element_summary"].get("text"), 3)


if __name__ == "__main__":
    unittest.main()
