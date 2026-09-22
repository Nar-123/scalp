#!/usr/bin/env python3
"""CLI: manually trigger one AI research analysis (Phase 4 task 29).

    python scripts/learn_ai.py [path/to/ledger.sqlite] [--strategy-version V1]

Runs the full pipeline from spec section 29:
  1. run local analytics
  2. detect meaningful patterns  (skipped here -- force=True, since a human
     explicitly asked; local analytics + sample-size checks still run)
  3. build compact summary
  4. call AI if justified          (sample-size gate still applies -- see
     analytics_constants.MIN_TRADES_FOR_PATTERN)
  5. validate AI response
  6. store analysis
  7. create candidates if valid    (as 'pending' -- never auto-promoted)
  8. leave candidates PENDING

AI_PROVIDER defaults to 'mock' (see learning/ai/provider.py) so this is
safe to run with no API key configured -- it will simply produce a
low-confidence mock analysis rather than fail. Set AI_PROVIDER=http plus
AI_PROVIDER_BASE_URL / AI_ANALYSIS_MODEL / AI_PROVIDER_API_KEY_ENV to use a
real provider.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.reader import get_closed_trades, open_ledger_readonly
from learning.ai.provider import AIProviderError, create_provider_from_env
from learning.ai.service import AIAnalysisService
from learning.db import open_learning_db


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "db_path",
        nargs="?",
        default=str(Path(__file__).resolve().parent.parent.parent / "data" / "ledger.sqlite"),
        help="Path to the shared ledger.sqlite (default: ../data/ledger.sqlite)",
    )
    parser.add_argument("--strategy-version", default="baseline-v1")
    args = parser.parse_args()

    if not Path(args.db_path).exists():
        print(f"No ledger found at {args.db_path}. Run the engine first (npm run start --workspace=engine).")
        return 1

    try:
        provider = create_provider_from_env(os.environ)
    except AIProviderError as exc:
        print(f"Could not construct AI provider: {exc}")
        return 1

    service = AIAnalysisService(
        provider=provider,
        provider_name=os.environ.get("AI_PROVIDER", "mock"),
        model=os.environ.get("AI_ANALYSIS_MODEL", "mock-model"),
    )

    with open_ledger_readonly(args.db_path) as ledger_conn:
        trades = get_closed_trades(ledger_conn, strategy_version=args.strategy_version)

    with open_learning_db(args.db_path) as learning_conn:
        result = service.analyze(
            learning_conn,
            trades,
            strategy_version=args.strategy_version,
            period_start="manual",
            period_end="manual",
            trigger_reason="manual_learn_ai_command",
            force=True,  # a human explicitly asked -- bypass the meaningful-change gate, not the sample-size gate
        )

    print(f"status:              {result.status}")
    print(f"analysis_id:         {result.analysis_id}")
    print(f"cache_hit:           {result.cache_hit}")
    print(f"candidates_created:  {result.candidates_created}  (status: pending -- never auto-promoted)")
    print(f"rejected_parameters: {result.rejected_parameters}")
    print(f"notes:               {result.notes}")

    return 0 if result.status in ("completed", "cache_hit", "insufficient_data") else 1


if __name__ == "__main__":
    raise SystemExit(main())
