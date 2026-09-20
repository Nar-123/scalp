import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.reader import get_daily_risk_states, get_trade_summary, open_ledger_readonly
from analytics.schema_contract import DAILY_RISK_STATE_TABLE, TRADES_COLUMNS, TRADES_TABLE


def make_ledger(tmp_path: Path) -> Path:
    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} TEXT" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    conn.execute(
        f"CREATE TABLE {DAILY_RISK_STATE_TABLE} ("
        "trading_date_utc TEXT PRIMARY KEY, starting_balance_sol REAL, "
        "realized_pnl_sol REAL, circuit_breaker_triggered INTEGER)"
    )

    def insert_trade(status: str, pnl_sol: float | None) -> None:
        placeholders = ", ".join("?" for _ in TRADES_COLUMNS)
        values = [None] * len(TRADES_COLUMNS)
        values[TRADES_COLUMNS.index("status")] = status
        values[TRADES_COLUMNS.index("pnl_sol")] = pnl_sol
        conn.execute(f"INSERT INTO {TRADES_TABLE} VALUES ({placeholders})", values)

    insert_trade("closed", 0.01)
    insert_trade("closed", -0.02)
    insert_trade("closed", 0.03)
    insert_trade("open", None)

    conn.execute(
        f"INSERT INTO {DAILY_RISK_STATE_TABLE} VALUES (?, ?, ?, ?)",
        ("2026-01-01", 10.0, 0.02, 0),
    )
    conn.commit()
    conn.close()
    return db_path


def test_open_ledger_readonly_and_trade_summary(tmp_path: Path) -> None:
    db_path = make_ledger(tmp_path)
    with open_ledger_readonly(str(db_path)) as conn:
        summary = get_trade_summary(conn)

    assert summary.total_trades == 4
    assert summary.closed_trades == 3
    assert summary.wins == 2
    assert summary.losses == 1
    assert summary.total_pnl_sol == pytest.approx(0.02)
    assert summary.win_rate == pytest.approx(2 / 3)


def test_get_daily_risk_states(tmp_path: Path) -> None:
    db_path = make_ledger(tmp_path)
    with open_ledger_readonly(str(db_path)) as conn:
        rows = get_daily_risk_states(conn)

    assert len(rows) == 1
    assert rows[0]["trading_date_utc"] == "2026-01-01"
    assert rows[0]["circuit_breaker_triggered"] == 0


def test_readonly_connection_cannot_write(tmp_path: Path) -> None:
    db_path = make_ledger(tmp_path)
    with open_ledger_readonly(str(db_path)) as conn:
        try:
            conn.execute(f"DELETE FROM {TRADES_TABLE}")
            conn.commit()
            assert False, "expected a write attempt on a read-only connection to fail"
        except sqlite3.OperationalError:
            pass


def test_trade_summary_with_no_trades_has_no_win_rate(tmp_path: Path) -> None:
    db_path = tmp_path / "empty.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} TEXT" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    conn.execute(
        f"CREATE TABLE {DAILY_RISK_STATE_TABLE} ("
        "trading_date_utc TEXT PRIMARY KEY, starting_balance_sol REAL, "
        "realized_pnl_sol REAL, circuit_breaker_triggered INTEGER)"
    )
    conn.commit()
    conn.close()

    with open_ledger_readonly(str(db_path)) as conn:
        summary = get_trade_summary(conn)

    assert summary.total_trades == 0
    assert summary.win_rate is None
