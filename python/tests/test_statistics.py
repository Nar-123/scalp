import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.statistics import (
    compute_core_statistics,
    compute_max_consecutive_losses,
    compute_max_drawdown,
    compute_pnl_by_bucket,
    compute_reentry_performance,
)


def trade(**overrides):
    base = {
        "pnl_sol": 0.01,
        "hold_duration_ms": 10_000,
        "exit_reason": "quick_tp",
        "reentry_index": 0,
        "entry_time_ms": 1000,
        "entry_token_age_sec": 45,
        "entry_liquidity_sol": 25,
        "entry_price_velocity_5s_pct": 1.5,
        "entry_buy_sell_ratio": 2.0,
        "entry_volume_acceleration_x": 1.8,
        "entry_price_impact_pct": 0.3,
        "entry_slippage_pct": 0.2,
        "entry_score": 4,
    }
    base.update(overrides)
    return base


def test_core_statistics_basic_aggregation():
    trades = [
        trade(pnl_sol=0.05, exit_reason="quick_tp"),
        trade(pnl_sol=-0.02, exit_reason="dynamic_sl"),
        trade(pnl_sol=0.03, exit_reason="momentum_tp"),
        trade(pnl_sol=-0.01, exit_reason="max_hold_timeout"),
    ]
    stats = compute_core_statistics(trades)
    assert stats.total_trades == 4
    assert stats.wins == 2
    assert stats.losses == 2
    assert stats.win_rate == 0.5
    assert stats.avg_pnl_sol == pytest.approx((0.05 - 0.02 + 0.03 - 0.01) / 4)
    assert stats.tp_frequency == 0.5  # quick_tp + momentum_tp = 2/4
    assert stats.sl_frequency == 0.25
    assert stats.timeout_frequency == 0.25


def test_core_statistics_empty_input():
    stats = compute_core_statistics([])
    assert stats.total_trades == 0
    assert stats.win_rate is None
    assert stats.avg_pnl_sol is None
    assert stats.median_pnl_sol is None
    assert stats.profit_factor is None
    assert stats.max_drawdown_sol == 0.0
    assert stats.max_consecutive_losses == 0


def test_profit_factor():
    trades = [trade(pnl_sol=0.10), trade(pnl_sol=0.10), trade(pnl_sol=-0.05)]
    stats = compute_core_statistics(trades)
    assert stats.profit_factor == (0.20 / 0.05)


def test_profit_factor_is_none_with_no_losses():
    trades = [trade(pnl_sol=0.10), trade(pnl_sol=0.05)]
    stats = compute_core_statistics(trades)
    assert stats.profit_factor is None


def test_median_pnl():
    trades = [trade(pnl_sol=v) for v in [0.01, 0.02, 0.03, -0.10]]
    stats = compute_core_statistics(trades)
    assert stats.median_pnl_sol == pytest.approx((0.01 + 0.02) / 2)


def test_max_drawdown_on_known_sequence():
    # equity curve: 0 -> 10 -> 5 -> 8 -> -2 -> 3
    pnl_sequence = [10, -5, 3, -10, 5]
    # cumulative: 10, 5, 8, -2, 3 ; peaks: 10,10,10,10,10 ; drawdowns: 0,5,2,12,7
    assert compute_max_drawdown(pnl_sequence) == 12


def test_max_drawdown_nondecreasing_curve_is_zero():
    assert compute_max_drawdown([1, 2, 3]) == 0.0


def test_max_drawdown_empty():
    assert compute_max_drawdown([]) == 0.0


def test_max_consecutive_losses():
    trades = [
        trade(pnl_sol=0.01),
        trade(pnl_sol=-0.01),
        trade(pnl_sol=-0.02),
        trade(pnl_sol=-0.03),
        trade(pnl_sol=0.04),
        trade(pnl_sol=-0.01),
    ]
    assert compute_max_consecutive_losses(trades) == 3


def test_max_consecutive_losses_none_pnl_breaks_streak():
    trades = [trade(pnl_sol=-0.01), trade(pnl_sol=None), trade(pnl_sol=-0.01)]
    assert compute_max_consecutive_losses(trades) == 1


def test_reentry_performance_grouped_by_index():
    trades = [
        trade(reentry_index=0, pnl_sol=0.05),
        trade(reentry_index=0, pnl_sol=0.03),
        trade(reentry_index=1, pnl_sol=-0.02),
        trade(reentry_index=1, pnl_sol=-0.01),
    ]
    perf = compute_reentry_performance(trades)
    by_index = {p.reentry_index: p for p in perf}
    assert by_index[0].trades == 2
    assert by_index[0].win_rate == 1.0
    assert by_index[1].trades == 2
    assert by_index[1].win_rate == 0.0


def test_pnl_by_bucket_groups_correctly():
    trades = [
        trade(entry_liquidity_sol=25, pnl_sol=0.05),
        trade(entry_liquidity_sol=26, pnl_sol=0.03),
        trade(entry_liquidity_sol=150, pnl_sol=-0.10),
    ]
    buckets = compute_pnl_by_bucket(trades, "liquidity_bucket")
    by_bucket = {b.bucket: b for b in buckets}
    assert by_bucket["20-30_SOL"].trades == 2
    assert by_bucket["100+_SOL"].trades == 1
    assert by_bucket["100+_SOL"].win_rate == 0.0


def test_reentry_performance_ignores_trades_missing_reentry_index():
    trades = [trade(reentry_index=0, pnl_sol=0.05), {**trade(pnl_sol=0.02), "reentry_index": None}]
    perf = compute_reentry_performance(trades)
    assert sum(p.trades for p in perf) == 1


def test_pnl_by_bucket_rejects_unknown_field():
    try:
        compute_pnl_by_bucket([], "not_a_real_field")
        assert False, "expected AttributeError"
    except AttributeError:
        pass
