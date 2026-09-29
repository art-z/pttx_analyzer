import json
import unittest
from pathlib import Path

from app.diagram_region_inference import (
    apply_diagram_region_inference,
    apply_flow_diagram_styles_to_baselines,
    infer_diagram_region_on_slide,
)
from app.graphic_baselines import enrich_graphic_components_with_baselines


REPORT_PATH = Path(__file__).resolve().parents[1] / "output" / "4bbeea9db0ad" / "report.json"


class DiagramRegionInferenceTest(unittest.TestCase):
    slide_width = 960.0
    slide_height = 540.0

    def _slide_13(self) -> dict:
        if not REPORT_PATH.exists():
            self.skipTest("sample report missing")
        report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
        slide = next(item for item in report["slides"]["slides"] if item["slide_number"] == 13)
        return json.loads(json.dumps(slide))

    def test_slide_13_shape_flow_is_detected(self):
        slide = self._slide_13()
        result = infer_diagram_region_on_slide(slide, self.slide_width, self.slide_height)
        self.assertIsNotNone(result)
        self.assertEqual(result["diagram_type_guess"], "flow")
        self.assertGreaterEqual(result["confidence"], 0.62)
        self.assertGreaterEqual(len(result["consumed_element_ids"]), 20)
        self.assertNotIn("slide13_slide_text_100", result["consumed_element_ids"])
        self.assertGreaterEqual(result["signals"]["arrow_line_count"], 3)
        self.assertGreaterEqual(result["signals"]["node_box_count"], 2)

    def test_flow_styles_enrich_baseline(self):
        slide = self._slide_13()
        result = infer_diagram_region_on_slide(slide, self.slide_width, self.slide_height)
        self.assertIsNotNone(result)
        slide["inferred_diagram"] = result

        catalog = enrich_graphic_components_with_baselines({"tables": [], "charts": [], "diagrams": []}, {"slides": [slide]})
        flow = next(item for item in catalog["diagrams"] if item.get("component_id") == "dgm_baseline_flow")
        self.assertTrue(flow.get("is_baseline"))
        self.assertIn("connector", flow.get("style_tokens") or {})
        self.assertTrue(flow.get("deck_style_source"))

    def test_synthetic_flow_diagram_excludes_repeat_like_content(self):
        slide = {
            "slide_number": 1,
            "content_elements": [
                {
                    "element_id": "title",
                    "kind": "text",
                    "text": "Оформление схем",
                    "geometry_norm": {"x": 0.05, "y": 0.08, "width": 0.9, "height": 0.1},
                    "typography": {"size_pt": 36},
                },
                {
                    "element_id": "box1",
                    "kind": "fill",
                    "fill": {"kind": "solid", "color": "#EBF3F9"},
                    "geometry_norm": {"x": 0.1, "y": 0.3, "width": 0.15, "height": 0.12},
                },
                {
                    "element_id": "box1t",
                    "kind": "text",
                    "text": "Шаг 1",
                    "geometry_norm": {"x": 0.11, "y": 0.33, "width": 0.13, "height": 0.05},
                    "typography": {"size_pt": 16},
                },
                {
                    "element_id": "box2",
                    "kind": "fill",
                    "fill": {"kind": "solid", "color": "#EBF3F9"},
                    "geometry_norm": {"x": 0.35, "y": 0.3, "width": 0.15, "height": 0.12},
                },
                {
                    "element_id": "box2t",
                    "kind": "text",
                    "text": "Шаг 2",
                    "geometry_norm": {"x": 0.36, "y": 0.33, "width": 0.13, "height": 0.05},
                    "typography": {"size_pt": 16},
                },
                {
                    "element_id": "arrow1",
                    "kind": "line",
                    "geometry_norm": {"x": 0.25, "y": 0.35, "width": 0.1, "height": 0.002},
                    "stroke": {
                        "width_pt": 1,
                        "color": {"color": "#0077FF"},
                        "tail": {"type": "triangle"},
                    },
                    "line": {"preset": "straightConnector1"},
                },
                {
                    "element_id": "arrow2",
                    "kind": "line",
                    "geometry_norm": {"x": 0.5, "y": 0.35, "width": 0.1, "height": 0.002},
                    "stroke": {
                        "width_pt": 1,
                        "color": {"color": "#0077FF"},
                        "tail": {"type": "triangle"},
                    },
                    "line": {"preset": "straightConnector1"},
                },
                {
                    "element_id": "arrow3",
                    "kind": "line",
                    "geometry_norm": {"x": 0.25, "y": 0.5, "width": 0.002, "height": 0.1},
                    "stroke": {
                        "width_pt": 1,
                        "color": {"color": "#0077FF"},
                        "head": {"type": "triangle"},
                    },
                    "line": {"preset": "straightConnector1"},
                },
            ],
        }
        slides = {"slides": [slide]}
        apply_diagram_region_inference(slides, (self.slide_width, self.slide_height))
        self.assertIn("inferred_diagram", slide)
        consumed = set(slide["inferred_diagram"]["consumed_element_ids"])
        self.assertNotIn("title", consumed)
        self.assertIn("box1", consumed)
        self.assertIn("arrow1", consumed)
        style = slide["inferred_diagram"]["style_tokens"]
        self.assertEqual(style["connector"]["color"]["color"], "#0077FF")
        self.assertEqual(style["connector"]["width_pt"], 1)
        self.assertEqual(style["arrow"]["head_type"], "none")
        self.assertEqual(style["arrow"]["tail_type"], "triangle")
        self.assertFalse(style["arrow"]["bidirectional"])
        self.assertEqual(style["node"]["fill"]["color"], "#EBF3F9")
        self.assertEqual(style["node"]["typography"]["size_pt"], 16)

        catalog = enrich_graphic_components_with_baselines(
            {"tables": [], "charts": [], "diagrams": []},
            slides,
        )
        baselines = {
            item["diagram_type"]: item
            for item in catalog["diagrams"]
            if item.get("is_baseline")
        }
        for diagram_type in ("flow", "process"):
            self.assertEqual(
                baselines[diagram_type]["style_tokens"]["connector"]["color"]["color"],
                "#0077FF",
            )
            self.assertTrue(baselines[diagram_type].get("deck_style_source"))


if __name__ == "__main__":
    unittest.main()
