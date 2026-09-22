"""Provider abstraction (Phase 4 tasks 15-17).

The learning engine never talks to a specific AI vendor SDK directly --
only to this `AIProvider` interface. `MockAIProvider` is fully
deterministic and network-free (tests never require an external AI API).
`HttpChatCompletionsProvider` is a real, generic, OpenAI-compatible-shaped
HTTP client for whichever provider is actually configured; it is not
exercised against a live network by this project's test suite (no network
access, no API key here), but its request-building and error-mapping logic
IS unit tested via an injected transport function.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable

from .sanitize import sanitize_error_message


class AIProviderError(Exception):
    """Base class for every way a provider call can fail. A caller must
    catch this (or a subclass), record the failure, and continue normal
    operation -- AI failure must never stop trading (spec task 18)."""


class AIProviderTimeoutError(AIProviderError):
    pass


class AIProviderRateLimitError(AIProviderError):
    pass


class AIProviderNetworkError(AIProviderError):
    pass


class AIProviderEmptyResponseError(AIProviderError):
    pass


@dataclass(frozen=True)
class AIProviderResponse:
    raw_text: str
    input_tokens: int
    output_tokens: int
    latency_ms: float


class AIProvider(ABC):
    @abstractmethod
    def analyze(self, prompt: str, *, max_output_tokens: int) -> AIProviderResponse:
        """Returns the raw text response. Callers are responsible for
        parsing/validating it (see learning.ai.schema.validate_ai_output) --
        a provider never returns a trusted, already-validated object."""


class MockAIProvider(AIProvider):
    """Deterministic, network-free provider for tests (spec task 17).

    `mode` selects the canned behavior:
      - "valid": returns a well-formed AIAnalysisOutput JSON, echoing back
        `response_overrides` (or a sensible default) so a test can assert on it
      - "malformed": returns text that is not valid JSON
      - "hard_risk_attempt": returns a valid-JSON envelope whose
        candidate_parameters includes a hard-risk-parameter name
      - "empty": returns an empty string
      - "timeout": raises AIProviderTimeoutError
      - "rate_limit": raises AIProviderRateLimitError
      - "network_error": raises AIProviderNetworkError
    """

    def __init__(self, mode: str = "valid", response_overrides: dict | None = None, latency_ms: float = 1.0):
        self.mode = mode
        self.response_overrides = response_overrides or {}
        self.latency_ms = latency_ms
        self.calls: list[str] = []

    def analyze(self, prompt: str, *, max_output_tokens: int) -> AIProviderResponse:
        self.calls.append(prompt)

        if self.mode == "timeout":
            raise AIProviderTimeoutError("mock provider: simulated timeout")
        if self.mode == "rate_limit":
            raise AIProviderRateLimitError("mock provider: simulated rate limit")
        if self.mode == "network_error":
            raise AIProviderNetworkError("mock provider: simulated network error")
        if self.mode == "empty":
            return AIProviderResponse(raw_text="", input_tokens=len(prompt) // 4, output_tokens=0, latency_ms=self.latency_ms)
        if self.mode == "malformed":
            return AIProviderResponse(raw_text="{not valid json", input_tokens=len(prompt) // 4, output_tokens=10, latency_ms=self.latency_ms)

        base = {
            "analysis_id": "mock_analysis_1",
            "summary": "Mock analysis summary for testing.",
            "observations": [],
            "hypotheses": [],
            "candidate_parameters": [],
            "confidence": "low",
            "requires_more_data": False,
            "reasoning_basis": [],
            "warnings": [],
        }
        if self.mode == "hard_risk_attempt":
            base["candidate_parameters"] = [{"parameter": "position_size_sol", "proposed_value": 1.0}]
        base.update(self.response_overrides)
        text = json.dumps(base)
        return AIProviderResponse(raw_text=text, input_tokens=len(prompt) // 4, output_tokens=len(text) // 4, latency_ms=self.latency_ms)


class HttpChatCompletionsProvider(AIProvider):
    """Generic OpenAI-compatible chat-completions HTTP client. Never
    hardcodes a specific vendor -- `base_url` and `model` are configuration,
    and the API key is read from an environment variable whose NAME (not
    value) is passed in, so no secret ever appears in code or in a config
    file committed to the repo.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key_env_var: str,
        env: dict[str, str] | None = None,
        http_post_fn: Callable[[str, dict, dict], tuple[int, str]] | None = None,
        timeout_sec: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key_env_var = api_key_env_var
        self._env = env if env is not None else os.environ
        self._http_post_fn = http_post_fn or self._default_http_post
        self.timeout_sec = timeout_sec

        if not self._env.get(api_key_env_var):
            raise AIProviderError(f"Environment variable {api_key_env_var!r} is not set -- cannot construct HttpChatCompletionsProvider")

    def _default_http_post(self, url: str, headers: dict, body: dict) -> tuple[int, str]:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
            return resp.status, resp.read().decode("utf-8")

    def analyze(self, prompt: str, *, max_output_tokens: int) -> AIProviderResponse:
        api_key = self._env[self.api_key_env_var]
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        body = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_output_tokens,
        }

        started = time.monotonic()
        try:
            status, response_text = self._http_post_fn(f"{self.base_url}/chat/completions", headers, body)
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise AIProviderRateLimitError(sanitize_error_message(str(exc))) from exc
            raise AIProviderNetworkError(sanitize_error_message(str(exc))) from exc
        except TimeoutError as exc:
            raise AIProviderTimeoutError(sanitize_error_message(str(exc))) from exc
        except OSError as exc:
            raise AIProviderNetworkError(sanitize_error_message(str(exc))) from exc
        latency_ms = (time.monotonic() - started) * 1000

        if status == 429:
            raise AIProviderRateLimitError(f"rate limited (HTTP {status})")
        if status >= 400:
            raise AIProviderNetworkError(sanitize_error_message(f"HTTP {status}: {response_text[:200]}"))
        if not response_text.strip():
            raise AIProviderEmptyResponseError("empty response body")

        try:
            parsed = json.loads(response_text)
            content = parsed["choices"][0]["message"]["content"]
            usage = parsed.get("usage", {})
        except (json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
            raise AIProviderError(f"Unexpected response shape from provider: {exc}") from exc

        return AIProviderResponse(
            raw_text=content,
            input_tokens=usage.get("prompt_tokens", len(prompt) // 4),
            output_tokens=usage.get("completion_tokens", len(content) // 4),
            latency_ms=latency_ms,
        )


def create_provider_from_env(env: dict[str, str] | None = None) -> AIProvider:
    """Factory reading AI_PROVIDER (default 'mock') plus provider-specific
    config -- the ONE place a provider is chosen, so the rest of the
    learning engine never hardcodes a vendor (spec task 15/16)."""
    env = env if env is not None else os.environ
    provider_name = env.get("AI_PROVIDER", "mock")

    if provider_name == "mock":
        return MockAIProvider(mode=env.get("AI_MOCK_MODE", "valid"))

    if provider_name == "http":
        base_url = env.get("AI_PROVIDER_BASE_URL")
        model = env.get("AI_ANALYSIS_MODEL")
        api_key_env_var = env.get("AI_PROVIDER_API_KEY_ENV")
        if not base_url or not model or not api_key_env_var:
            raise AIProviderError(
                "AI_PROVIDER=http requires AI_PROVIDER_BASE_URL, AI_ANALYSIS_MODEL, and AI_PROVIDER_API_KEY_ENV to be set"
            )
        return HttpChatCompletionsProvider(base_url=base_url, model=model, api_key_env_var=api_key_env_var, env=env)

    raise AIProviderError(f"Unknown AI_PROVIDER {provider_name!r} (expected 'mock' or 'http')")
