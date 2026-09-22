"""Strict AI input/output contracts (Phase 4 tasks 4-6, 24-26).

`AIAnalysisInput` is the ONLY shape ever sent to an AI provider -- a small,
fixed, JSON-serializable object built from already-compact local analytics
(analytics.reports/statistics/patterns), never raw ledger rows, never the
whole database. `validate_ai_output` is the ONLY way a provider's response
is accepted: anything malformed, anything naming a non-whitelisted or
hard-risk parameter, anything blurring OBSERVED fact with HYPOTHESIS, or
anything referencing a "fact" not actually present in the input we sent, is
rejected before it ever reaches the candidate system.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from learning.candidates import is_hard_parameter

# Mirrors the six tunable config groups' fields (engine/src/config/schema.ts)
# -- the ONLY parameter names an AI (or a human) candidate proposal may name.
# Anything not in this set, and not caught by is_hard_parameter first, is
# rejected as UNAUTHORIZED_PARAMETER_REJECTED (spec section 7: "AI cannot
# introduce arbitrary new trading logic").
ALLOWED_SOFT_PARAMETERS: frozenset[str] = frozenset(
    {
        "min_liquidity",
        "min_volume_1m",
        "min_buy_sell_ratio",
        "min_price_velocity_5s",
        "min_volume_acceleration",
        "max_price_impact_pct",
        "min_entry_score",
        "quick_tp_min_pct",
        "quick_tp_max_pct",
        "momentum_tp_min_pct",
        "momentum_tp_max_pct",
        "dynamic_sl_min_pct",
        "dynamic_sl_max_pct",
        "trailing_activation_pct",
        "trailing_distance_pct",
        "max_hold_time_sec",
        "liquidity_deterioration_pct",
        "reversal_drop_from_peak_pct",
        "reentry_cooldown_ms",
        "reentry_consecutive_loss_limit",
    }
)

FACT_LABELS = frozenset({"OBSERVED", "CALCULATED", "ASSUMED"})
HYPOTHESIS_LABELS = frozenset({"HYPOTHESIS", "CANDIDATE"})
ALL_LABELS = FACT_LABELS | HYPOTHESIS_LABELS
ALLOWED_CONFIDENCE = frozenset({"low", "medium", "high"})


class AIInputValidationError(ValueError):
    pass


class AIOutputValidationError(ValueError):
    """Raised by validate_ai_output for ANY malformed/invalid response --
    the caller's job is to catch this, record a rejected analysis, and
    continue normal operation (spec task 18: AI failure must never stop
    trading, and this module is never on the trading path regardless)."""


@dataclass(frozen=True)
class AnalysisPeriod:
    start: str
    end: str


@dataclass(frozen=True)
class AIAnalysisInput:
    """Exactly the shape from spec section 4 -- nothing more. `to_dict()`
    is what actually gets serialized into a prompt; there is no code path
    from this object back to a raw ledger row or full trade history."""

    strategy_version: str
    analysis_period: AnalysisPeriod
    sample_size: int
    statistics: dict[str, Any] = field(default_factory=dict)
    feature_buckets: dict[str, Any] = field(default_factory=dict)
    patterns: list[dict[str, Any]] = field(default_factory=list)
    candidate_history: list[dict[str, Any]] = field(default_factory=list)
    data_quality: dict[str, Any] = field(default_factory=dict)
    simulation_assumptions: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "strategy_version": self.strategy_version,
            "analysis_period": {"start": self.analysis_period.start, "end": self.analysis_period.end},
            "sample_size": self.sample_size,
            "statistics": self.statistics,
            "feature_buckets": self.feature_buckets,
            "patterns": self.patterns,
            "candidate_history": self.candidate_history,
            "data_quality": self.data_quality,
            "simulation_assumptions": self.simulation_assumptions,
        }


def _resolve_dotted_path(obj: Any, path: str) -> bool:
    """True if `path` (e.g. "statistics.win_rate" or
    "feature_buckets.liquidity_bucket.20-30_SOL") resolves to SOME value
    (including None/0/false -- presence, not truthiness) inside `obj`. Used
    to mechanically check that an AI-labeled OBSERVED/CALCULATED claim
    actually points at something we sent, not something the model invented
    (spec section 25, hallucination protection)."""
    current = obj
    for part in path.split("."):
        if isinstance(current, dict):
            if part not in current:
                return False
            current = current[part]
        elif isinstance(current, list):
            try:
                idx = int(part)
            except ValueError:
                return False
            if idx < 0 or idx >= len(current):
                return False
            current = current[idx]
        else:
            return False
    return True


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


@dataclass(frozen=True)
class RejectedParameter:
    parameter: str
    reason: str  # 'HARD_PARAMETER_MODIFICATION_REJECTED' | 'UNAUTHORIZED_PARAMETER_REJECTED' | 'INVALID_VALUE_REJECTED'
    raw: dict[str, Any]


@dataclass(frozen=True)
class AIAnalysisOutput:
    analysis_id: str
    summary: str
    observations: list[dict[str, Any]]
    hypotheses: list[dict[str, Any]]
    candidate_parameters: list[dict[str, Any]]  # only the ACCEPTED ones -- see rejected_parameters
    confidence: str
    requires_more_data: bool
    reasoning_basis: list[str]
    warnings: list[str]
    rejected_parameters: list[RejectedParameter] = field(default_factory=list)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AIOutputValidationError(message)


def _validate_labeled_items(items: Any, field_name: str, allowed_labels: frozenset[str], input_dict: dict[str, Any]) -> list[dict[str, Any]]:
    _require(isinstance(items, list), f"'{field_name}' must be a list")
    validated = []
    for i, item in enumerate(items):
        _require(isinstance(item, dict), f"'{field_name}[{i}]' must be an object")
        label = item.get("label")
        text = item.get("text")
        _require(label in ALL_LABELS, f"'{field_name}[{i}].label' must be one of {sorted(ALL_LABELS)}, got {label!r}")
        _require(label in allowed_labels, f"'{field_name}[{i}].label' is {label!r}, which is not permitted in '{field_name}' (fact/hypothesis must not be blurred)")
        _require(isinstance(text, str) and text.strip(), f"'{field_name}[{i}].text' must be a non-empty string")
        if label in FACT_LABELS:
            basis = item.get("basis")
            _require(isinstance(basis, str) and basis.strip(), f"'{field_name}[{i}]' is labeled {label!r} and must include a 'basis' path into the analysis input")
            _require(
                _resolve_dotted_path(input_dict, basis),
                f"'{field_name}[{i}].basis' ({basis!r}) does not resolve to anything in the analysis input -- "
                "possible hallucination: only facts present in AIAnalysisInput may be cited as observed evidence",
            )
        validated.append(item)
    return validated


def _validate_candidate_parameters(items: Any) -> tuple[list[dict[str, Any]], list[RejectedParameter]]:
    _require(isinstance(items, list), "'candidate_parameters' must be a list")
    accepted: list[dict[str, Any]] = []
    rejected: list[RejectedParameter] = []
    for i, item in enumerate(items):
        _require(isinstance(item, dict), f"'candidate_parameters[{i}]' must be an object")
        parameter = item.get("parameter")
        _require(isinstance(parameter, str) and parameter.strip(), f"'candidate_parameters[{i}].parameter' must be a non-empty string")

        if is_hard_parameter(parameter):
            rejected.append(RejectedParameter(parameter=parameter, reason="HARD_PARAMETER_MODIFICATION_REJECTED", raw=item))
            continue
        if parameter not in ALLOWED_SOFT_PARAMETERS:
            rejected.append(RejectedParameter(parameter=parameter, reason="UNAUTHORIZED_PARAMETER_REJECTED", raw=item))
            continue

        proposed_value = item.get("proposed_value")
        if not _is_finite_number(proposed_value):
            rejected.append(RejectedParameter(parameter=parameter, reason="INVALID_VALUE_REJECTED", raw=item))
            continue

        accepted.append(item)
    return accepted, rejected


def validate_ai_output(raw: dict[str, Any], analysis_input: AIAnalysisInput, min_sample_size_for_candidates: int) -> AIAnalysisOutput:
    """The ONLY entry point that turns a provider's raw parsed-JSON response
    into a trusted `AIAnalysisOutput`. Raises AIOutputValidationError on any
    structural problem. Parameter-level problems (hard/unauthorized/invalid)
    do NOT raise -- they are individually rejected and returned in
    `rejected_parameters`, so one bad proposal among several valid ones
    doesn't discard the whole analysis.
    """
    _require(isinstance(raw, dict), "AI response must be a JSON object")

    for key in ("analysis_id", "summary", "confidence", "requires_more_data"):
        _require(key in raw, f"AI response missing required field '{key}'")

    _require(isinstance(raw["analysis_id"], str) and raw["analysis_id"].strip(), "'analysis_id' must be a non-empty string")
    _require(isinstance(raw["summary"], str) and raw["summary"].strip(), "'summary' must be a non-empty string")
    _require(raw["confidence"] in ALLOWED_CONFIDENCE, f"'confidence' must be one of {sorted(ALLOWED_CONFIDENCE)}, got {raw['confidence']!r}")
    _require(isinstance(raw["requires_more_data"], bool), "'requires_more_data' must be a boolean")

    input_dict = analysis_input.to_dict()
    observations = _validate_labeled_items(raw.get("observations", []), "observations", FACT_LABELS, input_dict)
    hypotheses = _validate_labeled_items(raw.get("hypotheses", []), "hypotheses", HYPOTHESIS_LABELS, input_dict)

    reasoning_basis = raw.get("reasoning_basis", [])
    _require(isinstance(reasoning_basis, list) and all(isinstance(b, str) for b in reasoning_basis), "'reasoning_basis' must be a list of strings")

    warnings = raw.get("warnings", [])
    _require(isinstance(warnings, list) and all(isinstance(w, str) for w in warnings), "'warnings' must be a list of strings")

    candidate_parameters_raw = raw.get("candidate_parameters", [])
    if analysis_input.sample_size < min_sample_size_for_candidates:
        # INSUFFICIENT_DATA (spec task 10): never generate a parameter
        # candidate below the minimum, even if the AI proposed one anyway.
        accepted, rejected = [], [
            RejectedParameter(parameter=item.get("parameter", "?"), reason="INSUFFICIENT_DATA", raw=item)
            for item in candidate_parameters_raw
            if isinstance(item, dict)
        ]
    else:
        accepted, rejected = _validate_candidate_parameters(candidate_parameters_raw)

    return AIAnalysisOutput(
        analysis_id=raw["analysis_id"],
        summary=raw["summary"],
        observations=observations,
        hypotheses=hypotheses,
        candidate_parameters=accepted,
        confidence=raw["confidence"],
        requires_more_data=raw["requires_more_data"],
        reasoning_basis=reasoning_basis,
        warnings=warnings,
        rejected_parameters=rejected,
    )
