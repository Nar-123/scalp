import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.reports import build_compact_summary


def make_trade(pnl_sol, hold_ms=10_000, slippage=0.2, impact=0.3, reentry_index=0):
    return {
        "pnl_sol": pnl_sol,
        "hold_duration_ms": hold_ms,
        "exit_reason": "quick_tp" if pnl_sol > 0 else "dynamic_sl",
        "reentry_index": reentry_index,
        "entry_slippage_pct": slippage,
        "entry_price_impact_pct": impact,
    }


def test_compact_summary_has_exactly_the_documented_shape():
    trades = [make_trade(0.02), make_trade(-0.01), make_trade(0.03, reentry_index=1)]
    summary = build_compact_summary(trades, period_label="1h")

    expected_keys = {
        "period",
        "trades",
        "wins",
        "losses",
        "win_rate",
        "avg_pnl",
        "median_hold_seconds",
        "avg_slippage",
        "avg_price_impact",
        "reentry_count",
        "reentry_win_rate",
        "max_drawdown",
    }
    assert set(summary.keys()) == expected_keys
    assert summary["period"] == "1h"
    assert summary["trades"] == 3


def test_compact_summary_is_json_serializable_and_small():
    import json

    trades = [make_trade(0.01) for _ in range(500)]
    summary = build_compact_summary(trades, period_label="1h")
    serialized = json.dumps(summary)
    # A compact summary of 500 trades should still be tiny -- nowhere near
    # raw-transaction-history size. A generous ceiling, not a tight budget.
    assert len(serialized) < 1000


def test_compact_summary_handles_empty_trades_without_error():
    summary = build_compact_summary([], period_label="1h")
    assert summary["trades"] == 0
    assert summary["win_rate"] is None
    assert summary["avg_pnl"] is None
    assert summary["median_hold_seconds"] is None


def test_reentry_win_rate_only_counts_actual_reentries():
    trades = [make_trade(0.01, reentry_index=0), make_trade(-0.01, reentry_index=1), make_trade(0.02, reentry_index=1)]
    summary = build_compact_summary(trades, period_label="1h")
    assert summary["reentry_count"] == 2
    assert summary["reentry_win_rate"] == 0.5
