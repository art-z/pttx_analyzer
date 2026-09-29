import json
from pathlib import Path

from app.llm_usage import JobLLMUsage, LLMUsageRecord, parse_yandex_usage


def test_parse_yandex_usage():
    data = {
        "result": {
            "usage": {
                "inputTextTokens": "120",
                "completionTokens": "80",
                "totalTokens": "200",
            }
        }
    }
    record = parse_yandex_usage(data, model_uri="gpt://folder/model/latest", operation="create_presentation")
    assert record.input_tokens == 120
    assert record.output_tokens == 80
    assert record.total_tokens == 200


def test_job_llm_usage_accumulates(tmp_path: Path):
    tracker = JobLLMUsage(tmp_path)
    tracker.add(LLMUsageRecord(input_tokens=100, output_tokens=50, total_tokens=150, operation="create_presentation"))
    tracker.add(LLMUsageRecord(input_tokens=200, output_tokens=100, total_tokens=300, operation="enrich_slide"))

    summary = tracker.summary()
    assert summary.request_count == 2
    assert summary.input_tokens == 300
    assert summary.output_tokens == 150
    assert summary.total_tokens == 450

    saved = json.loads((tmp_path / "llm_usage.json").read_text(encoding="utf-8"))
    assert saved["summary"]["total_tokens"] == 450

    reloaded = JobLLMUsage(tmp_path)
    assert reloaded.summary().total_tokens == 450
