import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.ai.cache import compute_cache_key, compute_feature_hash, compute_pattern_hash


def test_feature_hash_is_stable_regardless_of_dict_key_order():
    a = {"liquidity_bucket": {"20-30_SOL": 1}, "price_velocity_bucket": {"1-2pct": 2}}
    b = {"price_velocity_bucket": {"1-2pct": 2}, "liquidity_bucket": {"20-30_SOL": 1}}
    assert compute_feature_hash(a) == compute_feature_hash(b)


def test_feature_hash_changes_when_content_changes():
    a = {"liquidity_bucket": {"20-30_SOL": 1}}
    b = {"liquidity_bucket": {"20-30_SOL": 2}}
    assert compute_feature_hash(a) != compute_feature_hash(b)


def test_pattern_hash_changes_with_pattern_content():
    a = [{"feature": "x", "bucket": "y"}]
    b = [{"feature": "x", "bucket": "z"}]
    assert compute_pattern_hash(a) != compute_pattern_hash(b)


def test_cache_key_is_deterministic_for_identical_inputs():
    key1 = compute_cache_key("V1", "2026-01-01", "2026-01-02", "feat", "pat", "model-a", "AI_PROMPT_V1")
    key2 = compute_cache_key("V1", "2026-01-01", "2026-01-02", "feat", "pat", "model-a", "AI_PROMPT_V1")
    assert key1 == key2


def test_cache_key_changes_when_prompt_version_changes():
    key1 = compute_cache_key("V1", "2026-01-01", "2026-01-02", "feat", "pat", "model-a", "AI_PROMPT_V1")
    key2 = compute_cache_key("V1", "2026-01-01", "2026-01-02", "feat", "pat", "model-a", "AI_PROMPT_V2")
    assert key1 != key2


def test_cache_key_changes_when_model_changes():
    key1 = compute_cache_key("V1", "2026-01-01", "2026-01-02", "feat", "pat", "model-a", "AI_PROMPT_V1")
    key2 = compute_cache_key("V1", "2026-01-01", "2026-01-02", "feat", "pat", "model-b", "AI_PROMPT_V1")
    assert key1 != key2


def test_cache_key_changes_when_strategy_version_changes():
    key1 = compute_cache_key("V1", "2026-01-01", "2026-01-02", "feat", "pat", "model-a", "AI_PROMPT_V1")
    key2 = compute_cache_key("V2", "2026-01-01", "2026-01-02", "feat", "pat", "model-a", "AI_PROMPT_V1")
    assert key1 != key2
