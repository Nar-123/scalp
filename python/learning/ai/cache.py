"""AI result cache key computation (Phase 4 task 14).

Pure functions only -- no SQL here (see learning/db.py for the actual
ai_analyses table reads/writes). Keeping the key computation pure and
side-effect-free makes it trivial to test that two semantically identical
analyses produce the same key, and that any relevant change produces a
different one.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def compute_feature_hash(feature_buckets: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(feature_buckets).encode("utf-8")).hexdigest()


def compute_pattern_hash(patterns: list[dict[str, Any]]) -> str:
    return hashlib.sha256(_canonical_json(patterns).encode("utf-8")).hexdigest()


def compute_cache_key(
    strategy_version: str,
    analysis_period_start: str,
    analysis_period_end: str,
    feature_hash: str,
    pattern_hash: str,
    model: str,
    prompt_version: str,
) -> str:
    """Two analyses with the same strategy version, analysis period,
    feature/pattern content, model, and prompt version are considered
    identical -- calling the provider again would produce no new
    information, so the cached result is returned instead (spec task 14)."""
    parts = [strategy_version, analysis_period_start, analysis_period_end, feature_hash, pattern_hash, model, prompt_version]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
