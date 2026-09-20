"""Read-only access to the shared trade ledger written by the TS engine."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

from .schema_contract import DAILY_RISK_STATE_TABLE, TRADES_TABLE, TOKEN_EVALUATIONS_TABLE


@contextmanager
def open_ledger_readonly(db_path: str) -> Iterator[sqlite3.Connection]:
    """Opens the ledger file in read-only mode (uri=True + mode=ro).

    Read-only because this package must never write into the engine's
    ledger -- any future learning-pipeline writes belong in their own
    tables/columns, added deliberately, not through ad hoc connections here.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


@dataclass(frozen=True)
class TradeSummary:
    total_trades: int
    closed_trades: int
    wins: int
    losses: int
    total_pnl_sol: float

    @property
    def win_rate(self) -> float | None:
        if self.closed_trades == 0:
            return None
        return self.wins / self.closed_trades


def get_trade_summary(conn: sqlite3.Connection) -> TradeSummary:
    total_trades = conn.execute(f"SELECT COUNT(*) FROM {TRADES_TABLE}").fetchone()[0]
    row = conn.execute(
        f"""
        SELECT
            COUNT(*) AS closed_trades,
            SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN pnl_sol <= 0 THEN 1 ELSE 0 END) AS losses,
            COALESCE(SUM(pnl_sol), 0) AS total_pnl_sol
        FROM {TRADES_TABLE}
        WHERE status = 'closed'
        """
    ).fetchone()
    return TradeSummary(
        total_trades=total_trades,
        closed_trades=row["closed_trades"] or 0,
        wins=row["wins"] or 0,
        losses=row["losses"] or 0,
        total_pnl_sol=row["total_pnl_sol"] or 0.0,
    )


def get_daily_risk_states(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        f"SELECT * FROM {DAILY_RISK_STATE_TABLE} ORDER BY trading_date_utc DESC"
    ).fetchall()


def get_closed_trades(conn: sqlite3.Connection, strategy_version: str | None = None) -> list[dict]:
    """All closed trades as plain dicts, ordered by entry_time_ms ascending
    (chronological order matters -- callers doing time-based train/validation/
    out-of-sample splits, drawdown, or consecutive-loss-streak calculations
    all depend on this ordering; see learning/validation.py's temporal split).
    """
    query = f"SELECT * FROM {TRADES_TABLE} WHERE status = 'closed'"
    params: tuple = ()
    if strategy_version is not None:
        query += " AND strategy_version = ?"
        params = (strategy_version,)
    query += " ORDER BY entry_time_ms ASC"
    rows = conn.execute(query, params).fetchall()
    return [dict(row) for row in rows]


def get_token_evaluations(conn: sqlite3.Connection, strategy_version: str | None = None) -> list[dict]:
    """Every scored token (traded or not) -- what pattern discovery needs to
    tell "we saw this condition and skipped it" apart from "we saw this
    condition and it lost money"."""
    query = f"SELECT * FROM {TOKEN_EVALUATIONS_TABLE}"
    params: tuple = ()
    if strategy_version is not None:
        query += " WHERE strategy_version = ?"
        params = (strategy_version,)
    query += " ORDER BY evaluated_at_ms ASC"
    rows = conn.execute(query, params).fetchall()
    return [dict(row) for row in rows]
