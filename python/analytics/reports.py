"""Compact summary generation (Phase 2 task 23 -- AI token efficiency).

No AI/LLM code exists anywhere in this project yet (and none is added in
this phase). This module exists purely so that WHEN an AI analyst layer is
added later, the "send local analytics first, only ever compact JSON, never
raw data" separation is already built and easy to use -- not something that
has to be retrofitted under time pressure once an LLM call is in the loop.

`build_compact_summary` produces exactly the kind of small, fixed-shape
JSON object the original spec's AI-token-optimization example shows -- never
raw transaction history, full logs, or raw RPC responses.
"""

from __future__ import annotations

from statistics import median

from .statistics import compute_core_statistics, compute_reentry_performance


def build_compact_summary(trades: list[dict], period_label: str) -> dict:
    """A small, fixed-shape, JSON-serializable summary of `trades` --
    intentionally the only kind of payload this project's architecture
    permits ever sending to an AI analyst, once one exists. Every value is a
    plain number or string; there is no trade-level detail, no raw ledger
    rows, no logs.
    """
    core = compute_core_statistics(trades)

    slippage_values = [t["entry_slippage_pct"] for t in trades if t.get("entry_slippage_pct") is not None]
    impact_values = [t["entry_price_impact_pct"] for t in trades if t.get("entry_price_impact_pct") is not None]
    hold_seconds = [t["hold_duration_ms"] / 1000 for t in trades if t.get("hold_duration_ms") is not None]

    reentry_stats = compute_reentry_performance(trades)
    reentry_trades = sum(r.trades for r in reentry_stats if r.reentry_index > 0)
    reentry_wins = sum(r.wins for r in reentry_stats if r.reentry_index > 0)

    return {
        "period": period_label,
        "trades": core.total_trades,
        "wins": core.wins,
        "losses": core.losses,
        "win_rate": _round_or_none(core.win_rate, 4),
        "avg_pnl": _round_or_none(core.avg_pnl_sol, 6),
        "median_hold_seconds": _round_or_none(median(hold_seconds), 1) if hold_seconds else None,
        "avg_slippage": _round_or_none(_avg(slippage_values), 4),
        "avg_price_impact": _round_or_none(_avg(impact_values), 4),
        "reentry_count": reentry_trades,
        "reentry_win_rate": _round_or_none((reentry_wins / reentry_trades) if reentry_trades else None, 4),
        "max_drawdown": _round_or_none(-core.max_drawdown_sol, 6),
    }


def _avg(values: list[float]) -> float | None:
    return (sum(values) / len(values)) if values else None


def _round_or_none(value: float | None, ndigits: int) -> float | None:
    return round(value, ndigits) if value is not None else None
