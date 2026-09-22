import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.reader import open_ledger_readonly
from analytics.schema_contract import TRADES_COLUMNS, TRADES_TABLE
from learning.db import (
    complete_learning_run,
    get_last_processed_watermark_ms,
    has_running_learning_run,
    open_learning_db,
    record_candidate,
    record_feature_snapshot,
    record_validation_result,
    start_learning_run,
    update_candidate_status,
    update_strategy_validation_status,
)


def make_bare_ledger(tmp_path: Path) -> Path:
    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} TEXT" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    conn.commit()
    conn.close()
    return db_path


def test_open_learning_db_creates_all_five_tables_idempotently(tmp_path):
    db_path = make_bare_ledger(tmp_path)

    with open_learning_db(str(db_path)) as conn:
        tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

    assert {
        "strategy_versions",
        "feature_snapshots",
        "learning_runs",
        "candidate_strategies",
        "validation_results",
    }.issubset(tables)
    assert "trades" in tables  # the pre-existing trading-truth table is untouched


def test_open_learning_db_is_idempotent_across_repeated_calls(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)):
        pass
    with open_learning_db(str(db_path)):  # must not raise "table already exists"
        pass


def test_learning_tables_never_shadow_or_duplicate_the_trade_ledger(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        count = conn.execute(f"SELECT COUNT(*) FROM {TRADES_TABLE}").fetchone()[0]
        assert count == 0  # untouched, not duplicated into a learning table


def test_record_and_read_back_a_candidate(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        start_learning_run(conn, "run_1", "manual", started_at_ms=1000)
        record_candidate(
            conn,
            {
                "candidate_id": "cand_1",
                "parent_strategy": "V1",
                "changes": {"min_price_velocity_5s": 1.5},
                "reason": "test",
                "evidence": "test",
                "sample_size": 150,
                "created_at_ms": 1000,
            },
            learning_run_id="run_1",
        )
        row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", ("cand_1",)).fetchone()
        assert row["status"] == "pending"
        assert row["learning_run_id"] == "run_1"


def test_record_validation_result_and_feature_snapshot(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        record_validation_result(
            conn, "val_1", "cand_1", stage="backtest", passed=True, metrics={"win_rate": 0.6}, sample_size=300, created_at_ms=1000
        )
        record_feature_snapshot(
            conn,
            "feat_1",
            trade_id="trade_1",
            computed_at_ms=1000,
            buckets={"liquidity_bucket": "20-30_SOL"},
            features={"entry_liquidity_sol": 25},
        )
        val_row = conn.execute("SELECT * FROM validation_results WHERE id = ?", ("val_1",)).fetchone()
        feat_row = conn.execute("SELECT * FROM feature_snapshots WHERE id = ?", ("feat_1",)).fetchone()
        assert val_row["passed"] == 1
        assert feat_row["liquidity_bucket"] == "20-30_SOL"


def test_strategy_version_lifecycle(tmp_path):
    from learning.db import record_strategy_version

    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        record_strategy_version(conn, "V1", None, {"min_liquidity": 20}, created_at_ms=1000, reason="baseline")
        update_strategy_validation_status(conn, "V1", "validated")
        row = conn.execute("SELECT * FROM strategy_versions WHERE version = ?", ("V1",)).fetchone()
        assert row["validation_status"] == "validated"
        assert row["parent_version"] is None


def test_concurrent_read_and_write_connections_to_the_same_file(tmp_path):
    """Task 25 'concurrent read safety': a read-only connection to the
    trade ledger and a read-write connection to the learning tables, both
    open against the SAME file at the SAME time, must not corrupt or block
    each other under WAL mode."""
    db_path = make_bare_ledger(tmp_path)

    # Prime WAL mode via a learning-db open/close first (mirrors what the
    # TS engine also does at startup).
    with open_learning_db(str(db_path)):
        pass

    with open_ledger_readonly(str(db_path)) as read_conn, open_learning_db(str(db_path)) as write_conn:
        # Reader can query the trading-truth table...
        read_conn.execute(f"SELECT COUNT(*) FROM {TRADES_TABLE}").fetchone()
        # ...while the writer concurrently writes to its own tables...
        start_learning_run(write_conn, "run_concurrent", "manual", started_at_ms=int(time.time() * 1000))
        # ...and the reader can still read afterward, unaffected.
        count = read_conn.execute(f"SELECT COUNT(*) FROM {TRADES_TABLE}").fetchone()[0]
        assert count == 0

    with open_learning_db(str(db_path)) as conn:
        row = conn.execute("SELECT * FROM learning_runs WHERE id = ?", ("run_concurrent",)).fetchone()
        assert row is not None


def test_learning_runs_gains_phase_3_alt_columns_idempotently(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)):
        pass
    with open_learning_db(str(db_path)) as conn:  # second open must not raise "duplicate column"
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(learning_runs)").fetchall()}
    assert {
        "data_range_start_ms",
        "data_range_end_ms",
        "candidates_tested",
        "candidates_passed",
        "candidates_rejected",
        "error",
    }.issubset(columns)


def test_complete_learning_run_persists_granular_fields(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        start_learning_run(conn, "run_1", "manual", started_at_ms=1000)
        complete_learning_run(
            conn,
            "run_1",
            completed_at_ms=2000,
            sample_size=300,
            strategy_version="V1",
            summary={"patterns_found": 2},
            data_range_start_ms=1_000,
            data_range_end_ms=50_000,
            candidates_tested=3,
            candidates_passed=1,
            candidates_rejected=2,
        )
        row = conn.execute("SELECT * FROM learning_runs WHERE id = ?", ("run_1",)).fetchone()
        assert row["data_range_start_ms"] == 1_000
        assert row["data_range_end_ms"] == 50_000
        assert row["candidates_tested"] == 3
        assert row["candidates_passed"] == 1
        assert row["candidates_rejected"] == 2
        assert row["error"] is None


def test_has_running_learning_run_true_only_for_a_recent_running_row(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        assert has_running_learning_run(conn, now_ms=10_000) is False

        start_learning_run(conn, "run_1", "manual", started_at_ms=10_000)
        assert has_running_learning_run(conn, now_ms=10_500) is True

        # A "running" row older than stale_after_ms is treated as an orphan
        # from a crashed process, not as still blocking new runs.
        assert has_running_learning_run(conn, now_ms=10_000 + 700_000, stale_after_ms=600_000) is False

        complete_learning_run(conn, "run_1", completed_at_ms=10_600, sample_size=0, strategy_version="V1", summary={})
        assert has_running_learning_run(conn, now_ms=10_700) is False


def test_get_last_processed_watermark_ms_tracks_completed_runs_only(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        assert get_last_processed_watermark_ms(conn, "V1") is None

        start_learning_run(conn, "run_1", "manual", started_at_ms=1_000)
        complete_learning_run(
            conn, "run_1", completed_at_ms=2_000, sample_size=10, strategy_version="V1",
            summary={}, data_range_start_ms=100, data_range_end_ms=5_000,
        )
        assert get_last_processed_watermark_ms(conn, "V1") == 5_000

        # A still-running run's data range must not count as "processed" yet.
        start_learning_run(conn, "run_2", "manual", started_at_ms=6_000)
        assert get_last_processed_watermark_ms(conn, "V1") == 5_000

        complete_learning_run(
            conn, "run_2", completed_at_ms=7_000, sample_size=20, strategy_version="V1",
            summary={}, data_range_start_ms=100, data_range_end_ms=9_000,
        )
        assert get_last_processed_watermark_ms(conn, "V1") == 9_000

        # A different strategy version's completed runs never affect this one's watermark.
        assert get_last_processed_watermark_ms(conn, "V2") is None


def test_update_candidate_status_sets_rejected_flag_and_reason(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        record_candidate(
            conn,
            {"candidate_id": "cand_1", "parent_strategy": "V1", "changes": {}, "sample_size": 300, "created_at_ms": 1},
        )
        update_candidate_status(conn, "cand_1", "rejected", rejection_reason="Failed stage(s): backtest")
        row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", ("cand_1",)).fetchone()
        assert row["status"] == "rejected"
        assert row["rejected"] == 1
        assert row["rejection_reason"] == "Failed stage(s): backtest"

        update_candidate_status(conn, "cand_1", "promoted")
        row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", ("cand_1",)).fetchone()
        assert row["status"] == "promoted"
        assert row["rejected"] == 0
