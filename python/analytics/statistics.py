"""Deterministic, reproducible local statistics (Phase 2 task 12).

Every function here is a pure function over a list of trade dicts (shaped
like analytics.reader.get_closed_trades()'s output) or a derived sequence --
no randomness, no wall-clock dependence, no hidden state. Given the same
input list, every function returns exactly the same output every time.
"""

from __future__ import annotations

import statistics as pystats
from dataclasses import dataclass

from .features import FeatureBuckets, compute_feature_buckets

TP_EXIT_REASONS = frozenset({"quick_tp", "momentum_tp"})
SL_EXIT_REASONS = frozenset({"dynamic_sl"})
TIMEOUT_EXIT_REASONS = frozenset({"max_hold_timeout"})
REVERSAL_EXIT_REASONS = frozenset({"reversal"})
LIQUIDITY_EXIT_REASONS = frozenset({"liquidity_deterioration"})


def _pnl_values(trades: list[dict]) -> list[float]:
    return [t["pnl_sol"] for t in trades if t.get("pnl_sol") is not None]


@dataclass(frozen=True)
class CoreStatistics:
    total_trades: int
    wins: int
    losses: int
    win_rate: float | None
    avg_pnl_sol: float | None
    median_pnl_sol: float | None
    profit_factor: float | None
    max_drawdown_sol: float
    avg_hold_seconds: float | None
    tp_frequency: float | None
    sl_frequency: float | None
    timeout_frequency: float | None
    reversal_exit_count: int
    liquidity_exit_count: int
    max_consecutive_losses: int


def compute_max_drawdown(pnl_values_in_order: list[float]) -> float:
    """Largest peak-to-trough decline of the cumulative PnL (equity) curve,
    in SOL, given PnL values in chronological order. 0.0 for an empty or
    always-nondecreasing sequence."""
    peak = 0.0
    cumulative = 0.0
    max_drawdown = 0.0
    for pnl in pnl_values_in_order:
        cumulative += pnl
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, peak - cumulative)
    return max_drawdown


def compute_max_consecutive_losses(trades_in_order: list[dict]) -> int:
    """Longest run of consecutive losing trades (pnl_sol < 0), in
    chronological order. A trade with pnl_sol is None is treated as
    breaking a streak (it's not a confirmed loss)."""
    longest = 0
    current = 0
    for t in trades_in_order:
        pnl = t.get("pnl_sol")
        if pnl is not None and pnl < 0:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def compute_core_statistics(trades: list[dict]) -> CoreStatistics:
    """`trades` must already be in chronological order (ascending
    entry_time_ms) for max_drawdown and max_consecutive_losses to mean
    anything -- see analytics.reader.get_closed_trades()."""
    total = len(trades)
    pnl_values = _pnl_values(trades)
    wins = sum(1 for p in pnl_values if p > 0)
    losses = sum(1 for p in pnl_values if p <= 0)

    gross_profit = sum(p for p in pnl_values if p > 0)
    gross_loss = sum(-p for p in pnl_values if p < 0)

    hold_seconds = [t["hold_duration_ms"] / 1000 for t in trades if t.get("hold_duration_ms") is not None]

    exit_reasons = [t.get("exit_reason") for t in trades if t.get("exit_reason") is not None]
    closed_with_reason = len(exit_reasons)

    return CoreStatistics(
        total_trades=total,
        wins=wins,
        losses=losses,
        win_rate=(wins / total) if total > 0 else None,
        avg_pnl_sol=(sum(pnl_values) / len(pnl_values)) if pnl_values else None,
        median_pnl_sol=pystats.median(pnl_values) if pnl_values else None,
        profit_factor=(gross_profit / gross_loss) if gross_loss > 0 else None,
        max_drawdown_sol=compute_max_drawdown(pnl_values),
        avg_hold_seconds=(sum(hold_seconds) / len(hold_seconds)) if hold_seconds else None,
        tp_frequency=(sum(1 for r in exit_reasons if r in TP_EXIT_REASONS) / closed_with_reason) if closed_with_reason else None,
        sl_frequency=(sum(1 for r in exit_reasons if r in SL_EXIT_REASONS) / closed_with_reason) if closed_with_reason else None,
        timeout_frequency=(sum(1 for r in exit_reasons if r in TIMEOUT_EXIT_REASONS) / closed_with_reason) if closed_with_reason else None,
        reversal_exit_count=sum(1 for r in exit_reasons if r in REVERSAL_EXIT_REASONS),
        liquidity_exit_count=sum(1 for r in exit_reasons if r in LIQUIDITY_EXIT_REASONS),
        max_consecutive_losses=compute_max_consecutive_losses(trades),
    )


@dataclass(frozen=True)
class ReentryPerformance:
    reentry_index: int
    trades: int
    wins: int
    win_rate: float | None
    avg_pnl_sol: float | None


def compute_reentry_performance(trades: list[dict]) -> list[ReentryPerformance]:
    """One row per distinct reentry_index (0 = initial entry, 1..5 =
    re-entries), so a pattern like "re-entry 4/5 underperforms" is directly
    visible rather than buried in an aggregate."""
    by_index: dict[int, list[dict]] = {}
    for t in trades:
        idx = t.get("reentry_index")
        if idx is None:
            continue
        by_index.setdefault(idx, []).append(t)

    results = []
    for idx in sorted(by_index):
        group = by_index[idx]
        pnl_values = _pnl_values(group)
        wins = sum(1 for p in pnl_values if p > 0)
        results.append(
            ReentryPerformance(
                reentry_index=idx,
                trades=len(group),
                wins=wins,
                win_rate=(wins / len(group)) if group else None,
                avg_pnl_sol=(sum(pnl_values) / len(pnl_values)) if pnl_values else None,
            )
        )
    return results


@dataclass(frozen=True)
class BucketStats:
    bucket: str
    trades: int
    wins: int
    win_rate: float | None
    avg_pnl_sol: float | None
    median_pnl_sol: float | None


def compute_pnl_by_bucket(trades: list[dict], bucket_field: str) -> list[BucketStats]:
    """Groups trades by one of FeatureBuckets' field names (e.g.
    'liquidity_bucket', 'price_velocity_bucket') and computes win
    rate / PnL per bucket. `bucket_field` must be a valid FeatureBuckets
    attribute name -- raises AttributeError otherwise (fail loud on a typo
    rather than silently returning nothing)."""
    if bucket_field not in FeatureBuckets.__dataclass_fields__:
        raise AttributeError(f"'{bucket_field}' is not a FeatureBuckets field")

    by_bucket: dict[str, list[dict]] = {}
    for t in trades:
        buckets = compute_feature_buckets(t)
        key = getattr(buckets, bucket_field)
        by_bucket.setdefault(key, []).append(t)

    results = []
    for bucket, group in sorted(by_bucket.items()):
        pnl_values = _pnl_values(group)
        wins = sum(1 for p in pnl_values if p > 0)
        results.append(
            BucketStats(
                bucket=bucket,
                trades=len(group),
                wins=wins,
                win_rate=(wins / len(group)) if group else None,
                avg_pnl_sol=(sum(pnl_values) / len(pnl_values)) if pnl_values else None,
                median_pnl_sol=pystats.median(pnl_values) if pnl_values else None,
            )
        )
    return results
