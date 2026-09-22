"""Candidate strategy format + hard-parameter protection (Phase 2 tasks 17/18).

A candidate is NEVER a production strategy -- it is a proposal, always
starting in `status='pending'`, that only the (not-yet-implemented)
validation pipeline could ever promote. Nothing in this module writes to
the TypeScript engine's config or HARD_RISK_PARAMETERS.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from analytics.constants import MIN_TRADES_FOR_PARAMETER_PROPOSAL
from analytics.patterns import PatternObservation


class HardParameterViolationError(ValueError):
    """Raised when a candidate's `changes` touches a hard risk parameter."""

    def __init__(self, key: str):
        super().__init__(
            f"Candidate changes may not modify hard risk parameter '{key}'. "
            "Hard risk parameters (position size, daily loss limit, max re-entries, "
            "max exposure, max concurrent positions, max slippage, max price impact, "
            "emergency stop, critical safety gates) are never modifiable by the "
            "learning system or AI -- see engine/src/config/hardRisk.ts."
        )
        self.key = key


def _normalize(key: str) -> str:
    return key.lower().replace("_", "").replace("-", "")


# Mirrors engine/src/config/hardRisk.ts's HardRiskParameters fields, plus
# common alternate spellings a candidate-generation bug or a careless AI
# analyst (later phase) might use. Comparison is done on a normalized form
# (lowercased, underscores/hyphens stripped) so "position_size",
# "positionSizeSol", "POSITION-SIZE", etc. are all caught.
_HARD_PARAMETER_ALIASES = (
    "positionsize",
    "positionsizesol",
    "dailylosslimit",
    "dailylosslimitpct",
    "maxreentriespertoken",
    "maxreentry",
    "maxreentries",
    "maxtotalexposure",
    "maxtotalexposuresol",
    "maxexposure",
    "maxconcurrentpositions",
    "maxslippage",
    "maxslippagebps",
    "maxpriceimpact",
    "maxpriceimpactbps",
    "emergencystop",
    "emergencystopenabled",
    "criticalsafetygates",
)
HARD_PARAMETER_KEYS: frozenset[str] = frozenset(_HARD_PARAMETER_ALIASES)


def is_hard_parameter(key: str) -> bool:
    return _normalize(key) in HARD_PARAMETER_KEYS


def validate_candidate_changes(changes: dict[str, Any]) -> None:
    """Raises HardParameterViolationError on the FIRST offending key found.
    Called before a candidate is ever constructed -- see build_candidate."""
    for key in changes:
        if is_hard_parameter(key):
            raise HardParameterViolationError(key)


@dataclass(frozen=True)
class Candidate:
    candidate_id: str
    parent_strategy: str
    changes: dict[str, Any]
    reason: str
    evidence: str
    sample_size: int
    created_at_ms: int
    status: str = "pending"

    def as_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "parent_strategy": self.parent_strategy,
            "changes": dict(self.changes),
            "reason": self.reason,
            "evidence": self.evidence,
            "sample_size": self.sample_size,
            "created_at_ms": self.created_at_ms,
            "status": self.status,
        }


def build_candidate(
    parent_strategy: str,
    changes: dict[str, Any],
    reason: str,
    evidence: str,
    sample_size: int,
    now_ms: int | None = None,
) -> Candidate:
    """Validates `changes` against the hard-parameter list BEFORE
    constructing anything -- a rejected candidate is never partially built."""
    validate_candidate_changes(changes)
    return Candidate(
        candidate_id=f"cand_{uuid.uuid4().hex[:12]}",
        parent_strategy=parent_strategy,
        changes=dict(changes),
        reason=reason,
        evidence=evidence,
        sample_size=sample_size,
        created_at_ms=now_ms if now_ms is not None else int(time.time() * 1000),
    )


# Conservative, explicit mapping from a feature bucket name to the ONE
# tunable (never hard) parameter a pattern about it might plausibly inform.
# Deliberately small and manual -- this is not a general rule engine, just
# enough to produce a labeled, traceable candidate from an observed pattern.
_TUNABLE_PARAMETER_BY_FEATURE: dict[str, str] = {
    "price_velocity_bucket": "min_price_velocity_5s",
    "buy_sell_ratio_bucket": "min_buy_sell_ratio",
    "volume_acceleration_bucket": "min_volume_acceleration",
    "liquidity_bucket": "min_liquidity",
    "entry_score_bucket": "min_entry_score",
}


def generate_candidates_from_patterns(
    patterns: list[PatternObservation],
    parent_strategy: str,
    sample_size: int,
    min_sample_size: int = MIN_TRADES_FOR_PARAMETER_PROPOSAL,
    now_ms: int | None = None,
) -> list[Candidate]:
    """Turns OBSERVED_CORRELATION patterns into candidate parameter
    proposals -- gated by MIN_TRADES_FOR_PARAMETER_PROPOSAL on the overall
    sample size (not just the individual pattern's bucket size, which
    MIN_TRADES_FOR_PATTERN already gated when the pattern was produced).
    Only ever proposes a KNOWN, TUNABLE parameter (see the mapping above);
    any pattern with no mapped tunable parameter, or whose feature is not
    in the safe mapping, produces no candidate at all rather than guessing.
    """
    if sample_size < min_sample_size:
        return []

    candidates: list[Candidate] = []
    for pattern in patterns:
        tunable = _TUNABLE_PARAMETER_BY_FEATURE.get(pattern.feature)
        if tunable is None:
            continue
        changes = {tunable: pattern.bucket}
        try:
            validate_candidate_changes(changes)
        except HardParameterViolationError:
            continue  # unreachable given the mapping above, but fail closed anyway
        candidates.append(
            build_candidate(
                parent_strategy=parent_strategy,
                changes=changes,
                reason=f"Observed correlation on {pattern.feature} bucket {pattern.bucket}",
                evidence=pattern.description,
                sample_size=pattern.sample_size,
                now_ms=now_ms,
            )
        )
    return candidates
