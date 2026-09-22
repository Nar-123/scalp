import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.patterns import PATTERN_LABEL, PatternObservation
from learning.candidates import (
    HardParameterViolationError,
    build_candidate,
    generate_candidates_from_patterns,
    is_hard_parameter,
    validate_candidate_changes,
)


def test_position_size_change_is_rejected_per_spec_example():
    with pytest.raises(HardParameterViolationError):
        validate_candidate_changes({"position_size": 1})


@pytest.mark.parametrize(
    "key",
    [
        "position_size",
        "position_size_sol",
        "positionSizeSol",
        "daily_loss_limit",
        "dailyLossLimitPct",
        "max_reentries_per_token",
        "maxReentry",
        "max_total_exposure_sol",
        "max_exposure",
        "max_concurrent_positions",
        "max_slippage",
        "maxSlippageBps",
        "max_price_impact",
        "maxPriceImpactBps",
        "emergency_stop",
        "emergencyStopEnabled",
        "CRITICAL_SAFETY_GATES",
    ],
)
def test_every_hard_parameter_spelling_is_rejected(key):
    assert is_hard_parameter(key)
    with pytest.raises(HardParameterViolationError):
        validate_candidate_changes({key: 999})


def test_tunable_parameters_are_allowed():
    validate_candidate_changes({"min_price_velocity_5s": 1.5, "min_buy_sell_ratio": 1.8})  # must not raise


def test_build_candidate_rejects_before_constructing_anything():
    with pytest.raises(HardParameterViolationError):
        build_candidate(
            parent_strategy="V1",
            changes={"position_size": 1},
            reason="bad idea",
            evidence="none",
            sample_size=200,
        )


def test_build_candidate_matches_documented_format():
    candidate = build_candidate(
        parent_strategy="V1",
        changes={"min_price_velocity_5s": 1.5, "min_buy_sell_ratio": 1.8},
        reason="Observed correlation",
        evidence="60 trades in bucket X",
        sample_size=250,
        now_ms=1_700_000_000_000,
    )
    d = candidate.as_dict()
    assert d["parent_strategy"] == "V1"
    assert d["changes"] == {"min_price_velocity_5s": 1.5, "min_buy_sell_ratio": 1.8}
    assert d["sample_size"] == 250
    assert d["status"] == "pending"  # never a production strategy
    assert d["candidate_id"].startswith("cand_")


def make_pattern(feature, bucket, sample_size=200):
    return PatternObservation(
        label=PATTERN_LABEL,
        feature=feature,
        bucket=bucket,
        sample_size=sample_size,
        win_rate=0.7,
        avg_pnl_sol=0.02,
        baseline_win_rate=0.5,
        baseline_avg_pnl_sol=0.01,
        description="OBSERVED_CORRELATION: test pattern",
    )


def test_generate_candidates_gated_by_minimum_sample_size():
    patterns = [make_pattern("price_velocity_bucket", "2-3pct")]
    candidates = generate_candidates_from_patterns(patterns, parent_strategy="V1", sample_size=50, min_sample_size=100)
    assert candidates == []


def test_generate_candidates_above_minimum_sample_size():
    patterns = [make_pattern("price_velocity_bucket", "2-3pct")]
    candidates = generate_candidates_from_patterns(patterns, parent_strategy="V1", sample_size=150, min_sample_size=100)
    assert len(candidates) == 1
    assert candidates[0].changes == {"min_price_velocity_5s": "2-3pct"}
    assert candidates[0].status == "pending"


def test_generate_candidates_never_produces_a_hard_parameter_change():
    # Even a maliciously-labeled feature can't map to a hard parameter,
    # since the mapping table only contains known-safe tunables.
    patterns = [make_pattern("position_size", "1")]
    candidates = generate_candidates_from_patterns(patterns, parent_strategy="V1", sample_size=150, min_sample_size=100)
    assert candidates == []
    for candidate in candidates:
        for key in candidate.changes:
            assert not is_hard_parameter(key)


def test_generate_candidates_skips_unmapped_features():
    patterns = [make_pattern("token_age_bucket", "60-180s")]  # no tunable mapping defined
    candidates = generate_candidates_from_patterns(patterns, parent_strategy="V1", sample_size=150, min_sample_size=100)
    assert candidates == []
