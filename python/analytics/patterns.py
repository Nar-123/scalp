"""Local statistical pattern discovery (Phase 2 task 14).

Every observation this module produces is labeled OBSERVED_CORRELATION and
worded as a correlation, never a causal claim -- "trades in bucket X had a
higher win rate than the overall sample" rather than "X causes wins." This
is a hard rule, not a style preference: nothing downstream (candidate
generation, strategy versioning) is permitted to treat a pattern as more
than "the historical local data happened to look like this."

Every pattern is gated by MIN_TRADES_FOR_PATTERN -- a bucket or re-entry
group below that sample size never produces a pattern, no matter how large
its apparent deviation looks (small samples are exactly where spurious
"patterns" are most likely to appear by chance).
"""

from __future__ import annotations

from dataclasses import dataclass

from .constants import MIN_TRADES_FOR_PATTERN
from .statistics import BucketStats, ReentryPerformance, compute_core_statistics, compute_pnl_by_bucket, compute_reentry_performance

PATTERN_LABEL = "OBSERVED_CORRELATION"

# A bucket's win rate must differ from the overall baseline by at least this
# many percentage points to be worth surfacing. Arbitrary but conservative;
# configurable via discover_patterns()'s `win_rate_delta_threshold` param.
DEFAULT_WIN_RATE_DELTA_THRESHOLD = 0.10

FEATURE_BUCKET_FIELDS = (
    "token_age_bucket",
    "liquidity_bucket",
    "price_velocity_bucket",
    "buy_sell_ratio_bucket",
    "volume_acceleration_bucket",
    "price_impact_bucket",
    "slippage_bucket",
    "entry_score_bucket",
)


@dataclass(frozen=True)
class PatternObservation:
    label: str  # always PATTERN_LABEL
    feature: str
    bucket: str
    sample_size: int
    win_rate: float | None
    avg_pnl_sol: float | None
    baseline_win_rate: float | None
    baseline_avg_pnl_sol: float | None
    description: str


def _describe(feature: str, bucket: str, stats: BucketStats, baseline_win_rate: float | None) -> str:
    direction = "higher" if (stats.win_rate or 0) >= (baseline_win_rate or 0) else "lower"
    return (
        f"{PATTERN_LABEL}: trades where {feature}={bucket} (n={stats.trades}) had a "
        f"{direction} win rate ({stats.win_rate:.1%} vs baseline {baseline_win_rate:.1%}) "
        f"than the overall sample. This is a correlation observed in local historical "
        f"data only -- it is not evidence of causation and has not been validated."
    )


def discover_feature_patterns(
    trades: list[dict],
    min_sample_size: int = MIN_TRADES_FOR_PATTERN,
    win_rate_delta_threshold: float = DEFAULT_WIN_RATE_DELTA_THRESHOLD,
) -> list[PatternObservation]:
    """Scans every feature bucket dimension named in spec section 13/14 and
    reports buckets whose win rate deviates from the overall baseline by at
    least `win_rate_delta_threshold`, provided the bucket has at least
    `min_sample_size` trades."""
    baseline = compute_core_statistics(trades)
    if baseline.win_rate is None:
        return []

    observations: list[PatternObservation] = []
    for feature in FEATURE_BUCKET_FIELDS:
        for bucket_stats in compute_pnl_by_bucket(trades, feature):
            if bucket_stats.trades < min_sample_size:
                continue
            if bucket_stats.win_rate is None:
                continue
            if abs(bucket_stats.win_rate - baseline.win_rate) < win_rate_delta_threshold:
                continue
            observations.append(
                PatternObservation(
                    label=PATTERN_LABEL,
                    feature=feature,
                    bucket=bucket_stats.bucket,
                    sample_size=bucket_stats.trades,
                    win_rate=bucket_stats.win_rate,
                    avg_pnl_sol=bucket_stats.avg_pnl_sol,
                    baseline_win_rate=baseline.win_rate,
                    baseline_avg_pnl_sol=baseline.avg_pnl_sol,
                    description=_describe(feature, bucket_stats.bucket, bucket_stats, baseline.win_rate),
                )
            )
    return observations


def discover_reentry_patterns(
    trades: list[dict],
    min_sample_size: int = MIN_TRADES_FOR_PATTERN,
    win_rate_delta_threshold: float = DEFAULT_WIN_RATE_DELTA_THRESHOLD,
) -> list[PatternObservation]:
    """Specifically checks whether any re-entry index (e.g. "re-entry 4/5")
    performs notably differently from the initial entry (reentry_index=0),
    per the task's named example pattern."""
    baseline = compute_core_statistics(trades)
    if baseline.win_rate is None:
        return []

    reentry_stats: list[ReentryPerformance] = compute_reentry_performance(trades)
    observations: list[PatternObservation] = []
    for stat in reentry_stats:
        if stat.reentry_index == 0:
            continue  # baseline comparison group, not itself a "re-entry pattern"
        if stat.trades < min_sample_size or stat.win_rate is None:
            continue
        if abs(stat.win_rate - baseline.win_rate) < win_rate_delta_threshold:
            continue
        direction = "higher" if stat.win_rate >= baseline.win_rate else "lower"
        observations.append(
            PatternObservation(
                label=PATTERN_LABEL,
                feature="reentry_index",
                bucket=str(stat.reentry_index),
                sample_size=stat.trades,
                win_rate=stat.win_rate,
                avg_pnl_sol=stat.avg_pnl_sol,
                baseline_win_rate=baseline.win_rate,
                baseline_avg_pnl_sol=baseline.avg_pnl_sol,
                description=(
                    f"{PATTERN_LABEL}: re-entry #{stat.reentry_index} (n={stat.trades}) had a "
                    f"{direction} win rate ({stat.win_rate:.1%} vs overall {baseline.win_rate:.1%}). "
                    f"Correlation only, not validated."
                ),
            )
        )
    return observations


def discover_patterns(
    trades: list[dict],
    min_sample_size: int = MIN_TRADES_FOR_PATTERN,
    win_rate_delta_threshold: float = DEFAULT_WIN_RATE_DELTA_THRESHOLD,
) -> list[PatternObservation]:
    """Runs every pattern-discovery pass this module implements."""
    return discover_feature_patterns(trades, min_sample_size, win_rate_delta_threshold) + discover_reentry_patterns(
        trades, min_sample_size, win_rate_delta_threshold
    )
