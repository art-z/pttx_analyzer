import json
import os
import re
from dataclasses import dataclass
from typing import Any

import openai

from .llm_usage import JobLLMUsage, LLMUsageRecord, parse_responses_usage

DEFAULT_BASE_URL = "https://ai.api.cloud.yandex.net/v1"
DEFAULT_MODEL = "qwen3-235b-a22b-fp8"
DEFAULT_TIMEOUT_SECONDS = 90.0
DEFAULT_MAX_OUTPUT_TOKENS = 25000
DEFAULT_REASONING_EFFORT = "low"


class LLMError(Exception):
    pass


class LLMConfigError(LLMError):
    pass


@dataclass
class LLMCompletion:
    text: str
    usage: LLMUsageRecord


def _config() -> dict[str, str | float | int]:
    base_url = os.environ.get("YANDEX_CLOUD_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")
    api_key = os.environ.get("YANDEX_CLOUD_API_KEY", "").strip()
    folder_id = os.environ.get("YANDEX_CLOUD_FOLDER", "").strip()
    model = os.environ.get("YANDEX_CLOUD_MODEL", DEFAULT_MODEL).strip()
    timeout = float(os.environ.get("YANDEX_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))
    max_output_tokens = int(os.environ.get("YANDEX_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS))
    reasoning_effort = os.environ.get("YANDEX_REASONING_EFFORT", DEFAULT_REASONING_EFFORT).strip().lower()

    if not api_key:
        raise LLMConfigError("Не задан YANDEX_CLOUD_API_KEY в окружении")
    if not folder_id:
        raise LLMConfigError("Не задан YANDEX_CLOUD_FOLDER в окружении")
    if not model:
        raise LLMConfigError("Не задан YANDEX_CLOUD_MODEL в окружении")
    if reasoning_effort not in {"low", "medium", "high"}:
        raise LLMConfigError("YANDEX_REASONING_EFFORT должен быть low, medium или high")

    model_uri = model if model.startswith("gpt://") else f"gpt://{folder_id}/{model}"

    return {
        "base_url": base_url,
        "api_key": api_key,
        "folder_id": folder_id,
        "model_uri": model_uri,
        "timeout": timeout,
        "max_output_tokens": max_output_tokens,
        "reasoning_effort": reasoning_effort,
    }


def extract_json_payload(text: str) -> Any:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise LLMError("Модель вернула ответ без JSON-объекта")
    return json.loads(cleaned[start : end + 1])


def complete(
    system_prompt: str,
    user_prompt: str,
    *,
    usage_tracker: JobLLMUsage | None = None,
    operation: str = "completion",
    json_mode: bool = False,
) -> LLMCompletion:
    config = _config()
    client = openai.OpenAI(
        api_key=str(config["api_key"]),
        base_url=str(config["base_url"]),
        project=str(config["folder_id"]),
        timeout=float(config["timeout"]),
    )

    request: dict[str, Any] = {
        "model": str(config["model_uri"]),
        "temperature": 0.3,
        "instructions": system_prompt,
        "input": user_prompt,
        "max_output_tokens": int(config["max_output_tokens"]),
    }
    if json_mode:
        request["text"] = {"format": {"type": "json_object"}}
    if "gpt-oss" in str(config["model_uri"]).lower():
        request["reasoning"] = {"effort": str(config["reasoning_effort"])}

    try:
        response = client.responses.create(**request)
    except openai.APITimeoutError as exc:
        raise LLMError("Превышено время ожидания ответа модели") from exc
    except openai.APIConnectionError as exc:
        raise LLMError(f"Ошибка сети при обращении к модели: {exc}") from exc
    except openai.APIStatusError as exc:
        detail = exc.response.text.strip() if exc.response is not None else str(exc)
        raise LLMError(f"Модель вернула ошибку {exc.status_code}: {detail}") from exc
    except openai.OpenAIError as exc:
        raise LLMError(f"Ошибка при обращении к модели: {exc}") from exc

    try:
        text = response.output_text
        usage = parse_responses_usage(
            response.usage,
            model_uri=str(config["model_uri"]),
            operation=operation,
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise LLMError("Не удалось разобрать ответ модели") from exc

    if usage_tracker is not None:
        usage_tracker.add(usage)

    if getattr(response, "status", None) == "incomplete":
        details = getattr(response, "incomplete_details", None)
        reason = details.get("reason") if isinstance(details, dict) else getattr(details, "reason", None)
        if reason == "max_output_tokens":
            raise LLMError(
                "Ответ модели обрезан по лимиту токенов "
                f"({config['max_output_tokens']}). Увеличьте YANDEX_MAX_OUTPUT_TOKENS"
            )
        raise LLMError(f"Модель вернула незавершённый ответ: {reason or 'причина не указана'}")

    if not text or not str(text).strip():
        raise LLMError("Модель вернула пустой ответ")
    return LLMCompletion(text=str(text).strip(), usage=usage)
