import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.ai.provider import (
    AIProviderEmptyResponseError,
    AIProviderError,
    AIProviderNetworkError,
    AIProviderRateLimitError,
    AIProviderTimeoutError,
    HttpChatCompletionsProvider,
    MockAIProvider,
    create_provider_from_env,
)


class TestMockAIProvider:
    def test_valid_mode_returns_well_formed_json(self):
        provider = MockAIProvider(mode="valid")
        response = provider.analyze("prompt", max_output_tokens=1000)
        parsed = json.loads(response.raw_text)
        assert parsed["confidence"] == "low"
        assert response.input_tokens >= 0

    def test_valid_mode_applies_response_overrides(self):
        provider = MockAIProvider(mode="valid", response_overrides={"confidence": "high", "summary": "custom"})
        parsed = json.loads(provider.analyze("prompt", max_output_tokens=1000).raw_text)
        assert parsed["confidence"] == "high"
        assert parsed["summary"] == "custom"

    def test_malformed_mode_returns_invalid_json(self):
        provider = MockAIProvider(mode="malformed")
        response = provider.analyze("prompt", max_output_tokens=1000)
        with pytest.raises(json.JSONDecodeError):
            json.loads(response.raw_text)

    def test_empty_mode_returns_empty_string(self):
        provider = MockAIProvider(mode="empty")
        assert provider.analyze("prompt", max_output_tokens=1000).raw_text == ""

    def test_hard_risk_attempt_mode_proposes_a_hard_parameter(self):
        provider = MockAIProvider(mode="hard_risk_attempt")
        parsed = json.loads(provider.analyze("prompt", max_output_tokens=1000).raw_text)
        assert parsed["candidate_parameters"][0]["parameter"] == "position_size_sol"

    def test_timeout_mode_raises(self):
        with pytest.raises(AIProviderTimeoutError):
            MockAIProvider(mode="timeout").analyze("prompt", max_output_tokens=1000)

    def test_rate_limit_mode_raises(self):
        with pytest.raises(AIProviderRateLimitError):
            MockAIProvider(mode="rate_limit").analyze("prompt", max_output_tokens=1000)

    def test_network_error_mode_raises(self):
        with pytest.raises(AIProviderNetworkError):
            MockAIProvider(mode="network_error").analyze("prompt", max_output_tokens=1000)

    def test_records_every_call_for_test_assertions(self):
        provider = MockAIProvider(mode="valid")
        provider.analyze("first", max_output_tokens=100)
        provider.analyze("second", max_output_tokens=100)
        assert provider.calls == ["first", "second"]


class TestHttpChatCompletionsProvider:
    def test_raises_if_api_key_env_var_is_not_set(self):
        with pytest.raises(AIProviderError, match="not set"):
            HttpChatCompletionsProvider(base_url="https://api.example.com/v1", model="m", api_key_env_var="MISSING_KEY", env={})

    def test_builds_the_expected_request_and_parses_a_successful_response(self):
        captured = {}

        def fake_post(url, headers, body):
            captured["url"] = url
            captured["headers"] = headers
            captured["body"] = body
            return 200, json.dumps({"choices": [{"message": {"content": "hello"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}})

        provider = HttpChatCompletionsProvider(
            base_url="https://api.example.com/v1", model="test-model", api_key_env_var="TEST_KEY",
            env={"TEST_KEY": "secret-value"}, http_post_fn=fake_post,
        )
        response = provider.analyze("do the analysis", max_output_tokens=500)

        assert response.raw_text == "hello"
        assert response.input_tokens == 10
        assert response.output_tokens == 5
        assert captured["url"] == "https://api.example.com/v1/chat/completions"
        assert captured["headers"]["Authorization"] == "Bearer secret-value"
        assert captured["body"]["model"] == "test-model"
        assert captured["body"]["max_tokens"] == 500

    def test_maps_a_429_status_to_rate_limit_error(self):
        provider = HttpChatCompletionsProvider(
            base_url="https://api.example.com", model="m", api_key_env_var="K", env={"K": "v"},
            http_post_fn=lambda url, headers, body: (429, "rate limited"),
        )
        with pytest.raises(AIProviderRateLimitError):
            provider.analyze("x", max_output_tokens=100)

    def test_maps_a_500_status_to_network_error(self):
        provider = HttpChatCompletionsProvider(
            base_url="https://api.example.com", model="m", api_key_env_var="K", env={"K": "v"},
            http_post_fn=lambda url, headers, body: (500, "server error"),
        )
        with pytest.raises(AIProviderNetworkError):
            provider.analyze("x", max_output_tokens=100)

    def test_empty_response_body_raises_empty_response_error(self):
        provider = HttpChatCompletionsProvider(
            base_url="https://api.example.com", model="m", api_key_env_var="K", env={"K": "v"},
            http_post_fn=lambda url, headers, body: (200, "   "),
        )
        with pytest.raises(AIProviderEmptyResponseError):
            provider.analyze("x", max_output_tokens=100)

    def test_error_messages_never_leak_the_api_key(self):
        def fake_post(url, headers, body):
            raise OSError(f"connection refused (Authorization: Bearer sk-{'x' * 40})")

        provider = HttpChatCompletionsProvider(
            base_url="https://api.example.com", model="m", api_key_env_var="K", env={"K": "v"}, http_post_fn=fake_post,
        )
        with pytest.raises(AIProviderNetworkError) as excinfo:
            provider.analyze("x", max_output_tokens=100)
        assert "x" * 40 not in str(excinfo.value)


class TestCreateProviderFromEnv:
    def test_defaults_to_mock_provider(self):
        provider = create_provider_from_env({})
        assert isinstance(provider, MockAIProvider)
        assert provider.mode == "valid"

    def test_reads_mock_mode_override(self):
        provider = create_provider_from_env({"AI_PROVIDER": "mock", "AI_MOCK_MODE": "timeout"})
        assert provider.mode == "timeout"

    def test_http_provider_requires_full_configuration(self):
        with pytest.raises(AIProviderError, match="requires"):
            create_provider_from_env({"AI_PROVIDER": "http"})

    def test_rejects_an_unknown_provider_name(self):
        with pytest.raises(AIProviderError, match="Unknown AI_PROVIDER"):
            create_provider_from_env({"AI_PROVIDER": "some-vendor-sdk"})
