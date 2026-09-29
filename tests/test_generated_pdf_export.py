import json
import shutil
import subprocess

import pytest

from app import web


@pytest.mark.skipif(not shutil.which("soffice"), reason="LibreOffice is not installed")
def test_generated_pdf_uses_native_slide_scene(tmp_path, monkeypatch):
    job = tmp_path / "job"
    job.mkdir()
    (job / "report.json").write_text(json.dumps({"slides": {"slides": []}}), encoding="utf-8")
    monkeypatch.setattr(web, "OUTPUT_ROOT", tmp_path)
    slide = {
        "render": {"slide_size_pt": {"width": 960, "height": 540}, "background_color": "#FFFFFF", "layers": []},
        "content_elements": [{
            "element_id": "title", "kind": "text", "text": "Editable PDF title", "z_index": 1,
            "geometry_pt": {"x_pt": 70, "y_pt": 80, "width_pt": 800, "height_pt": 100},
            "geometry_norm": {"x": 70 / 960, "y": 80 / 540, "width": 800 / 960, "height": 100 / 540},
            "typography": {"family": "Arial", "size_pt": 38, "color": "#112233"},
        }],
    }
    response = web.export_generated_pdf("job", web.GeneratedPresentationExportRequest(
        title="Test", slides=[slide],
    ))
    assert response.body.startswith(b"%PDF-")
    assert response.media_type == "application/pdf"
    output = tmp_path / "test.pdf"
    output.write_bytes(response.body)
    if shutil.which("pdfinfo"):
        info = subprocess.run(["pdfinfo", str(output)], capture_output=True, text=True, check=True)
        assert "Pages:           1" in info.stdout
