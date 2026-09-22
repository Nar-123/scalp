"""Scheduled AI research cycle (Phase 4 task 28).

Mirrors learning/scheduler.py's dependency-free sleep-loop shape, but at a
much coarser default interval (6 hours vs. the local learning cycle's 1
hour) since an AI call is comparatively expensive and this project's whole
design goal is REALTIME_AI_CALLS = 0 and minimal redundant AI usage. Local
learning stays on its own, separate, more frequent schedule.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

from analytics.constants import AI_SCHEDULED_RESEARCH_INTERVAL_SEC
from analytics.reader import get_closed_trades, open_ledger_readonly
from learning.db import get_latest_ai_analysis, open_learning_db

from .service import AIAnalysisResult, AIAnalysisService


def _previous_win_rate(conn, strategy_version: str) -> float | None:
    row = get_latest_ai_analysis(conn, strategy_version)
    if row is None:
        return None
    try:
        return json.loads(row["input_json"])["statistics"]["win_rate"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


@dataclass(frozen=True)
class AISchedulerTick:
    result: AIAnalysisResult
    ran_at_ms: int


def run_ai_scheduler_once(
    service: AIAnalysisService,
    ledger_db_path: str,
    learning_db_path: str | None = None,
    strategy_version: str = "baseline-v1",
    period_label: str = "rolling",
) -> AISchedulerTick:
    """One scheduled research cycle: local analytics first (this reads
    closed trades and lets AIAnalysisService itself gate on sample size and
    meaningful change -- force=False, so if nothing meaningful happened,
    the provider is never called at all)."""
    learning_db_path = learning_db_path or ledger_db_path
    with open_ledger_readonly(ledger_db_path) as ledger_conn:
        trades = get_closed_trades(ledger_conn, strategy_version=strategy_version)

    with open_learning_db(learning_db_path) as learning_conn:
        previous_win_rate = _previous_win_rate(learning_conn, strategy_version)
        result = service.analyze(
            learning_conn,
            trades,
            strategy_version=strategy_version,
            period_start=period_label,
            period_end=period_label,
            trigger_reason="scheduled_research_review",
            force=False,
            previous_win_rate=previous_win_rate,
        )

    return AISchedulerTick(result=result, ran_at_ms=int(time.time() * 1000))


def run_ai_scheduler_loop(
    service: AIAnalysisService,
    ledger_db_path: str,
    learning_db_path: str | None = None,
    strategy_version: str = "baseline-v1",
    interval_sec: float = AI_SCHEDULED_RESEARCH_INTERVAL_SEC,
    max_iterations: int | None = None,
    sleep_fn=time.sleep,
    on_tick=None,
) -> None:
    """Blocks forever by default (intended as its own long-lived process);
    `max_iterations`/`sleep_fn`/`on_tick` exist so tests can drive this
    deterministically without a real 6-hour wait."""
    iterations = 0
    while max_iterations is None or iterations < max_iterations:
        tick = run_ai_scheduler_once(service, ledger_db_path, learning_db_path, strategy_version)
        if on_tick is not None:
            on_tick(tick)
        iterations += 1
        if max_iterations is None or iterations < max_iterations:
            sleep_fn(interval_sec)
