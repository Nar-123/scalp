"""Learning engine orchestration (Phase 2 task 16).

Trade Ledger -> Local Analytics -> Pattern Discovery -> Candidate Parameters
-> (Validation is a separate, later step -- see validation.py/backtest.py).

`run_learning_cycle` NEVER modifies production strategy parameters. It only
ever writes rows to its own tables (learning_runs, candidate_strategies) --
every candidate it produces starts at status='pending' and stays there until
some future validation pipeline (out of scope for this phase) promotes it.
No AI/LLM call happens anywhere in this function.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from analytics.constants import MIN_TRADES_FOR_PATTERN
from analytics.patterns import discover_patterns
from analytics.reader import get_closed_trades, open_ledger_readonly
from analytics.statistics import compute_core_statistics
from .candidates import generate_candidates_from_patterns
from .db import complete_learning_run, open_learning_db, record_candidate, start_learning_run

DEFAULT_STRATEGY_VERSION = "baseline-v1"


@dataclass(frozen=True)
class LearningRunResult:
    run_id: str
    sample_size: int
    patterns_found: int
    candidates_generated: int
    status: str  # 'completed' | 'insufficient_sample'


def run_learning_cycle(
    ledger_db_path: str,
    learning_db_path: str | None = None,
    strategy_version: str | None = None,
    trigger: str = "manual",
) -> LearningRunResult:
    """Reads closed trades for `strategy_version` (or all versions if None --
    though mixing versions this way is only safe for the read-only pattern
    scan here, never for a backtest; see validation.assert_single_strategy_version)
    from the shared ledger, runs local statistics + pattern discovery, and
    records any resulting candidate parameter proposals. Opens the ledger
    read-only and the learning tables read-write SEQUENTIALLY (never both at
    once), so there's no lock contention with the TypeScript engine's own
    writer connection to the same file.
    """
    learning_db_path = learning_db_path or ledger_db_path
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    started_at_ms = int(time.time() * 1000)

    with open_ledger_readonly(ledger_db_path) as ledger_conn:
        trades = get_closed_trades(ledger_conn, strategy_version=strategy_version)

    resolved_strategy_version = strategy_version or DEFAULT_STRATEGY_VERSION
    sample_size = len(trades)

    with open_learning_db(learning_db_path) as learning_conn:
        start_learning_run(learning_conn, run_id, trigger, started_at_ms)

        if sample_size < MIN_TRADES_FOR_PATTERN:
            complete_learning_run(
                learning_conn,
                run_id,
                completed_at_ms=int(time.time() * 1000),
                sample_size=sample_size,
                strategy_version=resolved_strategy_version,
                summary={"skipped": True, "reason": "insufficient_sample", "min_required": MIN_TRADES_FOR_PATTERN},
                status="completed",
            )
            return LearningRunResult(run_id, sample_size, patterns_found=0, candidates_generated=0, status="insufficient_sample")

        patterns = discover_patterns(trades)
        candidates = generate_candidates_from_patterns(
            patterns,
            parent_strategy=resolved_strategy_version,
            sample_size=sample_size,
        )
        for candidate in candidates:
            record_candidate(learning_conn, candidate.as_dict(), learning_run_id=run_id)

        core = compute_core_statistics(trades)
        summary = {
            "patterns_found": len(patterns),
            "candidates_generated": len(candidates),
            "win_rate": core.win_rate,
            "avg_pnl_sol": core.avg_pnl_sol,
            "max_drawdown_sol": core.max_drawdown_sol,
        }
        complete_learning_run(
            learning_conn,
            run_id,
            completed_at_ms=int(time.time() * 1000),
            sample_size=sample_size,
            strategy_version=resolved_strategy_version,
            summary=summary,
            status="completed",
        )

    return LearningRunResult(run_id, sample_size, patterns_found=len(patterns), candidates_generated=len(candidates), status="completed")
