import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.reader import get_shadow_closed_trades, get_shadow_missed_signal_counts, open_ledger_readonly
from analytics.schema_contract import SHADOW_TRADES_COLUMNS
from learning.db import open_learning_db, record_candidate
from learning.promotion import evaluate_promotion
from learning.shadow import compare_backtest_vs_shadow, evaluate_shadow_stage, persist_shadow_stage, shadow_thresholds

HOUR = 3_600_000


def shadow_trade(i, pnl, start=0, step=1000, reason="quick_tp"):
    return {
        "entry_time_ms": start + i * step, "exit_time_ms": start + i * step + 500, "pnl_sol": pnl,
        "exit_reason": reason, "hold_duration_ms": 500, "entry_fees_sol": 0.001, "exit_fees_sol": 0.001,
    }


def make_shadow_ledger(tmp_path: Path) -> Path:
    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    numeric = {"reentry_index", "entry_time_ms", "entry_price_sol", "entry_size_sol", "entry_filled_amount_sol", "entry_fees_sol",
               "entry_score", "expected_net_edge_pct", "entry_liquidity_sol", "exit_time_ms", "exit_price_sol", "exit_fees_sol",
               "pnl_sol", "pnl_pct", "hold_duration_ms", "max_favorable_excursion_pct", "max_adverse_excursion_pct", "created_at_ms", "updated_at_ms"}
    cols = ", ".join(f"{c} {'REAL' if c in numeric else 'TEXT'}" for c in SHADOW_TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE shadow_trades ({cols})")
    conn.execute("CREATE TABLE shadow_missed_signals (id TEXT, strategy_version TEXT, mint TEXT, observed_at_ms INTEGER, reason TEXT, detail TEXT)")
    for i, (sv, status) in enumerate([("V1", "closed"), ("V1", "open"), ("V2", "closed")]):
        row = {c: None for c in SHADOW_TRADES_COLUMNS}
        row.update(trade_id=f"t{i}", strategy_version=sv, execution_mode="shadow", simulator_version="x", mint="m", status=status,
                   entry_time_ms=float(i), pnl_sol=0.01)
        conn.execute(f"INSERT INTO shadow_trades VALUES ({','.join('?' * len(SHADOW_TRADES_COLUMNS))})", [row[c] for c in SHADOW_TRADES_COLUMNS])
    conn.executemany("INSERT INTO shadow_missed_signals VALUES (?,?,?,?,?,?)", [
        ("a", "V1", "m", 1, "reentry_cooldown_active", ""), ("b", "V1", "m", 2, "reentry_cooldown_active", ""),
        ("c", "V1", "m", 3, "max_total_exposure_reached", ""), ("d", "V2", "m", 4, "x", ""),
    ])
    conn.commit()
    conn.close()
    return db_path


class TestShadowReader:
    def test_returns_only_closed_trades_for_the_requested_strategy_version(self, tmp_path):
        db = make_shadow_ledger(tmp_path)
        with open_ledger_readonly(str(db)) as conn:
            trades = get_shadow_closed_trades(conn, "V1")
        assert [t["trade_id"] for t in trades] == ["t0"]
        assert trades[0]["execution_mode"] == "shadow"

    def test_counts_missed_signals_by_reason_per_strategy(self, tmp_path):
        db = make_shadow_ledger(tmp_path)
        with open_ledger_readonly(str(db)) as conn:
            assert get_shadow_missed_signal_counts(conn, "V1") == {"reentry_cooldown_active": 2, "max_total_exposure_reached": 1}


class TestComparison:
    def test_labels_every_section_and_never_claims_equality_or_profitability(self):
        bt = [shadow_trade(i, 0.01) for i in range(10)]
        sh = [shadow_trade(i, 0.005) for i in range(8)]
        report = compare_backtest_vs_shadow(bt, sh)
        assert report["labels"]["explanations"] == "HYPOTHESIS"
        assert report["labels"]["statistics"] == "CALCULATED"
        assert "SIMULATED" in report["labels"]["shadow"]
        assert report["differences"]["trades"] == -2
        assert report["differences"]["net_simulated_pnl_sol"] == pytest.approx(0.04 - 0.10)
        assert all(h.startswith("HYPOTHESIS") for h in report["hypotheses"])
        assert "profitab" in report["note"]  # explicitly disclaims profitability

    def test_handles_an_empty_side_without_fabricating_numbers(self):
        report = compare_backtest_vs_shadow([shadow_trade(0, 0.01)], [])
        assert report["shadow"]["trades"] == 0
        assert report["shadow"]["win_rate"] is None
        assert report["differences"]["win_rate"] is None


class TestShadowStage:
    def test_thresholds_are_configurable_via_environment(self):
        assert shadow_thresholds({"SHADOW_MIN_DURATION_HOURS": "6", "SHADOW_MIN_TRADES": "40"}) == (6.0, 40)

    def test_insufficient_trades_is_none_not_a_failure(self):
        r = evaluate_shadow_stage([shadow_trade(i, 0.01, step=HOUR) for i in range(5)], min_duration_hours=1, min_trades=10)
        assert r.passed is None and "INSUFFICIENT_DATA" in r.notes

    def test_insufficient_duration_is_none_even_with_enough_trades(self):
        r = evaluate_shadow_stage([shadow_trade(i, 0.01, step=1000) for i in range(50)], min_duration_hours=24, min_trades=10)
        assert r.passed is None

    def test_passes_only_with_both_thresholds_met_and_positive_simulated_avg(self):
        winners = [shadow_trade(i, 0.01, step=HOUR) for i in range(30)]
        assert evaluate_shadow_stage(winners, min_duration_hours=24, min_trades=10).passed is True
        losers = [shadow_trade(i, -0.01, step=HOUR) for i in range(30)]
        assert evaluate_shadow_stage(losers, min_duration_hours=24, min_trades=10).passed is False

    def test_result_wording_is_simulated_never_a_profitability_claim(self):
        r = evaluate_shadow_stage([shadow_trade(i, 0.01, step=HOUR) for i in range(30)], min_duration_hours=1, min_trades=10)
        assert "SIMULATED" in r.notes and "simulated net PnL" in r.notes
        assert "is profitable" not in r.notes


class TestPromotionIntegration:
    def _bare(self, tmp_path):
        p = tmp_path / "l.sqlite"
        sqlite3.connect(p).close()
        return p

    def test_shadow_pass_alone_never_promotes(self, tmp_path):
        p = self._bare(tmp_path)
        with open_learning_db(str(p)) as conn:
            record_candidate(conn, {"candidate_id": "c1", "parent_strategy": "V1", "changes": {}, "sample_size": 300, "created_at_ms": 1})
            result = evaluate_shadow_stage([shadow_trade(i, 0.01, step=HOUR) for i in range(30)], min_duration_hours=1, min_trades=10)
            persist_shadow_stage(conn, "c1", result)
            rows = [dict(r) for r in conn.execute("SELECT * FROM validation_results")]
            decision = evaluate_promotion("c1", rows)
            status = conn.execute("SELECT status FROM candidate_strategies WHERE candidate_id='c1'").fetchone()["status"]
        assert decision.stage_statuses["shadow"] == "pass"
        assert decision.overall == "pending"  # backtest and out_of_sample still missing
        assert status == "pending"

    def test_insufficient_shadow_data_keeps_the_stage_pending(self, tmp_path):
        p = self._bare(tmp_path)
        with open_learning_db(str(p)) as conn:
            result = evaluate_shadow_stage([shadow_trade(0, 0.01)], min_duration_hours=24, min_trades=100)
            persist_shadow_stage(conn, "c1", result)
            rows = [dict(r) for r in conn.execute("SELECT * FROM validation_results")]
        assert evaluate_promotion("c1", rows).stage_statuses["shadow"] == "pending"
