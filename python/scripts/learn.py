#!/usr/bin/env python3
"""CLI: manually trigger one learning cycle (Phase 3-alt task 22).

    python scripts/learn.py [path/to/ledger.sqlite] [--strategy-version V1] [--incremental]

Safe to run repeatedly: learner.run_learning_cycle refuses to start a second
run while one is already in flight for the same database (status prints
'already_running' rather than starting a duplicate -- see
learning/db.has_running_learning_run). Defaults to a FULL (non-incremental)
run, since a human explicitly asking for a learning run generally wants it
to actually run rather than being skipped as "no new data" -- pass
--incremental to opt into the scheduler's lighter-weight behavior instead.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.learner import run_learning_cycle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "db_path",
        nargs="?",
        default=str(Path(__file__).resolve().parent.parent.parent / "data" / "ledger.sqlite"),
        help="Path to the shared ledger.sqlite (default: ../data/ledger.sqlite)",
    )
    parser.add_argument("--strategy-version", default=None, help="Restrict to one strategy version (default: all)")
    parser.add_argument("--incremental", action="store_true", help="Skip the run if no new closed trades exist since the last completed run")
    args = parser.parse_args()

    if not Path(args.db_path).exists():
        print(f"No ledger found at {args.db_path}. Run the engine first (npm run start --workspace=engine).")
        return 1

    result = run_learning_cycle(args.db_path, strategy_version=args.strategy_version, trigger="manual", incremental=args.incremental)

    print(f"run_id:               {result.run_id}")
    print(f"status:                {result.status}")
    print(f"sample_size:           {result.sample_size}")
    print(f"patterns_found:        {result.patterns_found}")
    print(f"candidates_generated:  {result.candidates_generated}")

    if result.status == "already_running":
        print("\nAnother learning run is already in progress for this database. Not starting a duplicate.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
