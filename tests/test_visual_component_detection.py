import json
import unittest
from pathlib import Path

from app.visual_component_detection import detect_visual_components


class VisualComponentDetectionTests(unittest.TestCase):
    def setUp(self):
        report_path = Path("output/f371b6c2a0b0/report.json")
        if not report_path.exists():
            self.skipTest("sample deck report missing")
        self.report = json.loads(report_path.read_text(encoding="utf-8"))

    def test_numbered_steps_on_slides_21_22_23(self):
        slides = {
            slide["slide_number"]: slide
            for slide in self.report["slides"]["slides"]
            if slide["slide_number"] in {21, 22, 23}
        }
        catalog = {"slides": list(slides.values())}
        result = detect_visual_components(catalog, self.report.get("assets"))

        numbered = [
            component
            for component in result["components"]
            if component.get("name") == "NUMBERED_STEP"
        ]
        self.assertTrue(numbered, "expected NUMBERED_STEP component")
        component = numbered[0]
        self.assertGreaterEqual(component["frequency"]["instance_count"], 17)
        self.assertEqual(
            sorted(component["frequency"]["slide_numbers"]),
            [21, 22, 23],
        )
        self.assertGreaterEqual(len(component.get("variants") or []), 2)

    def test_atoms_ignore_title_zone(self):
        catalog = {
            "slides": [
                slide
                for slide in self.report["slides"]["slides"]
                if slide["slide_number"] == 21
            ],
        }
        result = detect_visual_components(catalog, self.report.get("assets"))
        numbered = next(
            (item for item in result["components"] if item.get("name") == "NUMBERED_STEP"),
            None,
        )
        self.assertIsNotNone(numbered)
        self.assertEqual(numbered["frequency"]["instance_count"], 4)


if __name__ == "__main__":
    unittest.main()
