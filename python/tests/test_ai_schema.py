import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.ai.schema import (
    ALLOWED_SOFT_PARAMETERS,
    AIAnalysisInput,
    AIOutputValidationError,
    AnalysisPeriod,
    validate_ai_output,
)
from learning.candidates import is_hard_parameter


def make_input(**overrides) -> AIAnalysisInput:
    defaults = dict(
        strategy_version="baseline-v1",
        analysis_period=AnalysisPeriod(start="2026-01-01", end="2026-01-02"),
        sample_size=150,
        statistics={"win_rate": 0.55, "total_trades": 150},
        feature_buckets={"liquidity_bucket": {"20-30_SOL": {"trades": 60, "win_rate": 0.5}}},
        patterns=[{"feature": "liquidity_bucket", "bucket": "20-30_SOL"}],
        candidate_history=[],
        data_quality={},
        simulation_assumptions={},
    )
    defaults.update(overrides)
    return AIAnalysisInput(**defaults)


def valid_output_dict(**overrides) -> dict:
    base = {
        "analysis_id": "aia_1",
        "summary": "Sample summary.",
        "observations": [{"label": "OBSERVED", "text": "Win rate is 0.55.", "basis": "statistics.win_rate"}],
        "hypotheses": [{"label": "HYPOTHESIS", "text": "Liquidity may matter."}],
        "candidate_parameters": [],
        "confidence": "medium",
        "requires_more_data": False,
        "reasoning_basis": ["statistics.win_rate"],
        "warnings": [],
    }
    base.update(overrides)
    return base


class TestAIAnalysisInput:
    def test_to_dict_matches_the_spec_shape(self):
        i = make_input()
        d = i.to_dict()
        assert set(d.keys()) == {
            "strategy_version", "analysis_period", "sample_size", "statistics",
            "feature_buckets", "patterns", "candidate_history", "data_quality", "simulation_assumptions",
        }
        assert d["analysis_period"] == {"start": "2026-01-01", "end": "2026-01-02"}


class TestValidateAIOutputStructure:
    def test_accepts_a_well_formed_response(self):
        out = validate_ai_output(valid_output_dict(), make_input(), min_sample_size_for_candidates=100)
        assert out.analysis_id == "aia_1"
        assert out.confidence == "medium"
        assert out.rejected_parameters == []

    def test_rejects_non_dict_response(self):
        with pytest.raises(AIOutputValidationError):
            validate_ai_output([], make_input(), 100)

    def test_rejects_missing_required_field(self):
        raw = valid_output_dict()
        del raw["summary"]
        with pytest.raises(AIOutputValidationError, match="summary"):
            validate_ai_output(raw, make_input(), 100)

    def test_rejects_invalid_confidence_value(self):
        raw = valid_output_dict(confidence="very high")
        with pytest.raises(AIOutputValidationError, match="confidence"):
            validate_ai_output(raw, make_input(), 100)

    def test_rejects_non_boolean_requires_more_data(self):
        raw = valid_output_dict(requires_more_data="yes")
        with pytest.raises(AIOutputValidationError, match="requires_more_data"):
            validate_ai_output(raw, make_input(), 100)

    def test_rejects_reasoning_basis_that_is_not_a_list_of_strings(self):
        raw = valid_output_dict(reasoning_basis=[1, 2])
        with pytest.raises(AIOutputValidationError):
            validate_ai_output(raw, make_input(), 100)


class TestFactVsHypothesisSeparation:
    def test_rejects_an_observation_labeled_as_hypothesis(self):
        raw = valid_output_dict(observations=[{"label": "HYPOTHESIS", "text": "x", "basis": "statistics.win_rate"}])
        with pytest.raises(AIOutputValidationError, match="not permitted"):
            validate_ai_output(raw, make_input(), 100)

    def test_rejects_a_hypothesis_labeled_as_observed(self):
        raw = valid_output_dict(hypotheses=[{"label": "OBSERVED", "text": "x"}])
        with pytest.raises(AIOutputValidationError, match="not permitted"):
            validate_ai_output(raw, make_input(), 100)

    def test_rejects_an_unknown_label(self):
        raw = valid_output_dict(observations=[{"label": "FACT", "text": "x", "basis": "statistics.win_rate"}])
        with pytest.raises(AIOutputValidationError):
            validate_ai_output(raw, make_input(), 100)

    def test_accepts_calculated_and_assumed_as_facts(self):
        raw = valid_output_dict(
            observations=[
                {"label": "CALCULATED", "text": "x", "basis": "statistics.total_trades"},
                {"label": "ASSUMED", "text": "y", "basis": "sample_size"},
            ]
        )
        out = validate_ai_output(raw, make_input(), 100)
        assert len(out.observations) == 2


class TestHallucinationProtection:
    def test_rejects_an_observation_whose_basis_does_not_exist_in_the_input(self):
        raw = valid_output_dict(observations=[{"label": "OBSERVED", "text": "made up", "basis": "statistics.made_up_field"}])
        with pytest.raises(AIOutputValidationError, match="hallucination"):
            validate_ai_output(raw, make_input(), 100)

    def test_rejects_a_fact_with_no_basis_at_all(self):
        raw = valid_output_dict(observations=[{"label": "OBSERVED", "text": "no basis given"}])
        with pytest.raises(AIOutputValidationError, match="basis"):
            validate_ai_output(raw, make_input(), 100)

    def test_accepts_a_basis_path_into_a_nested_bucket(self):
        raw = valid_output_dict(observations=[{"label": "OBSERVED", "text": "bucketed", "basis": "feature_buckets.liquidity_bucket.20-30_SOL.win_rate"}])
        out = validate_ai_output(raw, make_input(), 100)
        assert out.observations[0]["basis"] == "feature_buckets.liquidity_bucket.20-30_SOL.win_rate"

    def test_hypotheses_never_require_a_basis(self):
        raw = valid_output_dict(hypotheses=[{"label": "HYPOTHESIS", "text": "no evidence needed for a hypothesis"}])
        out = validate_ai_output(raw, make_input(), 100)
        assert len(out.hypotheses) == 1


class TestCandidateParameterValidation:
    def test_accepts_a_whitelisted_soft_parameter(self):
        raw = valid_output_dict(candidate_parameters=[{"parameter": "min_liquidity", "proposed_value": 25}])
        out = validate_ai_output(raw, make_input(), 100)
        assert len(out.candidate_parameters) == 1
        assert out.rejected_parameters == []

    def test_rejects_a_hard_risk_parameter(self):
        raw = valid_output_dict(candidate_parameters=[{"parameter": "position_size_sol", "proposed_value": 1.0}])
        out = validate_ai_output(raw, make_input(), 100)
        assert out.candidate_parameters == []
        assert out.rejected_parameters[0].reason == "HARD_PARAMETER_MODIFICATION_REJECTED"

    @pytest.mark.parametrize("hard_param", ["position_size_sol", "daily_loss_limit_pct", "max_reentries_per_token", "max_total_exposure_sol", "max_concurrent_positions", "emergency_stop_enabled"])
    def test_rejects_every_known_hard_parameter_spelling(self, hard_param):
        raw = valid_output_dict(candidate_parameters=[{"parameter": hard_param, "proposed_value": 1}])
        out = validate_ai_output(raw, make_input(), 100)
        assert out.rejected_parameters[0].reason == "HARD_PARAMETER_MODIFICATION_REJECTED"

    def test_rejects_an_unauthorized_arbitrary_parameter_name(self):
        raw = valid_output_dict(candidate_parameters=[{"parameter": "add_a_new_indicator", "proposed_value": 1}])
        out = validate_ai_output(raw, make_input(), 100)
        assert out.candidate_parameters == []
        assert out.rejected_parameters[0].reason == "UNAUTHORIZED_PARAMETER_REJECTED"

    def test_rejects_a_non_numeric_proposed_value(self):
        raw = valid_output_dict(candidate_parameters=[{"parameter": "min_liquidity", "proposed_value": "high"}])
        out = validate_ai_output(raw, make_input(), 100)
        assert out.rejected_parameters[0].reason == "INVALID_VALUE_REJECTED"

    def test_rejects_nan_and_infinite_proposed_values(self):
        raw = valid_output_dict(candidate_parameters=[
            {"parameter": "min_liquidity", "proposed_value": float("nan")},
            {"parameter": "min_volume_1m", "proposed_value": float("inf")},
        ])
        out = validate_ai_output(raw, make_input(), 100)
        assert len(out.rejected_parameters) == 2
        assert all(r.reason == "INVALID_VALUE_REJECTED" for r in out.rejected_parameters)

    def test_insufficient_sample_size_rejects_every_candidate_parameter_regardless_of_validity(self):
        raw = valid_output_dict(candidate_parameters=[{"parameter": "min_liquidity", "proposed_value": 25}])
        out = validate_ai_output(raw, make_input(sample_size=50), min_sample_size_for_candidates=100)
        assert out.candidate_parameters == []
        assert out.rejected_parameters[0].reason == "INSUFFICIENT_DATA"

    def test_one_bad_proposal_does_not_discard_a_good_one_in_the_same_response(self):
        raw = valid_output_dict(candidate_parameters=[
            {"parameter": "min_liquidity", "proposed_value": 25},
            {"parameter": "position_size_sol", "proposed_value": 1.0},
        ])
        out = validate_ai_output(raw, make_input(), 100)
        assert len(out.candidate_parameters) == 1
        assert out.candidate_parameters[0]["parameter"] == "min_liquidity"
        assert len(out.rejected_parameters) == 1


def test_allowed_soft_parameters_never_collide_with_a_hard_parameter_alias():
    """Locks in the max_price_impact_pct (soft filter) vs maxPriceImpactBps
    (hard execution-safety limit) distinction -- a near-miss naming collision
    that would silently defeat hard-parameter protection if it ever occurred."""
    for name in ALLOWED_SOFT_PARAMETERS:
        assert not is_hard_parameter(name), f"{name!r} in ALLOWED_SOFT_PARAMETERS collides with a hard-parameter alias"
