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
