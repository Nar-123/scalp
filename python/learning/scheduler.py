"""Periodic learning-cycle scheduling (Phase 3-alt task 21).

Deliberately dependency-free (no APScheduler/cron library) -- a learning
cycle every hour does not need more machinery than a sleep loop. AI=NONE:
nothing in this module calls an LLM or any external service; it only calls
learner.run_learning_cycle on a timer.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .learner import LearningRunResult, run_learning_cycle

DEFAULT_INTERVAL_SEC = 3600  # "every 1 hour" (spec task 19 default)


@dataclass(frozen=True)
class SchedulerTick:
    result: LearningRunResult
    ran_at_ms: int


def run_scheduler_once(
    ledger_db_path: str,
    learning_db_path: str | None = None,
    strategy_version: str | None = None,
    incremental: bool = True,
) -> SchedulerTick:
    """Runs exactly one scheduled learning cycle and returns its result.
    `incremental=True` by default for the scheduled path specifically so an
    hourly tick with no new closed trades since the last cycle records
    'no_new_data' instead of redundantly re-scanning an unchanged dataset --
    a manual `learn` invocation (see scripts/learn.py) defaults the other
    way, since a human asking for a run usually wants it to actually run.
    """
    result = run_learning_cycle(
        ledger_db_path,
        learning_db_path=learning_db_path,
        strategy_version=strategy_version,
        trigger="scheduled",
        incremental=incremental,
    )
    return SchedulerTick(result=result, ran_at_ms=int(time.time() * 1000))


def run_scheduler_loop(
    ledger_db_path: str,
    learning_db_path: str | None = None,
    strategy_version: str | None = None,
    interval_sec: float = DEFAULT_INTERVAL_SEC,
    incremental: bool = True,
    max_iterations: int | None = None,
    sleep_fn=time.sleep,
    on_tick=None,
) -> None:
    """Blocks the calling thread/process forever (intended to run as its own
    long-lived process), running one cycle then sleeping `interval_sec`
    before the next. `max_iterations` and `sleep_fn`/`on_tick` exist purely
    so tests can drive this deterministically without a real hour-long wait
    or an actually-infinite loop; production callers leave them at their
    defaults.
    """
    iterations = 0
    while max_iterations is None or iterations < max_iterations:
        tick = run_scheduler_once(ledger_db_path, learning_db_path, strategy_version, incremental)
        if on_tick is not None:
            on_tick(tick)
        iterations += 1
        if max_iterations is None or iterations < max_iterations:
            sleep_fn(interval_sec)
