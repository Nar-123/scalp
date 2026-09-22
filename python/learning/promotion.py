"""Promotion gate (Phase 3-alt task 20).

Pipeline: Candidate -> Backtest -> Out-of-Sample -> Shadow -> Promotion Gate.
`evaluate_promotion` reads whatever validation_results rows already exist
for a candidate and computes an overall PENDING / PASS / REJECTED verdict --
it never runs a stage itself (that is backtest.py / validation.py /
shadow.py's job, or the TS bridge's for a real replay). A stage with no
recorded result at all counts as PENDING, not PASS: promotion can only ever
happen by every required stage explicitly passing, never by omission.

`apply_promotion_decision` writes the verdict onto candidate_strategies.status
-- but 'promoted' here is a database label read by a human reviewer, not a
trigger that changes anything live. Nothing in this codebase reads a
'promoted' row and pushes it into the TypeScript engine's active
strategyVersion; adopting a promoted candidate into production remains a
separate, explicit action outside this pipeline.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from .db import update_candidate_status

REQUIRED_STAGES: tuple[str, ...] = ("backtest", "out_of_sample", "shadow")

StageStatus = str  # 'pending' | 'pass' | 'rejected'


@dataclass(frozen=True)
class PromotionDecision:
    candidate_id: str
    stage_statuses: dict[str, StageStatus]
    overall: StageStatus


def _latest_result_by_stage(validation_results: list[dict]) -> dict[str, dict]:
    """Later rows (by created_at_ms) win for a given stage -- a candidate
    may be re-validated at a stage (e.g. after more data accumulates), and
    the gate must reflect the most recent verdict, not the first one."""
    latest: dict[str, dict] = {}
    for row in sorted(validation_results, key=lambda r: r["created_at_ms"]):
        latest[row["stage"]] = row
    return latest


def evaluate_promotion(candidate_id: str, validation_results: list[dict]) -> PromotionDecision:
    latest = _latest_result_by_stage([r for r in validation_results if r["candidate_id"] == candidate_id])

    stage_statuses: dict[str, StageStatus] = {}
    for stage in REQUIRED_STAGES:
        row = latest.get(stage)
        if row is None or row.get("passed") is None:
            stage_statuses[stage] = "pending"
        elif row["passed"]:
            stage_statuses[stage] = "pass"
        else:
            stage_statuses[stage] = "rejected"

    if any(status == "rejected" for status in stage_statuses.values()):
        overall: StageStatus = "rejected"
    elif all(status == "pass" for status in stage_statuses.values()):
        overall = "pass"
    else:
        overall = "pending"

    return PromotionDecision(candidate_id=candidate_id, stage_statuses=stage_statuses, overall=overall)


def apply_promotion_decision(conn: sqlite3.Connection, decision: PromotionDecision) -> None:
    """No-ops on 'pending' -- a candidate awaiting more stages keeps
    whatever status it already has (normally 'pending') rather than being
    touched every time an intermediate check runs."""
    if decision.overall == "pass":
        update_candidate_status(conn, decision.candidate_id, "promoted")
    elif decision.overall == "rejected":
        failed_stages = [stage for stage, status in decision.stage_statuses.items() if status == "rejected"]
        update_candidate_status(
            conn,
            decision.candidate_id,
            "rejected",
            rejection_reason=f"Failed stage(s): {', '.join(failed_stages)}",
        )
