"""Cross-language schema compatibility (Phase 2 task 25 -- DATABASE tests).

Parses the REAL TypeScript migration source
(engine/src/ledger/migrations/001_init.ts) and checks that every column it
declares for the trading-truth tables is also known to
analytics/schema_contract.py -- so if the TS schema ever changes without
this file being updated, this test catches the drift instead of Python
silently reading `None` for a renamed/missing column.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.schema_contract import DAILY_RISK_STATE_COLUMNS, TOKEN_EVALUATIONS_COLUMNS, TRADES_COLUMNS

MIGRATION_PATH = Path(__file__).resolve().parent.parent.parent / "engine" / "src" / "ledger" / "migrations" / "001_init.ts"


def _extract_table_columns(sql: str, table_name: str) -> set[str]:
    """Very small, deliberately narrow parser: finds
    `CREATE TABLE IF NOT EXISTS <table_name> ( ... );` and pulls out each
    line's leading column identifier. Good enough for this project's
    hand-written migration SQL; not a general SQL parser."""
    match = re.search(rf"CREATE TABLE IF NOT EXISTS {table_name} \((.*?)\n\);", sql, re.DOTALL)
    assert match, f"could not find CREATE TABLE for {table_name} in {MIGRATION_PATH}"
    body = match.group(1)

    columns = set()
    for line in body.splitlines():
        line = line.strip().rstrip(",")
        if not line or line.upper().startswith(("CREATE INDEX", "FOREIGN KEY", "PRIMARY KEY", "--")):
            continue
        first_token = line.split()[0]
        columns.add(first_token)
    return columns


def _migration_source() -> str:
    assert MIGRATION_PATH.exists(), f"expected TS migration source at {MIGRATION_PATH}"
    return MIGRATION_PATH.read_text(encoding="utf-8")


def test_trades_table_columns_match_the_ts_migration():
    sql = _migration_source()
    ts_columns = _extract_table_columns(sql, "trades")
    assert ts_columns == set(TRADES_COLUMNS), (
        f"trades column mismatch.\nIn TS but not Python: {ts_columns - set(TRADES_COLUMNS)}\n"
        f"In Python but not TS: {set(TRADES_COLUMNS) - ts_columns}"
    )


def test_token_evaluations_table_columns_match_the_ts_migration():
    sql = _migration_source()
    ts_columns = _extract_table_columns(sql, "token_evaluations")
    assert ts_columns == set(TOKEN_EVALUATIONS_COLUMNS), (
        f"token_evaluations column mismatch.\nIn TS but not Python: {ts_columns - set(TOKEN_EVALUATIONS_COLUMNS)}\n"
        f"In Python but not TS: {set(TOKEN_EVALUATIONS_COLUMNS) - ts_columns}"
    )


def test_daily_risk_state_table_columns_match_the_ts_migration():
    sql = _migration_source()
    ts_columns = _extract_table_columns(sql, "daily_risk_state")
    assert ts_columns == set(DAILY_RISK_STATE_COLUMNS), (
        f"daily_risk_state column mismatch.\nIn TS but not Python: {ts_columns - set(DAILY_RISK_STATE_COLUMNS)}\n"
        f"In Python but not TS: {set(DAILY_RISK_STATE_COLUMNS) - ts_columns}"
    )
