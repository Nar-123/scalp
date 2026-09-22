#!/usr/bin/env python3
"""CLI: compare a live read-only shadow window with a backtest of the SAME
window (Phase 5.1).

    python scripts/compare_shadow_backtest.py <ledger.sqlite> [--strategy-version baseline-v1]

Requires the engine to be built (npm run build in engine/) so the TypeScript
replay engine can run. Read-only over the ledger's shadow/trading tables.
Simulation under configured assumptions only -- never a profitability claim.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.shadow_window import build_window_comparison, dumps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("db_path")
    parser.add_argument("--strategy-version", default="baseline-v1")
    args = parser.parse_args()
    if not Path(args.db_path).exists():
        print(f"No ledger at {args.db_path}")
        return 1
    print(dumps(build_window_comparison(args.db_path, args.strategy_version)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
