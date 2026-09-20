"""Backtesting foundation (Phase 2 task 19).

This is architecture, not a working backtester: `run_backtest` does not
simulate historical entries/exits against market data (that requires
historical order-book/liquidity data this project does not yet have any
pipeline for). What it DOES do, deliberately, is refuse to produce a result
that looks like a real backtest when the available historical sample is too
small to support one -- rather than inventing numbers to fill the shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from analytics.constants import MIN_TRADES_FOR_STRATEGY_VALIDATION
from analytics.statistics import compute_core_statistics
from .validation import assert_single_strategy_version


@dataclass(frozen=True)
class BacktestResult:
    candidate_id: str
    sample_size: int
    data_sufficient: bool
    metrics: dict[str, Any] = field(default_factory=dict)
    notes: str = ""


def run_backtest(
    candidate_id: str,
    historical_trades: list[dict],
    min_sample_size: int = MIN_TRADES_FOR_STRATEGY_VALIDATION,
) -> BacktestResult:
    """`historical_trades` should be trades whose entry conditions this
    candidate's changed parameters would ALSO have accepted (that filtering
    is the caller's job -- this function only aggregates and gates on
    sample size). If there isn't enough historical data, returns
    `data_sufficient=False` with empty metrics rather than fabricating a
    result -- a caller must not treat that as "candidate failed
    validation," only as "not enough data to say anything yet."
    """
    sample_size = len(historical_trades)
    if sample_size < min_sample_size:
        return BacktestResult(
            candidate_id=candidate_id,
            sample_size=sample_size,
            data_sufficient=False,
            notes=(
                f"Insufficient historical data for a backtest: {sample_size} trades available, "
                f"{min_sample_size} required (MIN_TRADES_FOR_STRATEGY_VALIDATION). Refusing to "
                "fabricate a backtest result from too small a sample."
            ),
        )

    assert_single_strategy_version(historical_trades)
    stats = compute_core_statistics(historical_trades)

    return BacktestResult(
        candidate_id=candidate_id,
        sample_size=sample_size,
        data_sufficient=True,
        metrics={
            "win_rate": stats.win_rate,
            "avg_pnl_sol": stats.avg_pnl_sol,
            "median_pnl_sol": stats.median_pnl_sol,
            "profit_factor": stats.profit_factor,
            "max_drawdown_sol": stats.max_drawdown_sol,
        },
        notes="Aggregated from historical ledger trades matching the candidate's entry conditions. "
        "This is NOT a full historical-replay backtest (no fee/slippage/price-impact re-simulation "
        "against the candidate's changed parameters is performed in this phase) -- treat as a "
        "conservative first-pass filter, not a final validation.",
    )
