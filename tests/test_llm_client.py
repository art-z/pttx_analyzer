from types import SimpleNamespace

import pytest

from app.llm_client import LLMConfigError, LLMError, extract_json_payload, complete


def test_extract_json_payload_from_markdown_fence():
    text = """```json
{"presentation": {"title": "Demo"}}
```"""
    assert extract_json_payload(text) == {"presentation": {"title": "Demo"}}


def test_extract_json_payload_from_plain_json():
    text = '{"presentation": {"title": "Demo"}}'
    assert extract_json_payload(text)["presentation"]["title"] == "Demo"


def test_complete_requires_env(monkeypatch):
    monkeypatch.delenv("YANDEX_CLOUD_API_KEY", raising=False)
    monkeypatch.delenv("YANDEX_CLOUD_FOLDER", raising=False)

    with pytest.raises(LLMConfigError):
        complete("system", "user")


def test_complete_parses_yandex_response(monkeypatch):
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "token")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER", "folder")
    monkeypatch.setenv("YANDEX_CLOUD_MODEL", "qwen3-235b-a22b-fp8")

    calls = {}

    class FakeResponses:
        def create(self, **kwargs):
            calls["request"] = kwargs
            return SimpleNamespace(
                output_text='{"presentation": {"title": "OK"}}',
                usage=SimpleNamespace(input_tokens=10, output_tokens=5, total_tokens=15),
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            calls["client"] = kwargs
            self.responses = FakeResponses()

    monkeypatch.setattr("app.llm_client.openai.OpenAI", FakeOpenAI)

    completion = complete("system", "user")
    assert "presentation" in completion.text
    assert completion.usage.total_tokens == 15
    assert calls["client"]["project"] == "folder"
    assert calls["request"]["model"] == "gpt://folder/qwen3-235b-a22b-fp8"
    assert calls["request"]["instructions"] == "system"
    assert calls["request"]["input"] == "user"


def test_complete_enables_json_mode_and_low_reasoning_for_gpt_oss(monkeypatch):
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "token")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER", "folder")
    monkeypatch.setenv("YANDEX_CLOUD_MODEL", "gpt-oss-20b/latest")

    calls = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.update(kwargs)
            return SimpleNamespace(
                status="completed",
                output_text='{"presentation": {}}',
                usage=None,
            )

    monkeypatch.setattr("app.llm_client.openai.OpenAI", FakeOpenAI)

    complete("Return JSON", "user", json_mode=True)

    assert calls["text"] == {"format": {"type": "json_object"}}
    assert calls["reasoning"] == {"effort": "low"}


def test_complete_reports_token_truncation(monkeypatch):
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "token")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER", "folder")
    monkeypatch.setenv("YANDEX_CLOUD_MODEL", "gpt-oss-20b/latest")
    monkeypatch.setenv("YANDEX_MAX_OUTPUT_TOKENS", "25000")

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            return SimpleNamespace(
                status="incomplete",
                incomplete_details=SimpleNamespace(reason="max_output_tokens"),
                output_text='{"presentation":',
                usage=None,
            )

    monkeypatch.setattr("app.llm_client.openai.OpenAI", FakeOpenAI)

    with pytest.raises(LLMError, match="обрезан по лимиту токенов"):
        complete("Return JSON", "user", json_mode=True)


def test_complete_accepts_full_model_uri(monkeypatch):
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "token")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER", "folder")
    monkeypatch.setenv("YANDEX_CLOUD_MODEL", "gpt://other/custom-model")

    calls = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.responses = SimpleNamespace(create=self.create)

        def create(self, **kwargs):
            calls.update(kwargs)
            return SimpleNamespace(output_text="ok", usage=None)

    monkeypatch.setattr("app.llm_client.openai.OpenAI", FakeOpenAI)

    complete("system", "user")
    assert calls["model"] == "gpt://other/custom-model"
