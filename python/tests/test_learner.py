import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.schema_contract import TRADES_COLUMNS, TRADES_TABLE
from learning.db import open_learning_db, start_learning_run
from learning.learner import run_learning_cycle

# Matches the REAL column types in engine/src/ledger/migrations/001_init.ts
# (mostly REAL for numeric entry_*/pnl fields, INTEGER for counters/ms
# timestamps) -- using blanket TEXT here would let SQLite's TEXT-affinity
# coercion silently turn inserted numbers into strings, masking exactly the
# kind of cross-language type mismatch a schema-compatibility test exists
# to catch. See test_schema_compatibility.py for the column-name check.
_NUMERIC_COLUMNS = {
    "reentry_index",
    "entry_time_ms",
    "entry_price_sol",
    "entry_size_sol",
    "entry_token_age_sec",
    "entry_liquidity_sol",
    "entry_volume_1m_sol",
    "entry_buy_sell_ratio",
    "entry_price_velocity_5s_pct",
    "entry_volume_acceleration_x",
    "entry_score",
    "expected_net_edge_pct",
    "entry_slippage_pct",
    "entry_price_impact_pct",
    "entry_fees_sol",
    "daily_realized_pnl_sol_at_entry",
    "exit_time_ms",
    "exit_price_sol",
    "exit_fees_sol",
    "exit_slippage_pct",
    "hold_duration_ms",
    "pnl_sol",
    "pnl_pct",
    "max_favorable_excursion_pct",
    "max_adverse_excursion_pct",
    "daily_realized_pnl_sol_at_exit",
    "created_at_ms",
    "updated_at_ms",
}


def make_ledger_with_trades(tmp_path: Path, trades: list[dict]) -> Path:
    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} {'REAL' if col in _NUMERIC_COLUMNS else 'TEXT'}" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")

    for i, overrides in enumerate(trades):
        row = {col: None for col in TRADES_COLUMNS}
        row.update(
            {
                "id": f"trade_{i}",
                "mint": f"mint_{i}",
                "strategy_version": "V1",
                "status": "closed",
                "entry_time_ms": i * 1000,
                "reentry_index": 0,
            }
        )
        row.update({k: (float(v) if k in _NUMERIC_COLUMNS and v is not None else v) for k, v in overrides.items()})
        placeholders = ", ".join("?" for _ in TRADES_COLUMNS)
        conn.execute(f"INSERT INTO {TRADES_TABLE} VALUES ({placeholders})", [row[c] for c in TRADES_COLUMNS])

    conn.commit()
    conn.close()
    return db_path


def test_learning_cycle_skips_when_sample_too_small(tmp_path):
    trades = [{"pnl_sol": 0.01} for _ in range(10)]
    db_path = make_ledger_with_trades(tmp_path, trades)

    result = run_learning_cycle(str(db_path), strategy_version="V1")
    assert result.status == "insufficient_sample"
    assert result.sample_size == 10
    assert result.candidates_generated == 0


def test_learning_cycle_runs_and_records_a_run_row(tmp_path):
    trades = [{"pnl_sol": 0.01} for _ in range(60)]
    db_path = make_ledger_with_trades(tmp_path, trades)

    result = run_learning_cycle(str(db_path), strategy_version="V1", trigger="manual")
    assert result.status == "completed"
    assert result.sample_size == 60

    with open_learning_db(str(db_path)) as conn:
        row = conn.execute("SELECT * FROM learning_runs WHERE id = ?", (result.run_id,)).fetchone()
        assert row is not None
        assert row["status"] == "completed"
        assert row["sample_size"] == 60
        assert row["trigger"] == "manual"


def test_learning_cycle_never_writes_to_the_trades_table(tmp_path):
    trades = [{"pnl_sol": 0.01} for _ in range(60)]
    db_path = make_ledger_with_trades(tmp_path, trades)

    before = sqlite3.connect(db_path).execute(f"SELECT COUNT(*) FROM {TRADES_TABLE}").fetchone()[0]
    run_learning_cycle(str(db_path), strategy_version="V1")
    after = sqlite3.connect(db_path).execute(f"SELECT COUNT(*) FROM {TRADES_TABLE}").fetchone()[0]
    assert before == after == 60


def test_learning_cycle_produces_candidates_only_as_pending(tmp_path):
    high_liquidity_wins = [{"pnl_sol": 0.05, "entry_liquidity_sol": "150", "entry_price_velocity_5s_pct": "4"} for _ in range(60)]
    low_liquidity_losses = [{"pnl_sol": -0.02, "entry_liquidity_sol": "25", "entry_price_velocity_5s_pct": "1.2"} for _ in range(60)]
    db_path = make_ledger_with_trades(tmp_path, high_liquidity_wins + low_liquidity_losses)

    result = run_learning_cycle(str(db_path), strategy_version="V1")
    assert result.status == "completed"

    with open_learning_db(str(db_path)) as conn:
        rows = conn.execute("SELECT * FROM candidate_strategies WHERE learning_run_id = ?", (result.run_id,)).fetchall()
        for row in rows:
            assert row["status"] == "pending"
            assert row["rejected"] == 0


def test_learning_cycle_records_data_range_from_the_trades_it_processed(tmp_path):
    trades = [{"pnl_sol": 0.01, "entry_time_ms": i * 1000} for i in range(60)]
    db_path = make_ledger_with_trades(tmp_path, trades)

    result = run_learning_cycle(str(db_path), strategy_version="V1")

    with open_learning_db(str(db_path)) as conn:
        row = conn.execute("SELECT * FROM learning_runs WHERE id = ?", (result.run_id,)).fetchone()
        assert row["data_range_start_ms"] == 0
        assert row["data_range_end_ms"] == 59_000


def test_learning_cycle_refuses_to_start_while_another_run_is_in_flight(tmp_path):
    trades = [{"pnl_sol": 0.01} for _ in range(60)]
    db_path = make_ledger_with_trades(tmp_path, trades)

    with open_learning_db(str(db_path)) as conn:
        start_learning_run(conn, "run_stuck", "manual", started_at_ms=int(time.time() * 1000))

    result = run_learning_cycle(str(db_path), strategy_version="V1")
    assert result.status == "already_running"
    assert result.run_id is None

    with open_learning_db(str(db_path)) as conn:
        rows = conn.execute("SELECT id FROM learning_runs").fetchall()
        assert [r["id"] for r in rows] == ["run_stuck"]  # no duplicate run row was written


def test_learning_cycle_incremental_skips_when_no_new_data_since_last_completed_run(tmp_path):
    trades = [{"pnl_sol": 0.01, "entry_time_ms": i * 1000} for i in range(60)]
    db_path = make_ledger_with_trades(tmp_path, trades)

    first = run_learning_cycle(str(db_path), strategy_version="V1", incremental=True)
    assert first.status == "completed"

    second = run_learning_cycle(str(db_path), strategy_version="V1", incremental=True)
    assert second.status == "no_new_data"
    assert second.run_id is None

    with open_learning_db(str(db_path)) as conn:
        rows = conn.execute("SELECT id FROM learning_runs").fetchall()
        assert len(rows) == 1  # the skipped incremental check never wrote a second run row


def test_learning_cycle_incremental_runs_again_once_new_trades_exist(tmp_path):
    trades = [{"pnl_sol": 0.01, "entry_time_ms": i * 1000} for i in range(60)]
    db_path = make_ledger_with_trades(tmp_path, trades)
    first = run_learning_cycle(str(db_path), strategy_version="V1", incremental=True)
    assert first.status == "completed"

    conn = sqlite3.connect(db_path)
    for i in range(60):
        row = {col: None for col in TRADES_COLUMNS}
        row.update(
            {
                "id": f"trade_extra_{i}",
                "mint": f"mint_extra_{i}",
                "strategy_version": "V1",
                "status": "closed",
                "entry_time_ms": float(60_000 + i * 1000),
                "reentry_index": 0.0,
                "pnl_sol": 0.01,
            }
        )
        placeholders = ", ".join("?" for _ in TRADES_COLUMNS)
        conn.execute(f"INSERT INTO {TRADES_TABLE} VALUES ({placeholders})", [row[c] for c in TRADES_COLUMNS])
    conn.commit()
    conn.close()

    second = run_learning_cycle(str(db_path), strategy_version="V1", incremental=True)
    assert second.status == "completed"
    assert second.sample_size == 120
