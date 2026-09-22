"""AI Analysis Service (Phase 4 orchestrator).

Wires together: local-analysis-first gating (task 12), the compact
AIAnalysisInput builder, caching (task 14), the provider abstraction (task
16), strict output validation + hard-parameter protection (tasks 5-8,
24-25), usage tracking (task 19), and candidate handoff into the EXISTING
candidate system (task 26) -- never a second candidate implementation.

This module is never imported by, or reachable from, the realtime trading
path (engine/src/orchestrator, risk, exit -- all TypeScript). It is pure
offline research tooling invoked by a scheduler or a manual CLI, and every
failure mode here (provider timeout, malformed response, rejected
parameter) ends in a returned AIAnalysisResult, never an exception that
could propagate into anything trading-adjacent.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from typing import Any

from analytics.constants import AI_DEFAULT_PROMPT_VERSION, AI_MAX_OUTPUT_TOKENS, MIN_TRADES_FOR_PARAMETER_PROPOSAL, MIN_TRADES_FOR_PATTERN
from analytics.features import FeatureBuckets
from analytics.patterns import discover_patterns
from analytics.statistics import compute_core_statistics, compute_pnl_by_bucket
from learning.candidates import build_candidate
from learning.db import (
    get_cached_ai_analysis,
    record_ai_analysis,
    record_ai_rejected_proposal,
    record_ai_usage,
    record_candidate,
)

from .cache import compute_cache_key, compute_feature_hash, compute_pattern_hash
from .provider import AIProvider, AIProviderError
from .sanitize import sanitize_for_ai
from .schema import AIAnalysisInput, AIOutputValidationError, AnalysisPeriod, validate_ai_output
from .usage import estimate_cost_usd

PROMPT_PREAMBLE = (
    "You are an analyst reviewing trading-system statistics. You are not a trader. "
    "Do not give BUY/SELL instructions. Do not make profitability claims. "
    "Distinguish observations from hypotheses using the labels OBSERVED, CALCULATED, "
    "ASSUMED, HYPOTHESIS, and CANDIDATE. Only propose changes to whitelisted soft "
    "parameters. Never propose changes to hard risk parameters. Any candidate must be "
    "tested by the deterministic backtest/OOS/shadow pipeline before it can ever be "
    "promoted."
)


@dataclass(frozen=True)
class AIAnalysisResult:
    status: str  # 'completed' | 'insufficient_data' | 'skipped_not_meaningful' | 'cache_hit' | 'failed'
    analysis_id: str | None
    cache_hit: bool
    candidates_created: list[str]
    rejected_parameters: list[dict[str, Any]]
    notes: str


def _feature_bucket_summary(trades: list[dict]) -> dict[str, Any]:
    """Compact -- bucket name -> {trades, win_rate, avg_pnl_sol} per feature
    dimension. Never raw trades: this is the same aggregation pattern
    analytics.reports.build_compact_summary already uses for a single
    overall summary, applied per-bucket here."""
    summary: dict[str, Any] = {}
    for field_name in FeatureBuckets.__dataclass_fields__:
        buckets = compute_pnl_by_bucket(trades, field_name)
        summary[field_name] = {b.bucket: {"trades": b.trades, "win_rate": b.win_rate, "avg_pnl_sol": b.avg_pnl_sol} for b in buckets}
    return summary


def detect_meaningful_change(
    patterns: list,
    core_stats,
    previous_win_rate: float | None = None,
    win_rate_delta_threshold: float = 0.1,
    consecutive_loss_threshold: int = 3,
) -> tuple[bool, str]:
    """Concrete (not stubbed) trigger logic for spec section 11: a
    statistically notable pattern, a repeated-loss streak, or a meaningful
    win-rate shift since the previous analysis. Returns (is_meaningful, reason).
    Section 11's other listed triggers (candidate requiring interpretation,
    scheduled review, manual command) are caller-driven, not detected here --
    a scheduled or manual caller passes `force=True` to bypass this gate
    entirely rather than trying to make this function detect "it's been 6
    hours" itself.
    """
    if patterns:
        return True, "statistically_notable_pattern"
    if core_stats.max_consecutive_losses >= consecutive_loss_threshold:
        return True, "repeated_loss_pattern"
    if previous_win_rate is not None and core_stats.win_rate is not None:
        if abs(core_stats.win_rate - previous_win_rate) >= win_rate_delta_threshold:
            return True, "meaningful_performance_change"
    return False, "no_meaningful_change"


class AIAnalysisService:
    def __init__(
        self,
        provider: AIProvider,
        provider_name: str,
        model: str,
        prompt_version: str = AI_DEFAULT_PROMPT_VERSION,
        max_output_tokens: int = AI_MAX_OUTPUT_TOKENS,
        pricing_table: dict[str, tuple[float, float]] | None = None,
    ):
        self.provider = provider
        self.provider_name = provider_name
        self.model = model
        self.prompt_version = prompt_version
        self.max_output_tokens = max_output_tokens
        self.pricing_table = pricing_table

    def build_input(
        self,
        trades: list[dict],
        strategy_version: str,
        period_start: str,
        period_end: str,
        candidate_history: list[dict] | None = None,
        data_quality: dict | None = None,
        simulation_assumptions: dict | None = None,
    ) -> AIAnalysisInput:
        core = compute_core_statistics(trades)
        patterns = discover_patterns(trades)
        return AIAnalysisInput(
            strategy_version=strategy_version,
            analysis_period=AnalysisPeriod(start=period_start, end=period_end),
            sample_size=len(trades),
            statistics={
                "total_trades": core.total_trades,
                "wins": core.wins,
                "losses": core.losses,
                "win_rate": core.win_rate,
                "avg_pnl_sol": core.avg_pnl_sol,
                "median_pnl_sol": core.median_pnl_sol,
                "profit_factor": core.profit_factor,
                "max_drawdown_sol": core.max_drawdown_sol,
                "max_consecutive_losses": core.max_consecutive_losses,
                "tp_frequency": core.tp_frequency,
                "sl_frequency": core.sl_frequency,
                "timeout_frequency": core.timeout_frequency,
            },
            feature_buckets=_feature_bucket_summary(trades),
            patterns=[
                {
                    "feature": p.feature,
                    "bucket": p.bucket,
                    "sample_size": p.sample_size,
                    "win_rate": p.win_rate,
                    "avg_pnl_sol": p.avg_pnl_sol,
                    "description": p.description,
                }
                for p in patterns
            ],
            candidate_history=candidate_history or [],
            data_quality=data_quality or {},
            simulation_assumptions=simulation_assumptions or {},
        )

    def _build_prompt(self, analysis_input: AIAnalysisInput) -> str:
        payload = sanitize_for_ai(analysis_input.to_dict())
        return PROMPT_PREAMBLE + "\n\nAnalysis input (JSON):\n" + json.dumps(payload, sort_keys=True)

    def analyze(
        self,
        conn: sqlite3.Connection,
        trades: list[dict],
        strategy_version: str,
        period_start: str,
        period_end: str,
        trigger_reason: str,
        force: bool = False,
        previous_win_rate: float | None = None,
        candidate_history: list[dict] | None = None,
        data_quality: dict | None = None,
        simulation_assumptions: dict | None = None,
        min_sample_size_for_candidates: int = MIN_TRADES_FOR_PARAMETER_PROPOSAL,
        period_start_ms: int | None = None,
        period_end_ms: int | None = None,
        now_ms: int | None = None,
    ) -> AIAnalysisResult:
        """Implements spec section 12's pipeline end to end: local analytics
        -> pattern discovery -> sample-size check -> meaningful-change check
        -> compact input -> (cache check ->) provider call -> validation ->
        candidate handoff. Any early exit (insufficient data, not
        meaningful, cache hit, provider/validation failure) returns before
        ever constructing a candidate -- there is no path from a rejected or
        skipped analysis to a candidate_strategies row.
        """
        now_ms = now_ms if now_ms is not None else int(time.time() * 1000)

        if len(trades) < MIN_TRADES_FOR_PATTERN:
            return AIAnalysisResult(
                status="insufficient_data",
                analysis_id=None,
                cache_hit=False,
                candidates_created=[],
                rejected_parameters=[],
                notes=f"INSUFFICIENT_DATA: {len(trades)} trades, {MIN_TRADES_FOR_PATTERN} required for pattern discovery.",
            )

        core = compute_core_statistics(trades)
        patterns = discover_patterns(trades)

        if not force:
            meaningful, reason = detect_meaningful_change(patterns, core, previous_win_rate)
            if not meaningful:
                return AIAnalysisResult(
                    status="skipped_not_meaningful",
                    analysis_id=None,
                    cache_hit=False,
                    candidates_created=[],
                    rejected_parameters=[],
                    notes=f"No meaningful change detected ({reason}) -- AI was not called.",
                )
            trigger_reason = reason

        analysis_input = self.build_input(
            trades,
            strategy_version,
            period_start,
            period_end,
            candidate_history=candidate_history,
            data_quality=data_quality,
            simulation_assumptions=simulation_assumptions,
        )

        feature_hash = compute_feature_hash(analysis_input.feature_buckets)
        pattern_hash = compute_pattern_hash(analysis_input.patterns)
        cache_key = compute_cache_key(strategy_version, period_start, period_end, feature_hash, pattern_hash, self.model, self.prompt_version)

        cached = get_cached_ai_analysis(conn, cache_key)
        if cached is not None:
            record_ai_usage(
                conn,
                request_id=f"req_{uuid.uuid4().hex[:12]}",
                analysis_id=cached["analysis_id"],
                timestamp_ms=now_ms,
                provider=self.provider_name,
                model=self.model,
                analysis_reason=trigger_reason,
                input_tokens=0,
                output_tokens=0,
                cache_hit=True,
                success=True,
                latency_ms=0.0,
            )
            return AIAnalysisResult(
                status="cache_hit",
                analysis_id=cached["analysis_id"],
                cache_hit=True,
                candidates_created=[],
                rejected_parameters=[],
                notes="Identical analysis already exists; returned from cache without another provider call.",
            )

        analysis_id = f"aia_{uuid.uuid4().hex[:12]}"
        prompt = self._build_prompt(analysis_input)
        request_id = f"req_{uuid.uuid4().hex[:12]}"
        input_json = json.dumps(analysis_input.to_dict())

        try:
            response = self.provider.analyze(prompt, max_output_tokens=self.max_output_tokens)
        except AIProviderError as exc:
            record_ai_usage(
                conn, request_id=request_id, analysis_id=analysis_id, timestamp_ms=now_ms,
                provider=self.provider_name, model=self.model, analysis_reason=trigger_reason,
                input_tokens=0, output_tokens=0, cache_hit=False, success=False, latency_ms=0.0, error=str(exc),
            )
            record_ai_analysis(
                conn, analysis_id=analysis_id, created_at_ms=now_ms, strategy_version=strategy_version,
                analysis_period_start_ms=period_start_ms, analysis_period_end_ms=period_end_ms, sample_size=len(trades),
                trigger_reason=trigger_reason, cache_key=cache_key, cache_hit=False,
                provider=self.provider_name, model=self.model, prompt_version=self.prompt_version,
                input_json=input_json, output_json=None, confidence=None, requires_more_data=None,
                status="failed", error=str(exc),
            )
            return AIAnalysisResult(status="failed", analysis_id=analysis_id, cache_hit=False, candidates_created=[], rejected_parameters=[], notes=f"Provider error: {exc}")

        if not response.raw_text.strip():
            record_ai_usage(
                conn, request_id=request_id, analysis_id=analysis_id, timestamp_ms=now_ms,
                provider=self.provider_name, model=self.model, analysis_reason=trigger_reason,
                input_tokens=response.input_tokens, output_tokens=response.output_tokens,
                cache_hit=False, success=False, latency_ms=response.latency_ms, error="empty response",
            )
            record_ai_analysis(
                conn, analysis_id=analysis_id, created_at_ms=now_ms, strategy_version=strategy_version,
                analysis_period_start_ms=period_start_ms, analysis_period_end_ms=period_end_ms, sample_size=len(trades),
                trigger_reason=trigger_reason, cache_key=cache_key, cache_hit=False,
                provider=self.provider_name, model=self.model, prompt_version=self.prompt_version,
                input_json=input_json, output_json=None, confidence=None, requires_more_data=None,
                status="failed", error="empty response",
            )
            return AIAnalysisResult(status="failed", analysis_id=analysis_id, cache_hit=False, candidates_created=[], rejected_parameters=[], notes="Provider returned an empty response.")

        try:
            raw_output = json.loads(response.raw_text)
        except json.JSONDecodeError as exc:
            record_ai_usage(
                conn, request_id=request_id, analysis_id=analysis_id, timestamp_ms=now_ms,
                provider=self.provider_name, model=self.model, analysis_reason=trigger_reason,
                input_tokens=response.input_tokens, output_tokens=response.output_tokens,
                cache_hit=False, success=False, latency_ms=response.latency_ms, error=f"malformed JSON: {exc}",
            )
            record_ai_analysis(
                conn, analysis_id=analysis_id, created_at_ms=now_ms, strategy_version=strategy_version,
                analysis_period_start_ms=period_start_ms, analysis_period_end_ms=period_end_ms, sample_size=len(trades),
                trigger_reason=trigger_reason, cache_key=cache_key, cache_hit=False,
                provider=self.provider_name, model=self.model, prompt_version=self.prompt_version,
                input_json=input_json, output_json=response.raw_text, confidence=None, requires_more_data=None,
                status="failed", error=f"malformed JSON: {exc}",
            )
            return AIAnalysisResult(status="failed", analysis_id=analysis_id, cache_hit=False, candidates_created=[], rejected_parameters=[], notes=f"Provider returned malformed JSON: {exc}")

        try:
            output = validate_ai_output(raw_output, analysis_input, min_sample_size_for_candidates)
        except AIOutputValidationError as exc:
            record_ai_usage(
                conn, request_id=request_id, analysis_id=analysis_id, timestamp_ms=now_ms,
                provider=self.provider_name, model=self.model, analysis_reason=trigger_reason,
                input_tokens=response.input_tokens, output_tokens=response.output_tokens,
                cache_hit=False, success=False, latency_ms=response.latency_ms, error=str(exc),
            )
            record_ai_analysis(
                conn, analysis_id=analysis_id, created_at_ms=now_ms, strategy_version=strategy_version,
                analysis_period_start_ms=period_start_ms, analysis_period_end_ms=period_end_ms, sample_size=len(trades),
                trigger_reason=trigger_reason, cache_key=cache_key, cache_hit=False,
                provider=self.provider_name, model=self.model, prompt_version=self.prompt_version,
                input_json=input_json, output_json=response.raw_text, confidence=None, requires_more_data=None,
                status="rejected", error=str(exc),
            )
            return AIAnalysisResult(status="failed", analysis_id=analysis_id, cache_hit=False, candidates_created=[], rejected_parameters=[], notes=f"AI response failed validation: {exc}")

        cost = estimate_cost_usd(self.model, response.input_tokens, response.output_tokens, self.pricing_table)
        record_ai_usage(
            conn, request_id=request_id, analysis_id=analysis_id, timestamp_ms=now_ms,
            provider=self.provider_name, model=self.model, analysis_reason=trigger_reason,
            input_tokens=response.input_tokens, output_tokens=response.output_tokens,
            cache_hit=False, success=True, latency_ms=response.latency_ms, estimated_cost_usd=cost,
        )
        record_ai_analysis(
            conn, analysis_id=analysis_id, created_at_ms=now_ms, strategy_version=strategy_version,
            analysis_period_start_ms=period_start_ms, analysis_period_end_ms=period_end_ms, sample_size=len(trades),
            trigger_reason=trigger_reason, cache_key=cache_key, cache_hit=False,
            provider=self.provider_name, model=self.model, prompt_version=self.prompt_version,
            input_json=input_json, output_json=json.dumps(raw_output),
            confidence=output.confidence, requires_more_data=output.requires_more_data, status="completed",
        )

        for rejected in output.rejected_parameters:
            record_ai_rejected_proposal(
                conn, proposal_id=f"rej_{uuid.uuid4().hex[:12]}", analysis_id=analysis_id, created_at_ms=now_ms,
                attempted_parameter=rejected.parameter, reason=rejected.reason, raw_proposal=rejected.raw,
            )

        # Candidate handoff (spec task 26): the EXISTING candidate system,
        # never a second implementation. build_candidate independently
        # re-validates against the hard-parameter list -- a second,
        # unrelated check catching the same class of mistake defense-in-depth.
        candidates_created: list[str] = []
        for proposal in output.candidate_parameters:
            changes = {proposal["parameter"]: proposal["proposed_value"]}
            candidate = build_candidate(
                parent_strategy=strategy_version,
                changes=changes,
                reason=f"AI analyst proposal ({analysis_id})",
                evidence=proposal.get("rationale", output.summary),
                sample_size=len(trades),
                now_ms=now_ms,
            )
            record_candidate(conn, candidate.as_dict(), origin="ai_analyst")
            candidates_created.append(candidate.candidate_id)

        return AIAnalysisResult(
            status="completed",
            analysis_id=analysis_id,
            cache_hit=False,
            candidates_created=candidates_created,
            rejected_parameters=[{"parameter": r.parameter, "reason": r.reason} for r in output.rejected_parameters],
            notes=output.summary,
        )
