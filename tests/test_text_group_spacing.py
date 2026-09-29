"""Tests for text group inter-line spacing derived from OOXML lnSpc."""

from app.text_group_spacing import compute_text_group_spacing_pt


def test_tight_spc_pct_metric_stack():
    segments = [
        {
            "typography": {"size_pt": 44},
            "line_spacing_ratio": 0.6,
            "line_spacing_unit": "ratio",
            "line_height_applicable": False,
        },
        {"typography": {"size_pt": 20}},
    ]
    spacing = compute_text_group_spacing_pt(segments)
    assert spacing is not None
    assert spacing["line_step_pt"] == 26.4
    assert spacing["line_gap_pt"] == 0.0
    assert spacing["render_line_height_ratio"] == 0.6
    assert spacing["line_height_applicable"] is False
    assert spacing["flex_stack_layout"] == "compact_display"


def test_spc_pts_with_applicable_line_height():
    segments = [
        {
            "typography": {"size_pt": 18},
            "line_spacing_ratio": 1.2,
            "line_spacing_unit": "pt",
            "line_height_pt": 20.0,
            "line_height_applicable": True,
        },
        {"typography": {"size_pt": 18}},
    ]
    spacing = compute_text_group_spacing_pt(segments)
    assert spacing is not None
    assert spacing["line_step_pt"] == 20.0
    assert spacing["line_gap_pt"] == 0.0
    assert "render_line_height_ratio" not in spacing


def test_ratio_step_exceeds_line_height_box():
    segments = [
        {
            "typography": {"size_pt": 18},
            "line_spacing_ratio": 1.5,
            "line_spacing_unit": "ratio",
            "line_height_pt": 20.0,
            "line_height_applicable": True,
        },
        {"typography": {"size_pt": 18}},
    ]
    spacing = compute_text_group_spacing_pt(segments)
    assert spacing is not None
    assert spacing["line_step_pt"] == 27.0
    assert spacing["line_gap_pt"] == 7.0


def test_single_segment_returns_none():
    assert compute_text_group_spacing_pt([{"typography": {"size_pt": 12}}]) is None
