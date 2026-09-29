import io
import json
import zipfile

import pytest
from fastapi import HTTPException

from app.web import (
    GenerateBriefRequest,
    GeneratedPresentationExportRequest,
    _parse_form_bool,
    export_generated_pptx,
    generate_job_presentation,
)


def test_parse_form_bool():
    assert _parse_form_bool(None) is False
    assert _parse_form_bool("false") is False
    assert _parse_form_bool("true") is True
    assert _parse_form_bool("on") is True
    assert _parse_form_bool("1") is True


def test_export_generated_pptx_uses_selected_slide_order(tmp_path, monkeypatch):
    job_dir = tmp_path / "job123"
    job_dir.mkdir()
    (job_dir / "assets").mkdir()
    (job_dir / "report.json").write_text(json.dumps({
        "typography": {"visibility": {"slide_size_pt": {"width": 960, "height": 540}}},
        "slides": {"slides": []},
    }), encoding="utf-8")
    monkeypatch.setattr("app.web.OUTPUT_ROOT", tmp_path)

    payload = GeneratedPresentationExportRequest(
        title="Тест",
        slides=[{
            "slide_number": 99,
            "render": {"slide_size_pt": {"width": 960, "height": 540}},
            "content_elements": [{
                "kind": "text",
                "text": "Selected variant",
                "geometry_pt": {"x_pt": 50, "y_pt": 50, "width_pt": 400, "height_pt": 60},
                "typography": {"size_pt": 24},
            }],
        }],
    )
    response = export_generated_pptx("job123", payload)

    assert response.media_type.endswith("presentationml.presentation")
    with zipfile.ZipFile(io.BytesIO(response.body)) as archive:
        assert "ppt/slides/slide1.xml" in archive.namelist()
    saved = json.loads((job_dir / "generated-selection.json").read_text(encoding="utf-8"))
    assert saved["slides"][0]["slide_number"] == 1


def test_generate_job_presentation_uses_existing_analysis(tmp_path, monkeypatch):
    job_dir = tmp_path / "job123"
    job_dir.mkdir()
    (job_dir / "report.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr("app.web.OUTPUT_ROOT", tmp_path)

    def fake_generate(brief, usage_tracker, report):
        from app.llm_usage import LLMUsageRecord
        usage_tracker.add(LLMUsageRecord(input_tokens=10, output_tokens=4, total_tokens=14, operation="create_presentation"))
        assert brief == "Короткий бриф"
        assert report == {}
        return {"presentation": {"title": "Flow", "slides": []}, "contract": {"valid": True}, "raw_text": "{}"}

    monkeypatch.setattr("app.web.generate_presentation_from_brief", fake_generate)
    payload = generate_job_presentation("job123", GenerateBriefRequest(brief="  Короткий бриф  "))

    assert payload["presentation"]["presentation"]["title"] == "Flow"
    assert payload["llm_usage"]["total_tokens"] == 14
    assert (job_dir / "brief.txt").read_text(encoding="utf-8") == "Короткий бриф"
    assert json.loads((job_dir / "presentation.json").read_text(encoding="utf-8"))["presentation"]["title"] == "Flow"


def test_generate_job_presentation_reuses_first_model_response(tmp_path, monkeypatch):
    job_dir = tmp_path / "job123"
    job_dir.mkdir()
    (job_dir / "report.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr("app.web.OUTPUT_ROOT", tmp_path)
    calls = 0

    def fake_generate(_brief, _usage_tracker, _report):
        nonlocal calls
        calls += 1
        return {"presentation": {"title": "Flow", "slides": []}, "contract": {"valid": True}, "raw_text": "{}"}

    monkeypatch.setattr("app.web.generate_presentation_from_brief", fake_generate)
    request = GenerateBriefRequest(brief="Бриф")
    first = generate_job_presentation("job123", request)
    second = generate_job_presentation("job123", request)

    assert calls == 1
    assert second["cached"] is True
    assert second["presentation"] == first["presentation"]


def test_generate_job_presentation_requires_brief_and_job(tmp_path, monkeypatch):
    monkeypatch.setattr("app.web.OUTPUT_ROOT", tmp_path)
    with pytest.raises(HTTPException) as missing_job:
        generate_job_presentation("missing", GenerateBriefRequest(brief="Бриф"))
    assert missing_job.value.status_code == 404

    job_dir = tmp_path / "job123"
    job_dir.mkdir()
    (job_dir / "report.json").write_text("{}", encoding="utf-8")
    with pytest.raises(HTTPException) as empty_brief:
        generate_job_presentation("job123", GenerateBriefRequest(brief="  "))
    assert empty_brief.value.status_code == 400
