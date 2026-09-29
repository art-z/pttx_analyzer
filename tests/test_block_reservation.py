import json
import unittest
from pathlib import Path

from app.catalog_component_detection import detect_catalog_components
from app.slide_patterns import (
    _blocks_on_slide,
    _content_elements_for_clustering,
    _icon_files,
    _slide_size_pt,
)


class BlockReservationTests(unittest.TestCase):
    def setUp(self):
        report_path = Path("output/f371b6c2a0b0/report.json")
        if not report_path.exists():
            self.skipTest("sample deck report missing")
        self.report = json.loads(report_path.read_text(encoding="utf-8"))
        self.slides = self.report["slides"]["slides"]
        self.assets = self.report.get("assets")

    def _blocks_for_slide(self, slide_number: int) -> list[dict]:
        slide = next(item for item in self.slides if item["slide_number"] == slide_number)
        elements = _content_elements_for_clustering(slide.get("content_elements") or [], _icon_files(self.assets))
        return _blocks_on_slide(elements, _slide_size_pt(slide))

    def test_each_element_belongs_to_at_most_one_block(self):
        for slide in self.slides:
            blocks = self._blocks_for_slide(slide["slide_number"])
            seen: set[str] = set()
            for block in blocks:
                for element in block.get("elements") or []:
                    element_id = element.get("element_id")
                    if not element_id:
                        continue
                    self.assertNotIn(
                        element_id,
                        seen,
                        f"slide {slide['slide_number']} reuses element {element_id}",
                    )
                    seen.add(element_id)

    def test_slide_8_has_six_fill_cards(self):
        blocks = self._blocks_for_slide(8)
        card_blocks = [
            block for block in blocks
            if block["kind_counts"].get("fill") and block["kind_counts"].get("text")
        ]
        self.assertEqual(len(card_blocks), 6)
        heights = {round(block["bbox_pt"]["height_pt"]) for block in card_blocks}
        self.assertEqual(heights, {170})

    def test_slide_20_blocks_are_atomic_media_cards(self):
        blocks = self._blocks_for_slide(20)
        self.assertEqual(len(blocks), 8)
        widths = {round(block["bbox_pt"]["width_pt"]) for block in blocks}
        heights = {round(block["bbox_pt"]["height_pt"]) for block in blocks}
        self.assertEqual(widths, {212})
        self.assertEqual(heights, {166})

    def test_catalog_instances_do_not_share_shape_ids_on_slide(self):
        result = detect_catalog_components(
            self.report["slides"],
            self.assets,
            self.report["typography"]["scale_usage"]["text_blocks"],
        )
        for slide_number in {20, 21, 42}:
            seen: set[str] = set()
            slide_instances = [
                instance
                for component in result["components"]
                for instance in component.get("instances", [])
                if instance.get("slide_number") == slide_number
            ]
            for instance in slide_instances:
                for slot in instance.get("slots") or []:
                    shape_id = slot.get("shape_id")
                    if not shape_id:
                        continue
                    self.assertNotIn(
                        shape_id,
                        seen,
                        f"slide {slide_number} catalog instance reuses shape {shape_id}",
                    )
                    seen.add(shape_id)


if __name__ == "__main__":
    unittest.main()
