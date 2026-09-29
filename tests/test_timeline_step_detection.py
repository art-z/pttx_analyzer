import json
import unittest
from pathlib import Path

from app.catalog_component_detection import detect_catalog_components
from app.slide_patterns import _content_elements_for_clustering, _blocks_on_slide, _icon_files, _slide_size_pt


class TimelineStepDetectionTests(unittest.TestCase):
    def setUp(self):
        report_path = Path("output/1f616f1dd0f4/report.json")
        if not report_path.exists():
            self.skipTest("1f616f1dd0f4 sample report missing")
        self.report = json.loads(report_path.read_text(encoding="utf-8"))

    def test_slide_42_blue_markers_become_timeline_step(self):
        slide42 = next(slide for slide in self.report["slides"]["slides"] if slide["slide_number"] == 42)
        elements = _content_elements_for_clustering(slide42["content_elements"], _icon_files(self.report["assets"]))
        fills = [element for element in elements if element["kind"] == "fill"]
        self.assertGreaterEqual(len(fills), 7)

        blocks = _blocks_on_slide(elements, _slide_size_pt(slide42))
        marker_blocks = [block for block in blocks if block["kind_counts"].get("fill")]
        self.assertGreaterEqual(len(marker_blocks), 7)

        result = detect_catalog_components(
            self.report["slides"],
            self.report["assets"],
            self.report["typography"]["scale_usage"]["text_blocks"],
        )
        timeline = [
            component
            for component in result["components"]
            if component.get("name") == "TIMELINE_STEP"
            and 42 in (component.get("frequency") or {}).get("slide_numbers", [])
        ]
        self.assertTrue(timeline, "expected TIMELINE_STEP on slide 42")
        component = timeline[0]
        slide_42_instances = [
            instance for instance in component["instances"] if instance["slide_number"] == 42
        ]
        self.assertGreaterEqual(len(slide_42_instances), 7)
        roles = {slot["role"] for slot in component["slots"]["required"]}
        self.assertIn("marker", roles)
        kinds = {slot["kind"] for slot in component["slots"]["required"]}
        self.assertIn("fill", kinds)


if __name__ == "__main__":
    unittest.main()
