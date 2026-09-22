import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.features import (
    bucket_buy_sell_ratio,
    bucket_entry_score,
    bucket_liquidity,
    bucket_price_impact,
    bucket_price_velocity,
    bucket_slippage,
    bucket_token_age,
    bucket_volume_acceleration,
    compute_feature_buckets,
)


def test_token_age_buckets_at_boundaries():
    assert bucket_token_age(29) == "below_30s"  # never expected in real trades (MIN_TOKEN_AGE_SEC=30)
    assert bucket_token_age(30) == "30-60s"
    assert bucket_token_age(59.9) == "30-60s"
    assert bucket_token_age(60) == "60-180s"
    assert bucket_token_age(180) == "180-300s"
    assert bucket_token_age(300) == "300-600s"
    assert bucket_token_age(600) == "600-900s"
    assert bucket_token_age(900) == "900s+"
    assert bucket_token_age(5000) == "900s+"


def test_token_age_unknown_on_none():
    assert bucket_token_age(None) == "unknown"


def test_liquidity_buckets():
    assert bucket_liquidity(19.99) == "below_20_SOL"  # never expected in real trades (MIN_LIQUIDITY=20 SOL)
    assert bucket_liquidity(20) == "20-30_SOL"
    assert bucket_liquidity(29.99) == "20-30_SOL"
    assert bucket_liquidity(30) == "30-50_SOL"
    assert bucket_liquidity(50) == "50-100_SOL"
    assert bucket_liquidity(100) == "100+_SOL"
    assert bucket_liquidity(10_000) == "100+_SOL"


def test_price_velocity_buckets():
    assert bucket_price_velocity(0.5) == "below_1pct"
    assert bucket_price_velocity(1) == "1-2pct"
    assert bucket_price_velocity(2) == "2-3pct"
    assert bucket_price_velocity(3) == "3-5pct"
    assert bucket_price_velocity(5) == "5pct+"
    assert bucket_price_velocity(100) == "5pct+"


def test_buy_sell_ratio_buckets():
    assert bucket_buy_sell_ratio(1.0) == "below_1.5"
    assert bucket_buy_sell_ratio(1.5) == "1.5-2"
    assert bucket_buy_sell_ratio(2) == "2-3"
    assert bucket_buy_sell_ratio(3) == "3+"


def test_volume_acceleration_buckets():
    assert bucket_volume_acceleration(1.0) == "below_1.5x"
    assert bucket_volume_acceleration(1.5) == "1.5-2x"
    assert bucket_volume_acceleration(2) == "2-3x"
    assert bucket_volume_acceleration(3) == "3x+"


def test_price_impact_and_slippage_buckets():
    assert bucket_price_impact(0.2) == "0-0.5pct"
    assert bucket_price_impact(0.7) == "0.5-1pct"
    assert bucket_price_impact(1.5) == "1pct+"
    assert bucket_slippage(0.1) == "0-0.3pct"
    assert bucket_slippage(0.4) == "0.3-0.6pct"
    assert bucket_slippage(0.9) == "0.6pct+"


def test_entry_score_buckets():
    assert bucket_entry_score(-1) == "below_0"
    assert bucket_entry_score(1) == "0-3"
    assert bucket_entry_score(4) == "3-5"
    assert bucket_entry_score(10) == "5+"


def test_compute_feature_buckets_from_trade_dict():
    trade = {
        "entry_token_age_sec": 45,
        "entry_liquidity_sol": 25,
        "entry_price_velocity_5s_pct": 1.5,
        "entry_buy_sell_ratio": 2.5,
        "entry_volume_acceleration_x": 1.8,
        "entry_price_impact_pct": 0.3,
        "entry_slippage_pct": 0.2,
        "entry_score": 4.5,
    }
    buckets = compute_feature_buckets(trade)
    assert buckets.token_age_bucket == "30-60s"
    assert buckets.liquidity_bucket == "20-30_SOL"
    assert buckets.price_velocity_bucket == "1-2pct"
    assert buckets.buy_sell_ratio_bucket == "2-3"
    assert buckets.volume_acceleration_bucket == "1.5-2x"
    assert buckets.price_impact_bucket == "0-0.5pct"
    assert buckets.slippage_bucket == "0-0.3pct"
    assert buckets.entry_score_bucket == "3-5"
    assert buckets.as_dict()["token_age_bucket"] == "30-60s"


def test_compute_feature_buckets_handles_missing_fields():
    buckets = compute_feature_buckets({})
    assert buckets.token_age_bucket == "unknown"
    assert buckets.liquidity_bucket == "unknown"
