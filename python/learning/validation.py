"""Minimum sample sizes + out-of-sample splitting (Phase 2 tasks 15/20).

`split_train_validation_oos` splits STRICTLY by chronological order
(ascending entry_time_ms) -- never randomly shuffled -- specifically to
prevent look-ahead bias: a candidate can never be "validated" against
trades that happened before the trades it was trained on.
`assert_no_temporal_leakage` is a concrete, testable check for that
property, not just a comment.
"""

from __future__ import annotations

from dataclasses import dataclass

from analytics.constants import (
    MIN_TRADES_FOR_PARAMETER_PROPOSAL,
    MIN_TRADES_FOR_PATTERN,
    MIN_TRADES_FOR_STRATEGY_VALIDATION,
)

_STAGE_THRESHOLDS = {
    "pattern": MIN_TRADES_FOR_PATTERN,
    "parameter_proposal": MIN_TRADES_FOR_PARAMETER_PROPOSAL,
    "strategy_validation": MIN_TRADES_FOR_STRATEGY_VALIDATION,
}


def meets_minimum_sample_size(sample_size: int, stage: str) -> bool:
    if stage not in _STAGE_THRESHOLDS:
        raise ValueError(f"Unknown validation stage {stage!r}; expected one of {sorted(_STAGE_THRESHOLDS)}")
    return sample_size >= _STAGE_THRESHOLDS[stage]


class TemporalLeakageError(ValueError):
    """Raised when a train/validation/out-of-sample split (or a caller's
    own split) would let a candidate see future data relative to what it
    was trained on."""


@dataclass(frozen=True)
class PeriodBounds:
    start_ms: int
    end_ms: int


def _period_of(items: list[dict]) -> PeriodBounds | None:
    if not items:
        return None
    times = [i["entry_time_ms"] for i in items]
    return PeriodBounds(start_ms=min(times), end_ms=max(times))


@dataclass(frozen=True)
class TemporalSplit:
    train: list[dict]
    validation: list[dict]
    out_of_sample: list[dict]
    # Stored explicitly (task I: "store training_period/validation_period/
    # oos_period with every validation result") rather than left for a
    # caller to recompute from train/validation/out_of_sample every time.
    training_period: PeriodBounds | None = None
    validation_period: PeriodBounds | None = None
    oos_period: PeriodBounds | None = None


def split_train_validation_oos(
    trades_in_chronological_order: list[dict],
    train_frac: float = 0.6,
    validation_frac: float = 0.2,
) -> TemporalSplit:
    """Splits a chronologically-ordered trade list into train / validation /
    out-of-sample slices, in that time order (train = earliest, OOS =
    latest). `trades_in_chronological_order` MUST already be sorted
    ascending by entry_time_ms (as analytics.reader.get_closed_trades()
    returns) -- this function does not re-sort, since silently re-sorting
    a caller's data is more likely to hide a bug than catch one.
    """
    if not (0 < train_frac < 1) or not (0 < validation_frac < 1) or train_frac + validation_frac >= 1:
        raise ValueError("train_frac and validation_frac must each be in (0, 1) and sum to less than 1")

    n = len(trades_in_chronological_order)
    train_end = int(n * train_frac)
    validation_end = train_end + int(n * validation_frac)

    train = trades_in_chronological_order[:train_end]
    validation = trades_in_chronological_order[train_end:validation_end]
    out_of_sample = trades_in_chronological_order[validation_end:]

    split = TemporalSplit(
        train=train,
        validation=validation,
        out_of_sample=out_of_sample,
        training_period=_period_of(train),
        validation_period=_period_of(validation),
        oos_period=_period_of(out_of_sample),
    )
    assert_no_temporal_leakage(split)
    return split


def _entry_times(trades: list[dict]) -> list[int]:
    return [t["entry_time_ms"] for t in trades if t.get("entry_time_ms") is not None]


def assert_no_temporal_leakage(split: TemporalSplit) -> None:
    """Raises TemporalLeakageError if any trade in `validation` precedes the
    latest trade in `train`, or any trade in `out_of_sample` precedes the
    latest trade in `validation`. A caller assembling a split by hand (not
    via split_train_validation_oos) should call this before using it."""
    train_times = _entry_times(split.train)
    validation_times = _entry_times(split.validation)
    oos_times = _entry_times(split.out_of_sample)

    if train_times and validation_times and max(train_times) > min(validation_times):
        raise TemporalLeakageError(
            "Validation set contains a trade that occurred before the latest training trade -- "
            "this is look-ahead bias and the split must be rebuilt in strict chronological order."
        )
    if validation_times and oos_times and max(validation_times) > min(oos_times):
        raise TemporalLeakageError(
            "Out-of-sample set contains a trade that occurred before the latest validation trade -- "
            "this is look-ahead bias and the split must be rebuilt in strict chronological order."
        )
    if train_times and oos_times and max(train_times) > min(oos_times):
        raise TemporalLeakageError(
            "Out-of-sample set contains a trade that occurred before the latest training trade -- "
            "this is look-ahead bias and the split must be rebuilt in strict chronological order."
        )


def assert_single_strategy_version(trades: list[dict]) -> None:
    """Prevents 'mixing strategy versions incorrectly' (task 20): a
    train/validation/OOS split or a backtest sample should not silently mix
    trades taken under different strategy_version values, since that would
    conflate the candidate being evaluated with whatever else was live at
    the time. Raises ValueError naming the distinct versions found."""
    versions = {t.get("strategy_version") for t in trades if t.get("strategy_version") is not None}
    if len(versions) > 1:
        raise ValueError(f"Sample mixes multiple strategy versions ({sorted(versions)}) -- filter to one version first.")
