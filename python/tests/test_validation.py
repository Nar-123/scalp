import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.constants import MIN_TRADES_FOR_PARAMETER_PROPOSAL, MIN_TRADES_FOR_PATTERN, MIN_TRADES_FOR_STRATEGY_VALIDATION
from learning.validation import (
    TemporalLeakageError,
    assert_no_temporal_leakage,
    assert_single_strategy_version,
    meets_minimum_sample_size,
    split_train_validation_oos,
)


def test_minimum_sample_size_thresholds_match_finalized_spec():
    assert MIN_TRADES_FOR_PATTERN == 50
    assert MIN_TRADES_FOR_PARAMETER_PROPOSAL == 100
    assert MIN_TRADES_FOR_STRATEGY_VALIDATION == 300


@pytest.mark.parametrize(
    "stage,threshold",
    [("pattern", 50), ("parameter_proposal", 100), ("strategy_validation", 300)],
)
def test_meets_minimum_sample_size_boundaries(stage, threshold):
    assert meets_minimum_sample_size(threshold, stage) is True
    assert meets_minimum_sample_size(threshold - 1, stage) is False


def test_meets_minimum_sample_size_rejects_unknown_stage():
    with pytest.raises(ValueError):
        meets_minimum_sample_size(1000, "not_a_real_stage")


def make_trades(count, start_ms=0, step_ms=1000):
    return [{"entry_time_ms": start_ms + i * step_ms, "pnl_sol": 0.01} for i in range(count)]


def test_split_is_strictly_chronological():
    trades = make_trades(100)
    split = split_train_validation_oos(trades, train_frac=0.6, validation_frac=0.2)
    assert len(split.train) == 60
    assert len(split.validation) == 20
    assert len(split.out_of_sample) == 20
    assert max(t["entry_time_ms"] for t in split.train) < min(t["entry_time_ms"] for t in split.validation)
    assert max(t["entry_time_ms"] for t in split.validation) < min(t["entry_time_ms"] for t in split.out_of_sample)


def test_split_rejects_invalid_fractions():
    trades = make_trades(10)
    with pytest.raises(ValueError):
        split_train_validation_oos(trades, train_frac=0.7, validation_frac=0.5)  # sums > 1


def test_split_records_a_period_for_every_bucket():
    trades = make_trades(100)
    split = split_train_validation_oos(trades, train_frac=0.6, validation_frac=0.2)
    assert split.training_period.start_ms == 0
    assert split.training_period.end_ms == 59_000
    assert split.validation_period.start_ms == 60_000
    assert split.validation_period.end_ms == 79_000
    assert split.oos_period.start_ms == 80_000
    assert split.oos_period.end_ms == 99_000


def test_split_records_none_period_for_an_empty_bucket():
    trades = make_trades(2)
    split = split_train_validation_oos(trades, train_frac=0.9, validation_frac=0.05)
    assert split.validation == []
    assert split.validation_period is None


def test_assert_no_temporal_leakage_passes_for_valid_split():
    trades = make_trades(90)
    split = split_train_validation_oos(trades)
    assert_no_temporal_leakage(split)  # must not raise


def test_assert_no_temporal_leakage_catches_shuffled_validation():
    from learning.validation import TemporalSplit

    train = make_trades(10, start_ms=0)
    validation = make_trades(10, start_ms=-5000)  # deliberately BEFORE training data -- look-ahead bias
    oos = make_trades(10, start_ms=100_000)
    bad_split = TemporalSplit(train=train, validation=validation, out_of_sample=oos)
    with pytest.raises(TemporalLeakageError):
        assert_no_temporal_leakage(bad_split)


def test_assert_no_temporal_leakage_catches_oos_before_validation():
    from learning.validation import TemporalSplit

    train = make_trades(10, start_ms=0)
    validation = make_trades(10, start_ms=20_000)
    oos = make_trades(10, start_ms=10_000)  # before validation -- also leakage
    bad_split = TemporalSplit(train=train, validation=validation, out_of_sample=oos)
    with pytest.raises(TemporalLeakageError):
        assert_no_temporal_leakage(bad_split)


def test_assert_single_strategy_version_passes_for_uniform_sample():
    trades = [{"strategy_version": "V1"}, {"strategy_version": "V1"}]
    assert_single_strategy_version(trades)  # must not raise


def test_assert_single_strategy_version_rejects_mixed_sample():
    trades = [{"strategy_version": "V1"}, {"strategy_version": "V1.1"}]
    with pytest.raises(ValueError):
        assert_single_strategy_version(trades)
