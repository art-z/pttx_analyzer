from app.terminal_slide_candidates import annotate_terminal_slide_candidates


def _text(element_id, text, placeholder=None, size=30, y=0.1):
    return {
        "element_id": element_id,
        "kind": "text",
        "text": text,
        "placeholder_type": placeholder,
        "typography": {"size_pt": size},
        "geometry_norm": {"x": 0.1, "y": y, "width": 0.7, "height": 0.1},
    }


def _slide(number, elements, template_id=None, components=None, decorations=0):
    return {
        "slide_number": number,
        "template_id": template_id or f"tmpl_{number}",
        "layout_source": f"layout_{number}",
        "content_elements": elements,
        "component_instances": components or [],
        "render": {
            "layers": [
                {
                    "kind": "image",
                    "decorative": True,
                    "source_scope": "layout",
                }
                for _ in range(decorations)
            ],
        },
    }


def test_parser_marks_ranked_initial_and_final_candidates_and_templates():
    catalog = {
        "slides": [
            _slide(1, [
                _text("title-1", "Deck", "title", 44, 0.3),
                _text("speaker", "Name, role", "body", 16, 0.7),
            ], decorations=2),
            _slide(2, [_text("title-2", "Section", "title")]),
            _slide(3, [_text("body-only", "No title", "body", 14)]),
        ],
        "summary": {},
    }
    templates = {
        "templates": [
            {"template_id": f"tmpl_{number}", "layout_source": f"layout_{number}"}
            for number in range(1, 4)
        ],
    }

    result = annotate_terminal_slide_candidates(catalog, {}, templates)

    assert result["preferred"]["initial_slide_number"] == 1
    assert result["preferred"]["final_slide_number"] == 1
    assert result["summary"]["final_reuses_initial"] is True
    assert catalog["slides"][0]["terminal_candidate"]["preferred_initial"] is True
    assert catalog["slides"][2]["terminal_roles"] == []
    assert "initial" in templates["templates"][0]["terminal_roles"]
    assert templates["templates"][0]["preferred_terminal_roles"] == ["initial", "final"]


def test_distinct_sparse_person_last_slide_can_be_preferred_for_final():
    catalog = {
        "slides": [
            _slide(1, [
                _text("title-1", "Deck", "title", 44, 0.3),
                _text("subtitle", "A sufficiently short subtitle", "body", 16, 0.7),
                {"element_id": "shape", "kind": "fill", "geometry_norm": {"width": 0.2, "height": 0.2}},
            ]),
            _slide(2, [
                _text("title-2", "Thanks", "title", 40, 0.2),
            ], components=[{"name": "PERSON", "label": "Speaker"}], decorations=3),
        ],
        "summary": {},
    }

    result = annotate_terminal_slide_candidates(catalog)

    assert result["preferred"]["initial_slide_number"] == 1
    assert result["preferred"]["final_slide_number"] == 2
    assert "person_component" in result["final"][0]["reasons"]
    assert catalog["slides"][1]["terminal_candidate"]["preferred_final"] is True


def test_plain_text_body_without_title_is_never_a_candidate():
    catalog = {
        "slides": [
            _slide(1, [_text("body", "Long body text", "body", 14, 0.2)]),
        ],
        "summary": {},
    }

    result = annotate_terminal_slide_candidates(catalog)

    assert result["initial"] == []
    assert result["final"] == []
    assert catalog["slides"][0]["terminal_roles"] == []


def test_physical_first_blank_background_gets_measured_title_and_body_plan():
    blank = _slide(8, [
        _text("page", "1", "sldNum", 10, 0.94),
        {"element_id": "accent", "kind": "fill", "geometry_norm": {
            "x": .02, "y": .05, "width": .08, "height": .08,
        }},
    ], template_id="cover", decorations=2)
    blank["presentation_order"] = 1
    blank["render"]["slide_size_pt"] = {"width": 960, "height": 540}
    other = _slide(2, [_text("title", "Content", "title")])
    other["presentation_order"] = 2
    catalog = {"slides": [other, blank], "summary": {}}
    templates = {"templates": [], "summary": {"template_count": 0, "layout_count": 0, "editable_layouts": 0}}

    result = annotate_terminal_slide_candidates(catalog, {}, templates)

    assert result["preferred"]["initial_slide_number"] == 8
    plan = result["initial"][0]["text_plan"]
    assert plan["title_source"] == "inferred"
    assert plan["title"]["max_chars"] > 10
    assert plan["text"]["max_chars"] > 10
    assert plan["person_supported"] is False
    cover_template = next(item for item in templates["templates"] if item["layout_source"] == blank["layout_source"])
    assert cover_template["background_only"] is True
    assert cover_template["terminal_roles"] == ["initial", "final"]
    assert cover_template["terminal_text_plans"]["initial"]["title"]["max_chars"] == plan["title"]["max_chars"]


def test_inferred_description_avoids_foreground_art():
    blank = _slide(1, [{"element_id": "foreground", "kind": "image", "geometry_norm": {
        "x": .1, "y": .43, "width": .38, "height": .26,
    }}])
    blank["render"]["slide_size_pt"] = {"width": 960, "height": 540}
    result = annotate_terminal_slide_candidates({"slides": [blank]})
    plan = result["initial"][0]["text_plan"]
    assert plan["text"]["geometry_norm"]["x"] >= .35
