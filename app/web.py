from . import env  # noqa: F401 — загрузка .env до чтения os.environ

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from contextlib import asynccontextmanager
from copy import deepcopy
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .analyzer import analyze
from .llm_client import LLMConfigError, LLMError
from .llm_usage import JobLLMUsage
from .presentation_generator import generate_presentation_from_brief
from .generated_export_scene import build_generated_export_scene
from .prompts_loader import load_default_brief
from .slides_export import build_pptx_from_slide_images
from .slides_pptx_builder import build_editable_pptx_from_catalog
from .text_revision_service import DEFAULT_REVISION_SERVICE, TextRevisionWatcher

REVISION_WATCHER = TextRevisionWatcher(DEFAULT_REVISION_SERVICE)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    REVISION_WATCHER.start()
    try:
        yield
    finally:
        REVISION_WATCHER.stop()


app = FastAPI(title="PPTX Style Analyzer", lifespan=lifespan)

OUTPUT_ROOT = Path(os.environ.get("OUTPUT_ROOT", "output"))
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

FRONTEND_ROOT = Path(__file__).resolve().parent.parent / "frontend" / "dist"
FONTS_ROOT = Path(__file__).resolve().parent / "fonts"
if (FRONTEND_ROOT / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_ROOT / "assets"), name="frontend-assets")
if FONTS_ROOT.is_dir():
    app.mount("/fonts", StaticFiles(directory=FONTS_ROOT), name="fonts")


def _frontend_page(name: str) -> FileResponse:
    path = FRONTEND_ROOT / name
    if not path.is_file():
        raise HTTPException(503, "Frontend is not built. Run npm install && npm run build in frontend/.")
    return FileResponse(path)


@app.get("/")
def index():
    return _frontend_page("index.html")


@app.get("/lite")
@app.get("/lite.html")
def lite_index():
    return _frontend_page("lite.html")


@app.get("/prompts/default-brief")
def default_brief():
    return {"brief": load_default_brief()}


@app.post("/analyze")
def analyze_upload(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(400, "Загрузите файл .pptx")

    job_id = uuid.uuid4().hex[:12]
    job_dir = OUTPUT_ROOT / job_id
    job_dir.mkdir(parents=True)
    pptx_path = job_dir / "source.pptx"
    with pptx_path.open("wb") as destination:
        shutil.copyfileobj(file.file, destination)

    try:
        report = analyze(pptx_path, job_dir)
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(422, f"Не удалось проанализировать PPTX: {exc}") from exc

    return {"job_id": job_id, "report": report}


class GenerateBriefRequest(BaseModel):
    brief: str = ""


def _generate_presentation_once(
    job_dir: Path, brief: str, report: dict,
) -> tuple[dict, JobLLMUsage]:
    """Run the sole LLM request and persist its complete presentation response."""
    usage_tracker = JobLLMUsage(job_dir)
    presentation = generate_presentation_from_brief(brief, usage_tracker, report)
    (job_dir / "brief.txt").write_text(brief, encoding="utf-8")
    (job_dir / "presentation.json").write_text(
        json.dumps(presentation, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return presentation, usage_tracker


@app.post("/jobs/{job_id}/generate-presentation")
def generate_job_presentation(job_id: str, payload: GenerateBriefRequest):
    job_dir = OUTPUT_ROOT / job_id
    if not (job_dir / "report.json").is_file():
        raise HTTPException(404, "Сначала загрузите шаблон")

    brief = payload.brief.strip()
    if not brief:
        raise HTTPException(400, "Заполните бриф презентации")

    presentation_path = job_dir / "presentation.json"
    if presentation_path.is_file():
        return {
            "job_id": job_id,
            "presentation": json.loads(presentation_path.read_text(encoding="utf-8")),
            "llm_usage": JobLLMUsage(job_dir).summary().to_dict(),
            "cached": True,
        }

    try:
        report = json.loads((job_dir / "report.json").read_text(encoding="utf-8"))
        presentation, usage_tracker = _generate_presentation_once(job_dir, brief, report)
    except LLMConfigError as exc:
        raise HTTPException(503, str(exc)) from exc
    except LLMError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(422, f"Не удалось получить ответ модели: {exc}") from exc

    return {
        "job_id": job_id,
        "presentation": presentation,
        "llm_usage": usage_tracker.summary().to_dict(),
    }


def _parse_form_bool(value: str | None) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "on", "yes"}


@app.post("/create-presentation")
def create_presentation(
    file: UploadFile = File(...),
    brief: str = Form(""),
    generate_presentation: str = Form("false"),
):
    if not file.filename or not file.filename.lower().endswith(".pptx"):
        raise HTTPException(400, "Загрузите файл .pptx")

    should_generate = _parse_form_bool(generate_presentation)
    brief = brief.strip()
    if should_generate and not brief:
        raise HTTPException(400, "Заполните бриф презентации")

    job_id = uuid.uuid4().hex[:12]
    job_dir = OUTPUT_ROOT / job_id
    job_dir.mkdir(parents=True)
    pptx_path = job_dir / "source.pptx"
    with pptx_path.open("wb") as destination:
        shutil.copyfileobj(file.file, destination)

    report = None
    presentation = None
    presentation_error = None
    usage_tracker = JobLLMUsage(job_dir)

    try:
        report = analyze(pptx_path, job_dir)
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(422, f"Не удалось проанализировать PPTX: {exc}") from exc

    if should_generate:
        try:
            presentation, usage_tracker = _generate_presentation_once(job_dir, brief, report)
        except LLMConfigError as exc:
            presentation_error = str(exc)
        except LLMError as exc:
            presentation_error = str(exc)
        except Exception as exc:
            presentation_error = f"Не удалось получить ответ модели: {exc}"

    llm_usage = usage_tracker.summary().to_dict()

    return {
        "job_id": job_id,
        "report": report,
        "presentation": presentation,
        "presentation_error": presentation_error,
        "llm_usage": llm_usage,
        "generated_presentation": should_generate,
    }


@app.get("/jobs/{job_id}/llm-usage.json")
def llm_usage_json(job_id: str):
    path = OUTPUT_ROOT / job_id / "llm_usage.json"
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="application/json", filename="llm-usage.json")


@app.get("/jobs/{job_id}/report.json")
def report_json(job_id: str):
    path = OUTPUT_ROOT / job_id / "report.json"
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type="application/json", filename="report.json")


@app.get("/jobs/{job_id}/assets/{filename}")
def asset(job_id: str, filename: str):
    path = OUTPUT_ROOT / job_id / "assets" / Path(filename).name
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


class SlideImagesExportRequest(BaseModel):
    mode: str = "design-system"
    width_pt: float = Field(default=960.0, gt=0)
    height_pt: float = Field(default=540.0, gt=0)
    images: list[str] = Field(min_length=1)


class GeneratedPresentationExportRequest(BaseModel):
    title: str = "presentation"
    slides: list[dict] = Field(min_length=1)


@app.post("/jobs/{job_id}/export-slides.pptx")
def export_slides_pptx(job_id: str, payload: SlideImagesExportRequest):
    job_dir = OUTPUT_ROOT / job_id
    if not job_dir.is_dir():
        raise HTTPException(404, "Job not found")

    try:
        pptx_bytes = build_pptx_from_slide_images(
            payload.images,
            payload.width_pt,
            payload.height_pt,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    mode_label = "pptx-raw" if payload.mode == "faithful" else "design-system"
    filename = f"slides-{job_id}-{mode_label}-preview.pptx"
    return Response(
        content=pptx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/jobs/{job_id}/export-editable.pptx")
def export_editable_pptx(job_id: str, mode: str = "faithful"):
    job_dir = OUTPUT_ROOT / job_id
    report_path = job_dir / "report.json"
    assets_dir = job_dir / "assets"
    if not report_path.is_file():
        raise HTTPException(404, "Job not found")

    report = json.loads(report_path.read_text())
    try:
        pptx_bytes = build_editable_pptx_from_catalog(report, assets_dir)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    source_name = str(report.get("source") or "presentation.pptx").replace(".pptx", "")
    mode_label = "pptx-raw" if mode == "faithful" else "design-system"
    filename = f"{source_name}-{mode_label}-editable.pptx"
    return Response(
        content=pptx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/jobs/{job_id}/export-generated.pptx")
def export_generated_pptx(job_id: str, payload: GeneratedPresentationExportRequest):
    job_dir = OUTPUT_ROOT / job_id
    report_path = job_dir / "report.json"
    assets_dir = job_dir / "assets"
    if not report_path.is_file():
        raise HTTPException(404, "Job not found")

    report = json.loads(report_path.read_text(encoding="utf-8"))
    export_report = deepcopy(report)
    scene = build_generated_export_scene(report, payload.title, payload.slides)
    selected_slides = scene["slides"]

    export_report["slides"] = {
        "slides": selected_slides,
        "summary": {"slide_count": len(selected_slides), "source": "selected_generated_variants"},
    }
    (job_dir / "generated-selection.json").write_text(
        json.dumps(scene, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    try:
        pptx_bytes = build_editable_pptx_from_catalog(export_report, assets_dir)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    safe_title = "".join(
        char if char.isascii() and (char.isalnum() or char in {"-", "_"}) else "-"
        for char in payload.title
    ).strip("-")
    filename = f"{safe_title or 'presentation'}-selected.pptx"
    return Response(
        content=pptx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/jobs/{job_id}/export-generated.pdf")
def export_generated_pdf(job_id: str, payload: GeneratedPresentationExportRequest):
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise HTTPException(503, "PDF-экспорт недоступен: LibreOffice не установлен")

    pptx_response = export_generated_pptx(job_id, payload)
    with tempfile.TemporaryDirectory(prefix="generated-slides-") as temporary:
        work = Path(temporary)
        source = work / "presentation.pptx"
        source.write_bytes(pptx_response.body)
        profile = (work / "libreoffice-profile").as_uri()
        try:
            result = subprocess.run(
                [soffice, f"-env:UserInstallation={profile}", "--headless", "--convert-to",
                 "pdf:impress_pdf_Export", "--outdir", str(work), str(source)],
                capture_output=True, text=True, timeout=120, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(504, "PDF-экспорт превысил время ожидания") from exc
        pdf_path = work / "presentation.pdf"
        if result.returncode != 0 or not pdf_path.is_file():
            raise HTTPException(502, f"LibreOffice не собрал PDF: {result.stderr[-500:]}")
        pdf_bytes = pdf_path.read_bytes()

    safe_title = "".join(
        char if char.isascii() and (char.isalnum() or char in {"-", "_"}) else "-"
        for char in payload.title
    ).strip("-")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe_title or "presentation"}-selected.pdf"'},
    )
