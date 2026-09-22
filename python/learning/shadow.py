"""Shadow strategy foundation (Phase 2 task 21).

A shadow candidate NEVER executes real (or even DRY_RUN-simulated-live)
transactions -- this module is pure computation over a list of already-
hypothetical entries/exits (e.g. produced by a backtest pass, or later by
a real paper-trading loop that doesn't exist yet). It only aggregates
metrics and compares them against the production strategy's own recent
performance; it has no execution capability of any kind to remove.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from analytics.statistics import compute_core_statistics


@dataclass(frozen=True)
class ShadowResult:
    candidate_id: str
    sample_size: int
    hypothetical_pnl_sol: float
    win_rate: float | None
    max_drawdown_sol: float
    comparison_to_production: dict[str, Any] = field(default_factory=dict)


def evaluate_shadow_candidate(
    candidate_id: str,
    hypothetical_trades: list[dict],
    production_trades: list[dict] | None = None,
) -> ShadowResult:
    """`hypothetical_trades` are trades the candidate WOULD have taken --
    never real trades this function executed itself (it has no such
    capability). If `production_trades` (the real/DRY_RUN production
    strategy's own trades over a comparable period) is given, a simple
    side-by-side comparison is included; otherwise `comparison_to_production`
    is empty rather than guessed.
    """
    candidate_stats = compute_core_statistics(hypothetical_trades)

    comparison: dict[str, Any] = {}
    if production_trades is not None:
        production_stats = compute_core_statistics(production_trades)
        comparison = {
            "production_sample_size": production_stats.total_trades,
            "production_win_rate": production_stats.win_rate,
            "production_avg_pnl_sol": production_stats.avg_pnl_sol,
            "production_max_drawdown_sol": production_stats.max_drawdown_sol,
            "candidate_win_rate_delta": (
                (candidate_stats.win_rate - production_stats.win_rate)
                if candidate_stats.win_rate is not None and production_stats.win_rate is not None
                else None
            ),
        }

    return ShadowResult(
        candidate_id=candidate_id,
        sample_size=candidate_stats.total_trades,
        hypothetical_pnl_sol=sum(t.get("pnl_sol", 0) or 0 for t in hypothetical_trades),
        win_rate=candidate_stats.win_rate,
        max_drawdown_sol=candidate_stats.max_drawdown_sol,
        comparison_to_production=comparison,
    )


# --- Phase 5: realtime shadow trading comparison + promotion-gate stage ------

import os  # noqa: E402
from dataclasses import dataclass as _dataclass  # noqa: E402

from analytics.statistics import compute_core_statistics as _core  # noqa: E402


def shadow_thresholds(env: dict[str, str] | None = None) -> tuple[float, int]:
    """(SHADOW_MIN_DURATION_HOURS, SHADOW_MIN_TRADES) -- configurable, never a
    hardcoded claim that some number of hours proves anything (spec task 19).
    The defaults are deliberately conservative placeholders an operator tunes."""
    env = env if env is not None else os.environ
    return float(env.get("SHADOW_MIN_DURATION_HOURS", "24")), int(env.get("SHADOW_MIN_TRADES", "100"))


def _side_stats(trades: list[dict]) -> dict:
    core = _core(trades)
    fees = sum((t.get("entry_fees_sol") or 0) + (t.get("exit_fees_sol") or 0) for t in trades)
    # Backtest trades (BacktestTrade camelCase->snake via candidate_pipeline) may lack fee fields.
    has_fees = any(t.get("entry_fees_sol") is not None for t in trades)
    return {
        "trades": core.total_trades,
        "win_rate": core.win_rate,
        "net_simulated_pnl_sol": sum(t["pnl_sol"] for t in trades if t.get("pnl_sol") is not None),
        "avg_pnl_sol": core.avg_pnl_sol,
        "avg_hold_seconds": core.avg_hold_seconds,
        "tp_rate": core.tp_frequency,
        "sl_rate": core.sl_frequency,
        "timeout_rate": core.timeout_frequency,
        "max_drawdown_sol": core.max_drawdown_sol,
        "total_fees_sol": fees if has_fees else None,
    }


def compare_backtest_vs_shadow(backtest_trades: list[dict], shadow_trades: list[dict]) -> dict:
    """Side-by-side BACKTEST vs SHADOW report. Every section is labelled so a
    reader can tell what kind of statement it is (spec task 20):
    CALCULATED = arithmetic over the trades passed in; SIMULATED = both sides
    are simulated fills under assumptions, neither is real money; ASSUMED =
    fee/slippage/latency inputs; HYPOTHESIS = the explanatory notes, never
    presented as fact. Exact equality is NOT expected (spec task 16)."""
    bt = _side_stats(backtest_trades)
    sh = _side_stats(shadow_trades)

    def delta(key: str):
        a, b = sh.get(key), bt.get(key)
        return None if a is None or b is None else a - b

    return {
        "labels": {
            "backtest": "SIMULATED (historical replay under configured assumptions)",
            "shadow": "SIMULATED (realtime market data, simulated fills -- no real transaction)",
            "statistics": "CALCULATED",
            "differences": "CALCULATED",
            "explanations": "HYPOTHESIS",
        },
        "backtest": bt,
        "shadow": sh,
        "differences": {k: delta(k) for k in ("trades", "win_rate", "net_simulated_pnl_sol", "avg_pnl_sol", "avg_hold_seconds", "tp_rate", "sl_rate", "timeout_rate", "max_drawdown_sol")},
        "hypotheses": [
            "HYPOTHESIS: differences in trade count may reflect that backtest replays this project's own ~2s evaluation log while shadow sees each live tick, so entry timing differs.",
            "HYPOTHESIS: differences in win rate/PnL may reflect market conditions in the shadow window differing from the backtest window; a small shadow sample is dominated by chance.",
            "HYPOTHESIS: fill differences are limited because both sides use the same simulateFill formula; remaining gaps come from observed price/impact inputs.",
        ],
        "note": "Neither side is a live-trading result. Statements here describe simulated outcomes under the observed sample, not future profitability.",
    }


@_dataclass(frozen=True)
class ShadowStageResult:
    passed: bool | None  # None = INSUFFICIENT_DATA (not a failure), never auto-promotes
    sample_size: int
    duration_hours: float
    metrics: dict
    notes: str


def evaluate_shadow_stage(shadow_trades: list[dict], min_duration_hours: float | None = None, min_trades: int | None = None) -> ShadowStageResult:
    """Produces the 'shadow' validation stage verdict the existing promotion
    gate (learning/promotion.py) consumes. INSUFFICIENT_DATA (passed=None)
    until BOTH configured thresholds are met. A pass here is only one input
    to the gate -- it never activates anything (promotion stays a DB label)."""
    default_hours, default_trades = shadow_thresholds()
    min_duration_hours = default_hours if min_duration_hours is None else min_duration_hours
    min_trades = default_trades if min_trades is None else min_trades

    times = [t["entry_time_ms"] for t in shadow_trades if t.get("entry_time_ms") is not None]
    end_times = [t["exit_time_ms"] for t in shadow_trades if t.get("exit_time_ms") is not None]
    duration_hours = ((max(end_times or times) - min(times)) / 3_600_000) if times else 0.0
    n = len(shadow_trades)
    stats = _side_stats(shadow_trades)

    if n < min_trades or duration_hours < min_duration_hours:
        return ShadowStageResult(
            None, n, duration_hours, stats,
            f"INSUFFICIENT_DATA: {n} shadow trades over {duration_hours:.2f}h; need >= {min_trades} trades and >= {min_duration_hours}h (configurable). Not a failure.",
        )
    passed = stats["avg_pnl_sol"] is not None and stats["avg_pnl_sol"] > 0
    return ShadowStageResult(
        passed, n, duration_hours, stats,
        f"Shadow produced {stats['net_simulated_pnl_sol']:.6f} SOL simulated net PnL over {n} trades under the observed shadow market conditions (SIMULATED, not a profitability claim).",
    )


def persist_shadow_stage(conn, candidate_id: str, result: ShadowStageResult, now_ms: int | None = None) -> None:
    """Records the verdict as the 'shadow' validation stage for the EXISTING
    promotion gate. Writing this never promotes anything: learning/promotion.py
    still requires backtest + out_of_sample + shadow to all pass, and
    'promoted' remains a database label with no live effect."""
    import time
    import uuid

    from .db import record_validation_result

    record_validation_result(
        conn,
        result_id=f"val_{uuid.uuid4().hex[:12]}",
        candidate_id=candidate_id,
        stage="shadow",
        passed=result.passed,
        metrics={**result.metrics, "duration_hours": result.duration_hours},
        sample_size=result.sample_size,
        created_at_ms=now_ms if now_ms is not None else int(time.time() * 1000),
        notes=result.notes,
    )
