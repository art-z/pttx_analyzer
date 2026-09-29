import json
import unittest
from pathlib import Path

from app.pptx import PPTXPackage
from app.template_layers import build_template_render


class TemplateLayersTest(unittest.TestCase):
    @staticmethod
    def _load_fixture(job_id: str):
        root = Path(f"output/{job_id}")
        source = root / "source.pptx"
        if not source.is_file() or not (root / "report.json").is_file():
            raise unittest.SkipTest(f"{job_id} fixture missing")
        return PPTXPackage(source), json.loads((root / "report.json").read_text())["theme"]

    def test_layout_quote_mark_renders_as_text_layer(self):
        package, theme = self._load_fixture("ecc13787b480")
        render = build_template_render(
            package,
            "ppt/slideLayouts/slideLayout11.xml",
            "ppt/slideMasters/slideMaster1.xml",
            (960.0, 540.0),
            theme,
        )
        text_layers = [layer for layer in render["layers"] if layer.get("kind") == "text"]
        self.assertEqual(len(text_layers), 1)
        self.assertEqual(text_layers[0]["text"], "«")
        self.assertEqual(text_layers[0]["source_scope"], "layout")
        self.assertEqual(text_layers[0]["typography"]["size_pt"], 288.0)
        self.assertEqual(text_layers[0]["typography"]["color"], "#0077FF")
        self.assertTrue(text_layers[0].get("decorative"))

    def test_empty_layout_placeholders_stay_skipped(self):
        package, theme = self._load_fixture("ecc13787b480")
        render = build_template_render(
            package,
            "ppt/slideLayouts/slideLayout11.xml",
            "ppt/slideMasters/slideMaster1.xml",
            (960.0, 540.0),
            theme,
        )
        names = {layer.get("name") for layer in render["layers"]}
        self.assertNotIn("Google Shape;102;p12", names)
        self.assertNotIn("Google Shape;103;p12", names)
        self.assertNotIn("Google Shape;104;p12", names)

    def test_title_layout_renders_black_overlay_plaques(self):
        package, theme = self._load_fixture("db940ddcba3b")
        render = build_template_render(
            package,
            "ppt/slideLayouts/slideLayout14.xml",
            "ppt/slideMasters/slideMaster1.xml",
            (960.0, 540.0),
            theme,
        )
        overlays = [
            layer
            for layer in render["layers"]
            if layer.get("kind") == "fill"
            and layer.get("source_scope") == "layout"
            and (layer.get("fill") or {}).get("color") == "#000000"
        ]
        self.assertEqual(len(overlays), 2)
        names = {layer.get("name") for layer in overlays}
        self.assertEqual(names, {"Google Shape;328;p15", "Google Shape;329;p15"})
        for layer in overlays:
            self.assertTrue(layer.get("decorative"))
        bg_image_index = next(
            index
            for index, layer in enumerate(render["layers"])
            if layer.get("name") == "Google Shape;327;p15"
        )
        overlay_indices = [
            index
            for index, layer in enumerate(render["layers"])
            if layer.get("name") in names
        ]
        self.assertTrue(all(index > bg_image_index for index in overlay_indices))


if __name__ == "__main__":
    unittest.main()
