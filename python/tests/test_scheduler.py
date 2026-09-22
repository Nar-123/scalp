import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.schema_contract import TRADES_COLUMNS, TRADES_TABLE
from learning.scheduler import run_scheduler_loop, run_scheduler_once


_NUMERIC_COLUMNS = {"reentry_index", "entry_time_ms", "pnl_sol"}


def make_ledger_with_trades(tmp_path: Path, count: int) -> Path:
    import sqlite3

    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} {'REAL' if col in _NUMERIC_COLUMNS else 'TEXT'}" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    for i in range(count):
        row = {col: None for col in TRADES_COLUMNS}
        row.update({"id": f"t{i}", "mint": f"m{i}", "strategy_version": "V1", "status": "closed", "entry_time_ms": float(i * 1000), "reentry_index": 0.0, "pnl_sol": 0.01})
        placeholders = ", ".join("?" for _ in TRADES_COLUMNS)
        conn.execute(f"INSERT INTO {TRADES_TABLE} VALUES ({placeholders})", [row[c] for c in TRADES_COLUMNS])
    conn.commit()
    conn.close()
    return db_path


def test_run_scheduler_once_defaults_to_incremental_and_triggers_scheduled(tmp_path):
    db_path = make_ledger_with_trades(tmp_path, 60)
    tick = run_scheduler_once(str(db_path), strategy_version="V1")
    assert tick.result.status == "completed"
    assert tick.ran_at_ms > 0


def test_run_scheduler_loop_runs_the_requested_number_of_iterations_without_a_real_sleep(tmp_path):
    db_path = make_ledger_with_trades(tmp_path, 60)
    sleeps: list[float] = []
    ticks = []

    run_scheduler_loop(
        str(db_path),
        strategy_version="V1",
        interval_sec=3600,
        max_iterations=3,
        sleep_fn=sleeps.append,
        on_tick=ticks.append,
    )

    assert len(ticks) == 3
    assert sleeps == [3600, 3600]  # never sleeps after the LAST iteration
    # incremental=True by default -- only the first tick finds new data.
    assert ticks[0].result.status == "completed"
    assert ticks[1].result.status == "no_new_data"
    assert ticks[2].result.status == "no_new_data"


def test_run_scheduler_loop_default_interval_matches_spec_default_of_one_hour():
    from learning.scheduler import DEFAULT_INTERVAL_SEC

    assert DEFAULT_INTERVAL_SEC == 3600
