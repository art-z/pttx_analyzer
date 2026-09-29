import json
import unittest
from pathlib import Path

from app.narrative_components import (
    apply_narrative_component_inference,
    is_decorative_quote_text,
    text_has_inline_quotes,
)


def _text(element_id, text, *, size=18, family="Play", placeholder="body", geometry=None, runs=None, group_id=None):
    geometry = geometry or {"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.2}
    element = {
        "element_id": element_id,
        "kind": "text",
        "text": text,
        "placeholder_type": placeholder,
        "typography": {"family": family, "size_pt": size, "color": "#111111"},
        "geometry_norm": geometry,
        "geometry_pt": {
            "x_pt": geometry["x"] * 960,
            "y_pt": geometry["y"] * 540,
            "width_pt": geometry["width"] * 960,
            "height_pt": geometry["height"] * 540,
        },
    }
    if group_id:
        element["text_group_id"] = group_id
    if runs:
        element["text_runs"] = runs
    return element


def _run(slides, templates, shells=None):
    result = apply_narrative_component_inference(
        {"slides": slides, "summary": {}},
        {"templates": templates},
        shells,
    )
    return result, templates


class NarrativeComponentTests(unittest.TestCase):
    def test_pagination_glyph_is_not_a_decorative_quote(self):
        self.assertFalse(is_decorative_quote_text("‹#›"))
        self.assertTrue(is_decorative_quote_text("«"))
        self.assertTrue(text_has_inline_quotes("Он сказал «готово» и закрыл тему разговора целиком."))
        self.assertFalse(text_has_inline_quotes("font-family: ‘Mail Sans’, sans-serif; padding: 0;"))

    def test_template_quote_mark_builds_quote_component_and_marks_template(self):
        body = _text(
            "body",
            "VK активно развивается и стремится стать центром технологической экспертизы.",
            size=40,
            geometry={"x": 0.28, "y": 0.08, "width": 0.62, "height": 0.66},
            group_id="quote-body",
        )
        support = _text(
            "support",
            "Уверен, что опыт коллег поможет в достижении этой амбициозной цели.",
            size=20,
            geometry={"x": 0.28, "y": 0.08, "width": 0.62, "height": 0.66},
            group_id="quote-body",
        )
        author = _text(
            "author",
            "Владимир Кириенко, генеральный директор VK",
            size=24,
            geometry={"x": 0.28, "y": 0.84, "width": 0.67, "height": 0.07},
        )
        templates = [{
            "template_id": "tmpl_003",
            "layout_source": "ppt/slideLayouts/slideLayout11.xml",
            "render": {"layers": [{
                "kind": "text",
                "text": "«",
                "typography": {"family": "Play", "size_pt": 288, "bold": True, "color": "#0077FF"},
                "geometry_norm": {"x": 0.04, "y": -0.15, "width": 0.17, "height": 0.65},
            }]},
        }]
        shells = [{"template_id": "tmpl_003", "profile": templates[0]}]
        result, templates = _run(
            [{
                "slide_number": 19,
                "template_id": "tmpl_003",
                "content_elements": [body, support, author],
            }],
            templates,
            shells,
        )

        self.assertEqual(len(result["quotes"]), 1)
        quote = result["quotes"][0]
        self.assertTrue(quote["is_baseline"])
        self.assertEqual(quote["style_tokens"]["mark"]["text"], "«")
        self.assertEqual(quote["style_tokens"]["mark"]["size_pt"], 288)
        self.assertEqual(quote["style_tokens"]["body"]["size_pt"], 40)
        self.assertIn("Кириенко", quote["instances"][0]["attribution_text"])
        self.assertEqual(body["narrative_role"], "quote_body")
        self.assertEqual(author["narrative_role"], "quote_attribution")
        self.assertEqual(templates[0]["detected_roles"], ["quote"])
        self.assertEqual(shells[0]["detected_roles"], ["quote"])
        self.assertEqual(result["snippets"], [])

    def test_inline_quotes_in_long_text_mark_component_and_template(self):
        paragraph = _text(
            "paragraph",
            "Команда услышала «мы успеем к релизу» и перестроила план на ближайший квартал целиком.",
            size=18,
        )
        result, templates = _run(
            [{"slide_number": 4, "template_id": "tmpl_010", "content_elements": [paragraph]}],
            [{"template_id": "tmpl_010", "render": {"layers": []}}],
        )
        self.assertEqual(len(result["quotes"]), 1)
        self.assertEqual(result["quotes"][0]["instances"][0]["detection_methods"], ["inline_quote_text"])
        self.assertEqual(templates[0]["detected_roles"], ["quote"])

    def test_short_quoted_title_and_pagination_are_not_quotes(self):
        result, templates = _run(
            [{
                "slide_number": 2,
                "template_id": "tmpl_001",
                "content_elements": [
                    _text("title", "«Старт»", size=32, placeholder="title"),
                    _text("page", "‹#›", size=12, placeholder="sldNum", geometry={"x": 0.9, "y": 0.94, "width": 0.06, "height": 0.04}),
                ],
                "render": {"layers": [{
                    "kind": "text",
                    "source_scope": "master",
                    "text": "‹#›",
                    "typography": {"family": "Arial", "size_pt": 12},
                }]},
            }],
            [{"template_id": "tmpl_001", "render": {"layers": [{
                "kind": "text",
                "text": "‹#›",
                "typography": {"family": "Arial", "size_pt": 12},
            }]}}],
        )
        self.assertEqual(result["quotes"], [])
        self.assertNotIn("detected_roles", templates[0])

    def test_tiny_content_quote_glyph_without_long_text_is_not_a_component(self):
        result, templates = _run(
            [{
                "slide_number": 3,
                "template_id": "tmpl_002",
                "content_elements": [
                    _text("mark", "«", size=12, geometry={"x": 0.02, "y": 0.9, "width": 0.03, "height": 0.03}),
                ],
            }],
            [{"template_id": "tmpl_002", "render": {"layers": []}}],
        )
        self.assertEqual(result["quotes"], [])

    def test_colored_prose_is_not_a_snippet(self):
        prose = (
            "Этот абзац объясняет подход команды и не содержит программного кода, "
            "даже если отдельные слова выделены цветом."
        )
        element = _text("prose", prose, size=16, family="Play", runs=[
            {"text": "Этот абзац объясняет ", "color": "#111111"},
            {"text": "подход", "color": "#0077FF"},
            {"text": " команды и не содержит программного кода, даже если отдельные слова выделены цветом.", "color": "#E23B3B"},
        ])
        result, templates = _run(
            [{"slide_number": 8, "template_id": "tmpl_008", "content_elements": [element]}],
            [{"template_id": "tmpl_008", "render": {"layers": []}}],
        )
        self.assertEqual(result["snippets"], [])
        self.assertNotIn("detected_roles", templates[0])

    def test_monospace_text_with_one_color_is_not_a_snippet(self):
        code = "body {\npadding: 0;\nmargin: 0;\nheight: 100vh;\n}\n"
        element = _text("code", code, size=16, family="Consolas", runs=[
            {"text": code, "color": "#FFFFFF"},
        ])
        result, templates = _run(
            [{"slide_number": 9, "template_id": "tmpl_009", "content_elements": [element]}],
            [{"template_id": "tmpl_009", "render": {"layers": []}}],
        )
        self.assertEqual(result["snippets"], [])

    def test_multicolor_code_is_snippet_not_quote_and_largest_size_is_baseline(self):
        css = (
            "body {\n"
            "padding: 0;\n"
            "margin: 0;\n"
            "height: 100vh;\n"
            "font-family: ‘Mail Sans’, sans-serif;\n"
            "}\n"
        )
        runs = [
            {"text": "body", "color": "#FFE59C"},
            {"text": " {\n", "color": "#FFFFFF"},
            {"text": "padding", "color": "#C3A3E2"},
            {"text": ": 0;\n", "color": "#A0DFE0"},
            {"text": "margin: 0;\nheight: 100vh;\nfont-family: ‘Mail Sans’, sans-serif;\n}", "color": "#FFBD92"},
        ]
        small = _text("code-small", css, size=12, family="Consolas", runs=runs)
        large = _text("code-large", css, size=16, family="Consolas", runs=runs)
        result, templates = _run(
            [
                {"slide_number": 32, "template_id": "tmpl_030", "content_elements": [small]},
                {"slide_number": 15, "template_id": "tmpl_030", "content_elements": [large]},
            ],
            [{"template_id": "tmpl_030", "render": {"layers": []}}],
        )

        self.assertEqual(result["quotes"], [])
        self.assertEqual(len(result["snippets"]), 1)
        snippet = result["snippets"][0]
        self.assertTrue(snippet["is_baseline"])
        self.assertEqual(snippet["style_tokens"]["typography"]["size_pt"], 16)
        self.assertEqual(snippet["style_tokens"]["color_count"], 5)
        self.assertEqual(
            [item["size_pt"] for item in snippet["style_tokens"]["size_profiles"]],
            [16, 12],
        )
        self.assertEqual(templates[0]["detected_roles"], ["snippet"])
        self.assertEqual(large["narrative_role"], "snippet")

    def test_real_deck_finds_quote_template_and_code_snippet(self):
        path = Path("output/f7fc4cd16f55/report.json")
        if not path.is_file():
            self.skipTest("fixture report missing")
        report = json.loads(path.read_text())
        result = apply_narrative_component_inference(report["slides"], report["slide_templates"])

        quote_slides = [
            slide
            for component in result["quotes"]
            for slide in component["frequency"]["slide_numbers"]
        ]
        snippet_slides = [
            slide
            for component in result["snippets"]
            for slide in component["frequency"]["slide_numbers"]
        ]
        self.assertIn(19, quote_slides)
        self.assertNotIn(15, quote_slides)
        self.assertIn(15, snippet_slides)

        quote_template = next(item for item in report["slide_templates"]["templates"] if item["template_id"] == "tmpl_003")
        code_template = next(item for item in report["slide_templates"]["templates"] if item["template_id"] == "tmpl_030")
        self.assertIn("quote", quote_template["detected_roles"])
        self.assertIn("snippet", code_template["detected_roles"])
        quote = next(item for item in result["quotes"] if 19 in item["frequency"]["slide_numbers"])
        self.assertIn("Кириенко", quote["instances"][0]["attribution_text"])
        self.assertEqual(quote["style_tokens"]["mark"]["text"], "«")


if __name__ == "__main__":
    unittest.main()
