import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.patterns import PATTERN_LABEL, discover_feature_patterns, discover_patterns, discover_reentry_patterns


def make_trade(liquidity_bucket_value, pnl_sol, reentry_index=0, entry_time_ms=0):
    return {
        "pnl_sol": pnl_sol,
        "hold_duration_ms": 5000,
        "exit_reason": "quick_tp" if pnl_sol > 0 else "dynamic_sl",
        "reentry_index": reentry_index,
        "entry_time_ms": entry_time_ms,
        "entry_token_age_sec": 45,
        "entry_liquidity_sol": liquidity_bucket_value,
        "entry_price_velocity_5s_pct": 1.5,
        "entry_buy_sell_ratio": 2.0,
        "entry_volume_acceleration_x": 1.8,
        "entry_price_impact_pct": 0.3,
        "entry_slippage_pct": 0.2,
        "entry_score": 4,
    }


def test_no_patterns_below_minimum_sample_size():
    # 10 trades, all in the same bucket, all winners -- would look like a
    # huge "pattern" but is far below MIN_TRADES_FOR_PATTERN.
    trades = [make_trade(150, 0.05) for _ in range(10)] + [make_trade(25, -0.02) for _ in range(10)]
    patterns = discover_feature_patterns(trades, min_sample_size=50)
    assert patterns == []


def test_pattern_found_above_minimum_sample_size_with_real_deviation():
    high_liquidity_wins = [make_trade(150, 0.05) for _ in range(60)]
    low_liquidity_losses = [make_trade(25, -0.02) for _ in range(60)]
    trades = high_liquidity_wins + low_liquidity_losses

    patterns = discover_feature_patterns(trades, min_sample_size=50)
    assert len(patterns) > 0
    for p in patterns:
        assert p.label == PATTERN_LABEL
        assert "correlation" in p.description.lower()
        assert "causation" not in p.description.lower() or "not evidence of causation" in p.description.lower()


def test_pattern_description_never_claims_causation():
    trades = [make_trade(150, 0.05) for _ in range(60)] + [make_trade(25, -0.02) for _ in range(60)]
    for p in discover_feature_patterns(trades, min_sample_size=50):
        assert "causes" not in p.description.lower()
        assert "causation" in p.description.lower()  # explicitly disclaims it


def test_no_pattern_when_deviation_below_threshold():
    # All buckets have the same ~50% win rate -- no deviation to report.
    trades = []
    for i in range(60):
        trades.append(make_trade(150, 0.05 if i % 2 == 0 else -0.05))
    patterns = discover_feature_patterns(trades, min_sample_size=50)
    assert patterns == []


def test_reentry_pattern_detects_underperforming_reentry_index():
    baseline = [make_trade(50, 0.05, reentry_index=0) for _ in range(60)]
    bad_reentries = [make_trade(50, -0.03, reentry_index=4) for _ in range(60)]
    patterns = discover_reentry_patterns(baseline + bad_reentries, min_sample_size=50)
    assert any(p.feature == "reentry_index" and p.bucket == "4" for p in patterns)


def test_reentry_index_zero_never_produces_its_own_pattern():
    trades = [make_trade(50, 0.05, reentry_index=0) for _ in range(60)]
    patterns = discover_reentry_patterns(trades, min_sample_size=50)
    assert all(p.bucket != "0" for p in patterns)


def test_discover_patterns_combines_feature_and_reentry_passes():
    trades = [make_trade(150, 0.05, reentry_index=0) for _ in range(60)] + [
        make_trade(25, -0.02, reentry_index=4) for _ in range(60)
    ]
    combined = discover_patterns(trades, min_sample_size=50)
    features = {p.feature for p in combined}
    assert "liquidity_bucket" in features
    assert "reentry_index" in features


def test_empty_trades_produce_no_patterns():
    assert discover_patterns([]) == []
