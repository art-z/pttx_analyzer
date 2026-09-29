import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


def _to_int(value: Any) -> int:
    if value is None or value == "":
        return 0
    return int(value)


def parse_yandex_usage(data: dict[str, Any], *, model_uri: str | None = None, operation: str = "completion") -> "LLMUsageRecord":
    usage = data.get("result", {}).get("usage") or {}
    input_tokens = _to_int(usage.get("inputTextTokens"))
    output_tokens = _to_int(usage.get("completionTokens"))
    total_tokens = _to_int(usage.get("totalTokens"))
    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens
    return LLMUsageRecord(
        operation=operation,
        model_uri=model_uri,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
    )


def parse_responses_usage(
    usage: Any,
    *,
    model_uri: str | None = None,
    operation: str = "completion",
) -> "LLMUsageRecord":
    def value(name: str) -> Any:
        if isinstance(usage, dict):
            return usage.get(name)
        return getattr(usage, name, None)

    input_tokens = _to_int(value("input_tokens"))
    output_tokens = _to_int(value("output_tokens"))
    total_tokens = _to_int(value("total_tokens"))
    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens
    return LLMUsageRecord(
        operation=operation,
        model_uri=model_uri,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
    )


@dataclass
class LLMUsageRecord:
    input_tokens: int
    output_tokens: int
    total_tokens: int
    operation: str = "completion"
    model_uri: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class LLMUsageSummary:
    request_count: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    requests: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class JobLLMUsage:
    def __init__(self, job_dir: Path):
        self.job_dir = job_dir
        self.path = job_dir / "llm_usage.json"
        self._requests: list[dict[str, Any]] = []
        self._load()

    def add(self, record: LLMUsageRecord) -> None:
        self._requests.append(record.to_dict())
        self._save()

    def summary(self) -> LLMUsageSummary:
        input_tokens = sum(item.get("input_tokens", 0) for item in self._requests)
        output_tokens = sum(item.get("output_tokens", 0) for item in self._requests)
        total_tokens = sum(item.get("total_tokens", 0) for item in self._requests)
        return LLMUsageSummary(
            request_count=len(self._requests),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            requests=list(self._requests),
        )

    def _load(self) -> None:
        if not self.path.is_file():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        requests = payload.get("requests")
        if not isinstance(requests, list):
            summary = payload.get("summary") or {}
            requests = summary.get("requests")
        if isinstance(requests, list):
            self._requests = [item for item in requests if isinstance(item, dict)]

    def _save(self) -> None:
        self.job_dir.mkdir(parents=True, exist_ok=True)
        summary = self.summary()
        payload = {
            "summary": {
                "request_count": summary.request_count,
                "input_tokens": summary.input_tokens,
                "output_tokens": summary.output_tokens,
                "total_tokens": summary.total_tokens,
            },
            "requests": summary.requests,
        }
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
