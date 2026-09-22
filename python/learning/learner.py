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
from .db import (
    complete_learning_run,
    get_last_processed_watermark_ms,
    has_running_learning_run,
    open_learning_db,
    record_candidate,
    start_learning_run,
)

DEFAULT_STRATEGY_VERSION = "baseline-v1"


@dataclass(frozen=True)
class LearningRunResult:
    run_id: str | None
    sample_size: int
    patterns_found: int
    candidates_generated: int
    status: str  # 'completed' | 'insufficient_sample' | 'no_new_data' | 'already_running'


def run_learning_cycle(
    ledger_db_path: str,
    learning_db_path: str | None = None,
    strategy_version: str | None = None,
    trigger: str = "manual",
    incremental: bool = False,
) -> LearningRunResult:
    """Reads closed trades for `strategy_version` (or all versions if None --
    though mixing versions this way is only safe for the read-only pattern
    scan here, never for a backtest; see validation.assert_single_strategy_version)
    from the shared ledger, runs local statistics + pattern discovery, and
    records any resulting candidate parameter proposals. Opens the ledger
    read-only and the learning tables read-write SEQUENTIALLY (never both at
    once), so there's no lock contention with the TypeScript engine's own
    writer connection to the same file.

    `incremental=True` (task 24) skips the cycle entirely -- recording a
    'no_new_data' run rather than silently doing nothing -- when no closed
    trade has an entry_time_ms past the last COMPLETED run's watermark for
    this strategy version. When there IS new data, this still recomputes
    patterns/statistics over the FULL historical sample (never a partial
    one -- partial recomputation would bias bucket statistics), so
    `incremental` only ever changes whether a redundant cycle runs, never
    what a cycle computes. Passing `incremental=False` (the default) always
    runs a full cycle, matching Phase 2 behavior exactly.

    Refuses to start (status='already_running', no new run row written) if
    another run is already in flight for this database -- see
    db.has_running_learning_run for what counts as "in flight" and the
    staleness cutoff that prevents one crashed run from wedging this forever
    (spec task 22: 'safe to run repeatedly', 'avoid duplicate learning runs').
    """
    learning_db_path = learning_db_path or ledger_db_path
    resolved_strategy_version = strategy_version or DEFAULT_STRATEGY_VERSION
    now_ms = int(time.time() * 1000)

    with open_learning_db(learning_db_path) as guard_conn:
        if has_running_learning_run(guard_conn, now_ms):
            return LearningRunResult(None, sample_size=0, patterns_found=0, candidates_generated=0, status="already_running")

    with open_ledger_readonly(ledger_db_path) as ledger_conn:
        trades = get_closed_trades(ledger_conn, strategy_version=strategy_version)

    sample_size = len(trades)
    data_range_start_ms = trades[0]["entry_time_ms"] if trades else None
    data_range_end_ms = trades[-1]["entry_time_ms"] if trades else None

    run_id = f"run_{uuid.uuid4().hex[:12]}"
    started_at_ms = int(time.time() * 1000)

    with open_learning_db(learning_db_path) as learning_conn:
        if incremental and data_range_end_ms is not None:
            watermark = get_last_processed_watermark_ms(learning_conn, resolved_strategy_version)
            if watermark is not None and data_range_end_ms <= watermark:
                return LearningRunResult(None, sample_size=sample_size, patterns_found=0, candidates_generated=0, status="no_new_data")

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
                data_range_start_ms=data_range_start_ms,
                data_range_end_ms=data_range_end_ms,
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
            data_range_start_ms=data_range_start_ms,
            data_range_end_ms=data_range_end_ms,
            # candidates_tested/passed/rejected stay at their 0 default here:
            # this cycle only GENERATES candidates (as 'pending'). Actually
            # backtesting/validating/promoting them is a deliberate, separate
            # step -- see learning/candidate_pipeline.py -- never implicit in
            # generation, so a run that only generated candidates truthfully
            # reports zero tested here.
        )

    return LearningRunResult(run_id, sample_size, patterns_found=len(patterns), candidates_generated=len(candidates), status="completed")
