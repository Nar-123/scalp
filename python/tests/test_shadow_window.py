import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.backtest_bridge import BridgeBacktestResult
from learning.shadow_window import build_window_comparison, shadow_window_bounds
from analytics.reader import open_ledger_readonly


def make_ledger(tmp_path: Path, with_ticks=True) -> Path:
    p = tmp_path / "ledger.sqlite"
    c = sqlite3.connect(p)
    c.execute("CREATE TABLE token_evaluations (strategy_version TEXT, evaluated_at_ms INTEGER, price_sol REAL)")
    c.execute(
        "CREATE TABLE shadow_trades (trade_id TEXT, strategy_version TEXT, status TEXT, entry_time_ms REAL, exit_time_ms REAL, pnl_sol REAL, "
        "exit_reason TEXT, hold_duration_ms REAL, entry_fees_sol REAL, exit_fees_sol REAL, entry_quote_json TEXT)"
    )
    c.execute("CREATE TABLE shadow_missed_signals (strategy_version TEXT, observed_at_ms INTEGER, reason TEXT)")
    c.execute("CREATE TABLE shadow_data_quality_events (observed_at_ms INTEGER, kind TEXT, severity TEXT)")
    c.execute("CREATE TABLE shadow_health_counters (name TEXT, value INTEGER)")
    c.execute(
        "CREATE TABLE shadow_latency_samples (observed_at_ms INTEGER, discovery_latency_ms REAL, market_data_latency_ms REAL, quote_latency_ms REAL, "
        "processing_latency_ms REAL, shadow_processing_latency_ms REAL)"
    )
    if with_ticks:
        for t in (1000, 2000, 3000, 4000):
            c.execute("INSERT INTO shadow_latency_samples VALUES (?, 500, 100, 50, 200, 1.5)", (t,))
            c.execute("INSERT INTO token_evaluations VALUES ('V1', ?, 1.0)", (t,))
        c.execute("INSERT INTO token_evaluations VALUES ('V1', 99999, 1.0)")  # outside the shadow window
        c.execute("INSERT INTO shadow_trades VALUES ('s1','V1','closed',1500,2500,0.01,'quick_tp',1000,0.001,0.001,NULL)")
        c.execute("INSERT INTO shadow_trades VALUES ('s2','V1','closed',99000,99500,0.5,'quick_tp',500,0.001,0.001,NULL)")  # outside window
        c.execute("INSERT INTO shadow_missed_signals VALUES ('V1', 2000, 'reentry_cooldown_active')")
        c.execute("INSERT INTO shadow_data_quality_events VALUES (2000, 'stale_market_data', 'warning')")
        for n, v in {"shadow_ticks_received": 4, "shadow_ticks_rejected_data_quality": 1, "quote_success": 3, "quote_error": 1, "missing_market_data": 0}.items():
            c.execute("INSERT INTO shadow_health_counters VALUES (?, ?)", (n, v))
    c.commit()
    c.close()
    return p


def bt(*trades):
    return BridgeBacktestResult("completed", "backtest-replay-v1", "x", 5, list(trades), [], "n")


def bt_trade(entry, pnl, reason="quick_tp", status="closed"):
    return {"status": status, "entryTimeMs": entry, "exitTimeMs": entry + 900, "pnlSol": pnl, "pnlPct": 1.0, "exitReason": reason,
            "holdDurationMs": 900, "entryFeesSol": 0.001, "exitFeesSol": 0.001, "mint": "m"}


def test_no_shadow_ticks_reports_insufficient_data_not_a_comparison(tmp_path):
    p = make_ledger(tmp_path, with_ticks=False)
    assert build_window_comparison(str(p), "V1", backtest_result=bt())["status"] == "insufficient_data"


def test_window_bounds_come_from_observed_shadow_ticks(tmp_path):
    p = make_ledger(tmp_path)
    with open_ledger_readonly(str(p)) as conn:
        assert shadow_window_bounds(conn, "V1") == (1000, 4000)


def test_both_sides_are_restricted_to_the_same_window(tmp_path):
    p = make_ledger(tmp_path)
    report = build_window_comparison(str(p), "V1", backtest_result=bt(bt_trade(1600, 0.02), bt_trade(90000, 9.0), bt_trade(3500, 0.0, status="open")))
    assert report["status"] == "completed"
    assert report["entries"] == {"shadow_closed": 1, "shadow_open": 0, "backtest_closed": 1, "backtest_open": 1}
    assert report["opportunities"]["logged_evaluations"] == 4  # the row at 99999 is outside the window
    assert report["shadow"]["net_simulated_pnl_sol"] == 0.01
    assert report["backtest"]["net_simulated_pnl_sol"] == 0.02


def test_report_labels_evidence_and_never_claims_profitability(tmp_path):
    p = make_ledger(tmp_path)
    report = build_window_comparison(str(p), "V1", backtest_result=bt(bt_trade(1600, 0.02), bt_trade(2600, -0.01, "dynamic_sl")))
    assert report["labels"]["explanations"] == "HYPOTHESIS"
    assert "SHADOW != LIVE TRADING" in report["note"]
    assert "not evidence of profitability" in report["note"]
    labels = {a["label"] for a in report["difference_analysis"]}
    assert labels <= {"OBSERVED", "CALCULATED", "ASSUMED", "HYPOTHESIS"}
    cats = {a["category"] for a in report["difference_analysis"]}
    assert {"data availability", "fill-model assumptions", "timing / exit timing", "quote difference"} <= cats
    assert report["exit_reasons"]["backtest"] == {"quick_tp": 1, "dynamic_sl": 1}
    assert report["data_quality"] == {"stale_market_data:warning": 1}
    assert report["missed_signals"] == {"reentry_cooldown_active": 1}
    assert report["observed_system_latency_ms"]["processing"] == 200
    assert "not measured" in report["assumed_execution"]  # assumed execution is never presented as measured latency
