from app.graphic_style_materialization import materialize_graphic_styles


def test_materializes_report_design_system_colors_for_all_graphics():
    report = {
        "colors": {
            "context_palettes": {
                "text": [{"color": "#223344"}],
                "fill": [{"color": "#C04080"}],
                "stroke": [{"color": "#0088CC"}],
            },
            "resolved_palette": [],
        },
        "graphic_components": {
            "chart_series_palette": {
                "colors": ["#C04080", "#0088CC", "#55AA44"],
            },
        },
    }
    slide = {
        "content_elements": [
            {
                "kind": "chart",
                "chart": {
                    "style_tokens": {
                        "series_palette": [{"color": "#FF0000"}],
                    },
                },
            },
            {
                "kind": "diagram",
                "is_baseline": True,
                "diagram": {
                    "style_tokens": {
                        "connector": {"width_pt": 1},
                        "node": {"typography": None, "border": None},
                    },
                },
            },
            {
                "kind": "table",
                "table": {"style_tokens": {}},
            },
        ],
    }

    styled = materialize_graphic_styles(report, slide)
    chart_style = styled["content_elements"][0]["chart"]["style_tokens"]
    diagram_style = styled["content_elements"][1]["diagram"]["style_tokens"]
    table_style = styled["content_elements"][2]["table"]["style_tokens"]

    assert [item["color"] for item in chart_style["series_palette"][:3]] == [
        "#C04080", "#0088CC", "#55AA44",
    ]
    assert chart_style["category_axis"]["typography"]["color"] == "#223344"
    assert diagram_style["connector"]["color"]["color"] == "#C04080"
    assert diagram_style["node"]["border"]["color"]["color"] == "#C04080"
    assert diagram_style["node"]["typography"]["color"] == "#223344"
    assert table_style["header_cell"]["typography"]["color"] == "#223344"
    assert table_style["body_cell"]["typography"]["color"] == "#223344"

    # Input payload stays immutable so repeated exports do not accumulate styles.
    assert slide["content_elements"][0]["chart"]["style_tokens"]["series_palette"] == [
        {"color": "#FF0000"},
    ]
