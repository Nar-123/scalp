import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import learning.candidate_pipeline as candidate_pipeline
from analytics.schema_contract import TRADES_COLUMNS, TRADES_TABLE
from learning.backtest_bridge import BridgeBacktestResult
from learning.candidate_pipeline import run_and_persist_candidate_backtest, run_candidate_backtest_stages
from learning.db import open_learning_db


def _make_trades(count: int, pnl_sol: float, start_ms: int = 0, step_ms: int = 1000) -> list[dict]:
    trades = []
    for i in range(count):
        entry = start_ms + i * step_ms
        trades.append(
            {
                "status": "closed",
                "entryTimeMs": entry,
                "exitTimeMs": entry + 500,
                "pnlSol": pnl_sol,
                "pnlPct": 1.0 if pnl_sol > 0 else -1.0,
                "exitReason": "quick_tp" if pnl_sol > 0 else "dynamic_sl",
            }
        )
    return trades


def make_bare_ledger(tmp_path: Path) -> Path:
    import sqlite3

    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} TEXT" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    conn.commit()
    conn.close()
    return db_path


def test_insufficient_data_from_the_bridge_produces_a_single_pending_backtest_stage(monkeypatch, tmp_path):
    def fake_run_ts_backtest(*args, **kwargs):
        return BridgeBacktestResult(
            status="insufficient_data", simulator_version="v1", strategy_label="cand-a",
            sample_size_snapshots=0, trades=[], data_quality_issues=[], notes="no data",
        )

    monkeypatch.setattr(candidate_pipeline, "run_ts_backtest", fake_run_ts_backtest)

    results = run_candidate_backtest_stages(str(tmp_path / "ledger.sqlite"), "cand_1", "cand-a", {})
    assert len(results) == 1
    assert results[0].stage == "backtest"
    assert results[0].passed is None


def test_below_minimum_sample_size_is_insufficient_not_a_failure(monkeypatch, tmp_path):
    def fake_run_ts_backtest(*args, **kwargs):
        return BridgeBacktestResult(
            status="completed", simulator_version="v1", strategy_label="cand-a",
            sample_size_snapshots=100, trades=_make_trades(50, 0.01), data_quality_issues=[], notes="ok",
        )

    monkeypatch.setattr(candidate_pipeline, "run_ts_backtest", fake_run_ts_backtest)

    results = run_candidate_backtest_stages(str(tmp_path / "ledger.sqlite"), "cand_1", "cand-a", {})
    assert len(results) == 1
    assert results[0].passed is None
    assert "INSUFFICIENT_DATA" in results[0].notes


def test_sufficient_winning_sample_passes_backtest_and_out_of_sample(monkeypatch, tmp_path):
    def fake_run_ts_backtest(*args, **kwargs):
        return BridgeBacktestResult(
            status="completed", simulator_version="v1", strategy_label="cand-a",
            sample_size_snapshots=1000, trades=_make_trades(310, 0.01), data_quality_issues=[], notes="ok",
        )

    monkeypatch.setattr(candidate_pipeline, "run_ts_backtest", fake_run_ts_backtest)

    results = run_candidate_backtest_stages(str(tmp_path / "ledger.sqlite"), "cand_1", "cand-a", {})
    assert [r.stage for r in results] == ["backtest", "out_of_sample"]
    assert results[0].passed is True
    assert results[1].passed is True
    assert results[0].metrics["training_period"] is not None
    assert results[1].metrics["oos_period"] is not None


def test_sufficient_losing_sample_fails_backtest_stage(monkeypatch, tmp_path):
    def fake_run_ts_backtest(*args, **kwargs):
        return BridgeBacktestResult(
            status="completed", simulator_version="v1", strategy_label="cand-a",
            sample_size_snapshots=1000, trades=_make_trades(310, -0.01), data_quality_issues=[], notes="ok",
        )

    monkeypatch.setattr(candidate_pipeline, "run_ts_backtest", fake_run_ts_backtest)

    results = run_candidate_backtest_stages(str(tmp_path / "ledger.sqlite"), "cand_1", "cand-a", {})
    assert results[0].passed is False


def test_still_open_positions_are_excluded_from_the_sample(monkeypatch, tmp_path):
    trades = _make_trades(310, 0.01)
    trades.append({"status": "still_open_at_end_of_data", "entryTimeMs": 999_999_999, "exitTimeMs": None, "pnlSol": None, "pnlPct": None, "exitReason": None})

    def fake_run_ts_backtest(*args, **kwargs):
        return BridgeBacktestResult(
            status="completed", simulator_version="v1", strategy_label="cand-a",
            sample_size_snapshots=1000, trades=trades, data_quality_issues=[], notes="ok",
        )

    monkeypatch.setattr(candidate_pipeline, "run_ts_backtest", fake_run_ts_backtest)

    results = run_candidate_backtest_stages(str(tmp_path / "ledger.sqlite"), "cand_1", "cand-a", {})
    # 310 closed trades split 60/20/20 -> train=186, validation=62 (unused by
    # either stage), oos=62; the still-open position is excluded entirely.
    total_sample = results[0].sample_size + results[1].sample_size
    assert total_sample == 186 + 62


def test_run_and_persist_candidate_backtest_records_rows_and_stays_pending_without_shadow(monkeypatch, tmp_path):
    def fake_run_ts_backtest(*args, **kwargs):
        return BridgeBacktestResult(
            status="completed", simulator_version="v1", strategy_label="cand-a",
            sample_size_snapshots=1000, trades=_make_trades(310, 0.01), data_quality_issues=[], notes="ok",
        )

    monkeypatch.setattr(candidate_pipeline, "run_ts_backtest", fake_run_ts_backtest)

    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        decision = run_and_persist_candidate_backtest(conn, str(db_path), "cand_1", "cand-a", {})

        rows = conn.execute("SELECT * FROM validation_results WHERE candidate_id = ?", ("cand_1",)).fetchall()
        assert {row["stage"] for row in rows} == {"backtest", "out_of_sample"}
        assert decision.overall == "pending"  # shadow never ran -- promotion gate correctly withholds "pass"
