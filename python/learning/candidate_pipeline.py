"""Per-candidate testing pipeline (Phase 3-alt): Backtest -> Out-of-Sample ->
(Shadow, separately) -> Promotion Gate.

Ties together the real TS replay engine (via backtest_bridge), this
package's strict chronological train/validation/out-of-sample split
(validation.py), and the promotion gate (promotion.py) into one per-candidate
flow. Never invoked automatically by learner.run_learning_cycle -- testing a
candidate is always its own deliberate call, so nothing here promotes a
strategy as a side effect of pattern discovery (spec: "a candidate MUST NOT
become production automatically").
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from analytics.constants import MIN_TRADES_FOR_STRATEGY_VALIDATION
from analytics.statistics import compute_core_statistics
from .backtest_bridge import BridgeBacktestResult, run_ts_backtest
from .db import record_validation_result
from .promotion import PromotionDecision, apply_promotion_decision, evaluate_promotion
from .validation import split_train_validation_oos


@dataclass(frozen=True)
class CandidateStageResult:
    candidate_id: str
    stage: str  # 'backtest' | 'out_of_sample'
    passed: bool | None  # None = INSUFFICIENT_DATA, not a failure
    sample_size: int
    metrics: dict[str, Any] = field(default_factory=dict)
    notes: str = ""


def _normalize_closed_trades(bridge_trades: list[dict]) -> list[dict]:
    """The TS replay engine's trade records use camelCase and include
    still-open positions; this package's stats/split utilities expect
    snake_case, closed-only dicts (matching analytics.reader.get_closed_trades'
    shape). A still-open position has no determinate outcome and is excluded
    here rather than guessed at.
    """
    closed = [t for t in bridge_trades if t.get("status") == "closed"]
    normalized = [
        {
            "entry_time_ms": t["entryTimeMs"],
            "exit_time_ms": t["exitTimeMs"],
            "pnl_sol": t["pnlSol"],
            "pnl_pct": t["pnlPct"],
            "exit_reason": t["exitReason"],
        }
        for t in closed
    ]
    normalized.sort(key=lambda r: r["entry_time_ms"])
    return normalized


def run_candidate_backtest_stages(
    db_path: str,
    candidate_id: str,
    candidate_label: str,
    tunable_overrides: dict[str, Any],
    strategy_version: str | None = None,
    min_sample_size: int = MIN_TRADES_FOR_STRATEGY_VALIDATION,
    node_executable: str = "node",
    cli_path: str | Path | None = None,
) -> list[CandidateStageResult]:
    """Runs ONE real TS replay of the candidate's full available history,
    then splits the resulting closed trades strictly chronologically into
    train / validation / out-of-sample (task I) and evaluates the 'backtest'
    stage against the train slice and the 'out_of_sample' stage against the
    OOS slice. Never touches the validation slice for a pass/fail verdict --
    it exists so a human/AI-analyst-later-phase can sanity-check generalization
    without ever being the thing a candidate is tuned against.

    A 'shadow' stage is intentionally NOT produced here: it requires real
    hypothetical trades from an actual paper-trading loop this project does
    not operate yet (see shadow.py's own docstring). Until a caller records
    one, the promotion gate correctly leaves that stage PENDING and refuses
    to promote past it -- this function's absence of a shadow result is not
    a bug, it's the gate doing its job.
    """
    bridge_result: BridgeBacktestResult = run_ts_backtest(
        db_path,
        label=candidate_label,
        strategy_version=strategy_version,
        tunable_overrides=tunable_overrides,
        node_executable=node_executable,
        cli_path=cli_path,
    )

    if bridge_result.status == "insufficient_data":
        return [
            CandidateStageResult(
                candidate_id, "backtest", passed=None, sample_size=0,
                notes="No historical snapshots were available to replay -- INSUFFICIENT_DATA, not a failure.",
            )
        ]

    closed = _normalize_closed_trades(bridge_result.trades)
    if len(closed) < min_sample_size:
        return [
            CandidateStageResult(
                candidate_id, "backtest", passed=None, sample_size=len(closed),
                notes=(
                    f"Only {len(closed)} closed trades from replay; "
                    f"{min_sample_size} required (MIN_TRADES_FOR_STRATEGY_VALIDATION). "
                    "INSUFFICIENT_DATA -- refusing to fabricate a verdict from too small a sample."
                ),
            )
        ]

    split = split_train_validation_oos(closed)
    results: list[CandidateStageResult] = []

    train_stats = compute_core_statistics(split.train)
    results.append(
        CandidateStageResult(
            candidate_id,
            "backtest",
            passed=(train_stats.avg_pnl_sol is not None and train_stats.avg_pnl_sol > 0) if split.train else None,
            sample_size=len(split.train),
            metrics={
                "win_rate": train_stats.win_rate,
                "avg_pnl_sol": train_stats.avg_pnl_sol,
                "profit_factor": train_stats.profit_factor,
                "max_drawdown_sol": train_stats.max_drawdown_sol,
                "training_period": split.training_period.__dict__ if split.training_period else None,
            },
            notes="Simulation under configured assumptions on the training period only -- not a live-trading claim.",
        )
    )

    oos_stats = compute_core_statistics(split.out_of_sample)
    results.append(
        CandidateStageResult(
            candidate_id,
            "out_of_sample",
            passed=(oos_stats.avg_pnl_sol is not None and oos_stats.avg_pnl_sol > 0) if split.out_of_sample else None,
            sample_size=len(split.out_of_sample),
            metrics={
                "win_rate": oos_stats.win_rate,
                "avg_pnl_sol": oos_stats.avg_pnl_sol,
                "profit_factor": oos_stats.profit_factor,
                "max_drawdown_sol": oos_stats.max_drawdown_sol,
                "oos_period": split.oos_period.__dict__ if split.oos_period else None,
            },
            notes=(
                "Out-of-sample period was never used to choose this candidate's parameters. "
                "A positive result here describes this historical sample under these assumptions, "
                "not a guarantee of future performance."
            ),
        )
    )
    return results


def persist_stage_results(conn: sqlite3.Connection, results: list[CandidateStageResult]) -> None:
    now_ms = int(time.time() * 1000)
    for result in results:
        record_validation_result(
            conn,
            result_id=f"val_{uuid.uuid4().hex[:12]}",
            candidate_id=result.candidate_id,
            stage=result.stage,
            passed=result.passed,
            metrics=result.metrics,
            sample_size=result.sample_size,
            created_at_ms=now_ms,
            notes=result.notes,
        )


def run_and_persist_candidate_backtest(
    conn: sqlite3.Connection,
    db_path: str,
    candidate_id: str,
    candidate_label: str,
    tunable_overrides: dict[str, Any],
    strategy_version: str | None = None,
    min_sample_size: int = MIN_TRADES_FOR_STRATEGY_VALIDATION,
    node_executable: str = "node",
    cli_path: str | Path | None = None,
) -> PromotionDecision:
    """Runs the backtest/out-of-sample stages, persists them, re-reads every
    validation_results row recorded so far for this candidate (so a
    previously-recorded 'shadow' result, if any, is still honored), and
    returns the resulting promotion decision WITHOUT applying it -- applying
    is a separate, explicit call (apply_promotion_decision) so a caller can
    inspect a 'rejected'/'pass' verdict before it's written.
    """
    stage_results = run_candidate_backtest_stages(
        db_path, candidate_id, candidate_label, tunable_overrides,
        strategy_version=strategy_version, min_sample_size=min_sample_size,
        node_executable=node_executable, cli_path=cli_path,
    )
    persist_stage_results(conn, stage_results)

    all_results = [dict(row) for row in conn.execute(
        "SELECT * FROM validation_results WHERE candidate_id = ?", (candidate_id,)
    ).fetchall()]
    return evaluate_promotion(candidate_id, all_results)


__all__ = [
    "CandidateStageResult",
    "run_candidate_backtest_stages",
    "persist_stage_results",
    "run_and_persist_candidate_backtest",
    "apply_promotion_decision",
]
