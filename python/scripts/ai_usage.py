#!/usr/bin/env python3
"""CLI: AI usage report (Phase 4 task 20, the "/ai_usage" equivalent).

    python scripts/ai_usage.py [path/to/ledger.sqlite] [--since-hours 24]

Reports request count, token totals, cache hit rate, estimated cost, and
failed-call count from learning/db.py's ai_usage_log table -- nothing here
calls a provider or touches trading state, it only reads what has already
been logged.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.db import get_ai_usage_report, open_learning_db


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "db_path",
        nargs="?",
        default=str(Path(__file__).resolve().parent.parent.parent / "data" / "ledger.sqlite"),
        help="Path to the shared ledger.sqlite (default: ../data/ledger.sqlite)",
    )
    parser.add_argument("--since-hours", type=float, default=None, help="Only include calls from the last N hours (default: all time)")
    args = parser.parse_args()

    if not Path(args.db_path).exists():
        print(f"No ledger found at {args.db_path}.")
        return 1

    since_ms = int(time.time() * 1000) - int(args.since_hours * 3600 * 1000) if args.since_hours is not None else None

    with open_learning_db(args.db_path) as conn:
        report = get_ai_usage_report(conn, since_ms=since_ms)

    window = f"last {args.since_hours}h" if args.since_hours is not None else "all time"
    print(f"AI usage report ({window}):")
    print(f"  requests:            {report['request_count']}")
    print(f"  input tokens:        {report['input_tokens']}")
    print(f"  output tokens:       {report['output_tokens']}")
    print(f"  total tokens:        {report['total_tokens']}")
    print(f"  cache hits/misses:   {report['cache_hits']} / {report['cache_misses']}")
    cache_rate = report["cache_hit_rate"]
    print(f"  cache hit rate:      {f'{cache_rate:.1%}' if cache_rate is not None else 'n/a'}")
    print(f"  failed calls:        {report['failed_calls']}")
    print(f"  estimated cost:      ${report['estimated_cost_usd']:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
