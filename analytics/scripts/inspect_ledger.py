#!/usr/bin/env python3
"""CLI: prints a quick trade summary from the shared ledger.

    python scripts/inspect_ledger.py [path/to/ledger.sqlite]

Defaults to ../data/ledger.sqlite (the engine's default DRY_RUN location).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.ledger_reader import get_daily_risk_states, get_trade_summary, open_ledger_readonly


def main() -> int:
    db_path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent.parent.parent / "data" / "ledger.sqlite")

    if not Path(db_path).exists():
        print(f"No ledger found at {db_path}. Run the engine first (npm run start --workspace=engine).")
        return 1

    with open_ledger_readonly(db_path) as conn:
        summary = get_trade_summary(conn)
        print(f"Ledger: {db_path}")
        print(f"  Total trades recorded: {summary.total_trades}")
        print(f"  Closed trades:         {summary.closed_trades}")
        print(f"  Wins / Losses:         {summary.wins} / {summary.losses}")
        win_rate = summary.win_rate
        print(f"  Win rate:              {f'{win_rate:.1%}' if win_rate is not None else 'n/a'}")
        print(f"  Total PnL (SOL):       {summary.total_pnl_sol:.6f}")

        print("\n  Daily risk state:")
        for row in get_daily_risk_states(conn):
            print(
                f"    {row['trading_date_utc']}: "
                f"start={row['starting_balance_sol']:.4f} SOL, "
                f"realized={row['realized_pnl_sol']:.6f} SOL, "
                f"circuit_breaker={'TRIGGERED' if row['circuit_breaker_triggered'] else 'ok'}"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
