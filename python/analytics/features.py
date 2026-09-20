"""Feature bucketing (Phase 2 task 13).

Pure, deterministic functions turning a raw numeric entry condition into a
labeled bucket, so pattern discovery can group trades and compare outcomes
across conditions. Bucket boundaries are configurable (pass a custom
`boundaries` sequence) but ship with the ranges named in the task.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

UNKNOWN_BUCKET = "unknown"


def _bucket(value: float | None, boundaries: Sequence[tuple[float, float, str]], overflow_label: str) -> str:
    """boundaries: list of (low_inclusive, high_exclusive, label), checked
    in order; `value` must satisfy low <= value < high to match a given
    entry. For a genuinely open-ended top bucket, give its own tuple
    `float("inf")` as the high bound explicitly (as LIQUIDITY_BOUNDARIES
    etc. do) -- rather than a special "the last tuple in the list is always
    open-ended" rule, which previously caused TOKEN_AGE_BOUNDARIES's finite
    top bound (600-900s) to incorrectly swallow anything >= 600, including
    values that should have fallen through to `overflow_label` ("900s+").
    """
    if value is None:
        return UNKNOWN_BUCKET
    for low, high, label in boundaries:
        if low <= value < high:
            return label
    return overflow_label


TOKEN_AGE_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (30, 60, "30-60s"),
    (60, 180, "60-180s"),
    (180, 300, "180-300s"),
    (300, 600, "300-600s"),
    (600, 900, "600-900s"),
)


def bucket_token_age(seconds: float | None) -> str:
    if seconds is not None and seconds < 30:
        return "below_30s"  # the live strategy's own MIN_TOKEN_AGE_SEC=30 means this should not occur in real trades
    return _bucket(seconds, TOKEN_AGE_BOUNDARIES, overflow_label="900s+")


LIQUIDITY_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (20, 30, "20-30_SOL"),
    (30, 50, "30-50_SOL"),
    (50, 100, "50-100_SOL"),
    (100, float("inf"), "100+_SOL"),
)


def bucket_liquidity(sol: float | None) -> str:
    if sol is not None and sol < 20:
        return "below_20_SOL"  # the live strategy's own MIN_LIQUIDITY=20 SOL means this should not occur in real trades
    return _bucket(sol, LIQUIDITY_BOUNDARIES, overflow_label="100+_SOL")


PRICE_VELOCITY_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (1, 2, "1-2pct"),
    (2, 3, "2-3pct"),
    (3, 5, "3-5pct"),
    (5, float("inf"), "5pct+"),
)


def bucket_price_velocity(pct: float | None) -> str:
    if pct is not None and pct < 1:
        return "below_1pct"
    return _bucket(pct, PRICE_VELOCITY_BOUNDARIES, overflow_label="5pct+")


BUY_SELL_RATIO_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (1.5, 2, "1.5-2"),
    (2, 3, "2-3"),
    (3, float("inf"), "3+"),
)


def bucket_buy_sell_ratio(ratio: float | None) -> str:
    if ratio is not None and ratio < 1.5:
        return "below_1.5"
    return _bucket(ratio, BUY_SELL_RATIO_BOUNDARIES, overflow_label="3+")


VOLUME_ACCELERATION_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (1.5, 2, "1.5-2x"),
    (2, 3, "2-3x"),
    (3, float("inf"), "3x+"),
)


def bucket_volume_acceleration(multiple: float | None) -> str:
    if multiple is not None and multiple < 1.5:
        return "below_1.5x"
    return _bucket(multiple, VOLUME_ACCELERATION_BOUNDARIES, overflow_label="3x+")


PRICE_IMPACT_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (0, 0.5, "0-0.5pct"),
    (0.5, 1, "0.5-1pct"),
    (1, float("inf"), "1pct+"),
)


def bucket_price_impact(pct: float | None) -> str:
    return _bucket(pct, PRICE_IMPACT_BOUNDARIES, overflow_label="1pct+")


SLIPPAGE_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (0, 0.3, "0-0.3pct"),
    (0.3, 0.6, "0.3-0.6pct"),
    (0.6, float("inf"), "0.6pct+"),
)


def bucket_slippage(pct: float | None) -> str:
    return _bucket(pct, SLIPPAGE_BOUNDARIES, overflow_label="0.6pct+")


ENTRY_SCORE_BOUNDARIES: tuple[tuple[float, float, str], ...] = (
    (0, 3, "0-3"),
    (3, 5, "3-5"),
    (5, float("inf"), "5+"),
)


def bucket_entry_score(score: float | None) -> str:
    if score is not None and score < 0:
        return "below_0"
    return _bucket(score, ENTRY_SCORE_BOUNDARIES, overflow_label="5+")


@dataclass(frozen=True)
class FeatureBuckets:
    token_age_bucket: str
    liquidity_bucket: str
    price_velocity_bucket: str
    buy_sell_ratio_bucket: str
    volume_acceleration_bucket: str
    price_impact_bucket: str
    slippage_bucket: str
    entry_score_bucket: str

    def as_dict(self) -> dict:
        return {
            "token_age_bucket": self.token_age_bucket,
            "liquidity_bucket": self.liquidity_bucket,
            "price_velocity_bucket": self.price_velocity_bucket,
            "buy_sell_ratio_bucket": self.buy_sell_ratio_bucket,
            "volume_acceleration_bucket": self.volume_acceleration_bucket,
            "price_impact_bucket": self.price_impact_bucket,
            "slippage_bucket": self.slippage_bucket,
            "entry_score_bucket": self.entry_score_bucket,
        }


def compute_feature_buckets(trade: dict) -> FeatureBuckets:
    """Buckets every entry condition the spec names for one trade row (a
    dict shaped like analytics.reader.get_closed_trades()'s output)."""
    return FeatureBuckets(
        token_age_bucket=bucket_token_age(trade.get("entry_token_age_sec")),
        liquidity_bucket=bucket_liquidity(trade.get("entry_liquidity_sol")),
        price_velocity_bucket=bucket_price_velocity(trade.get("entry_price_velocity_5s_pct")),
        buy_sell_ratio_bucket=bucket_buy_sell_ratio(trade.get("entry_buy_sell_ratio")),
        volume_acceleration_bucket=bucket_volume_acceleration(trade.get("entry_volume_acceleration_x")),
        price_impact_bucket=bucket_price_impact(trade.get("entry_price_impact_pct")),
        slippage_bucket=bucket_slippage(trade.get("entry_slippage_pct")),
        entry_score_bucket=bucket_entry_score(trade.get("entry_score")),
    )
