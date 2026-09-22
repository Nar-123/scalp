"""Owns the "learning" tables in the shared SQLite file (Phase 2 task 11).

SQLite remains the single source of truth: this module does NOT create a
second database. It opens the SAME file the TypeScript engine writes
(`data/ledger.sqlite`) with a normal read-write connection, and creates
(idempotently, `CREATE TABLE IF NOT EXISTS`) only the tables this package
owns: strategy_versions, feature_snapshots, learning_runs,
candidate_strategies, validation_results. It never touches the "trading
truth" tables (trades, token_evaluations, daily_risk_state) -- those stay
read-only from Python (see analytics/reader.py) and are never written here.

Every write function takes plain Python values and does its own JSON
encoding, so callers never construct raw SQL themselves.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from analytics.schema_contract import (
    AI_ANALYSES_TABLE,
    AI_REJECTED_PROPOSALS_TABLE,
    AI_USAGE_LOG_TABLE,
    CANDIDATE_STRATEGIES_TABLE,
    FEATURE_SNAPSHOTS_TABLE,
    LEARNING_RUNS_TABLE,
    STRATEGY_VERSIONS_TABLE,
    VALIDATION_RESULTS_TABLE,
)

_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS {STRATEGY_VERSIONS_TABLE} (
  version TEXT PRIMARY KEY,
  parent_version TEXT,
  parameters_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  reason TEXT,
  evidence TEXT,
  backtest_result_json TEXT,
  oos_result_json TEXT,
  shadow_result_json TEXT,
  validation_status TEXT NOT NULL DEFAULT 'proposed'
);

CREATE TABLE IF NOT EXISTS {FEATURE_SNAPSHOTS_TABLE} (
  id TEXT PRIMARY KEY,
  trade_id TEXT,
  computed_at_ms INTEGER NOT NULL,
  token_age_bucket TEXT,
  liquidity_bucket TEXT,
  price_velocity_bucket TEXT,
  buy_sell_ratio_bucket TEXT,
  volume_acceleration_bucket TEXT,
  price_impact_bucket TEXT,
  slippage_bucket TEXT,
  entry_score_bucket TEXT,
  features_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feature_snapshots_trade ON {FEATURE_SNAPSHOTS_TABLE}(trade_id);

CREATE TABLE IF NOT EXISTS {LEARNING_RUNS_TABLE} (
  id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  trigger TEXT NOT NULL,
  sample_size INTEGER,
  strategy_version TEXT,
  summary_json TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS {CANDIDATE_STRATEGIES_TABLE} (
  candidate_id TEXT PRIMARY KEY,
  parent_strategy TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  reason TEXT,
  evidence TEXT,
  sample_size INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  learning_run_id TEXT,
  rejected INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_candidate_strategies_run ON {CANDIDATE_STRATEGIES_TABLE}(learning_run_id);

CREATE TABLE IF NOT EXISTS {VALIDATION_RESULTS_TABLE} (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  passed INTEGER,
  metrics_json TEXT,
  sample_size INTEGER,
  created_at_ms INTEGER NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_validation_results_candidate ON {VALIDATION_RESULTS_TABLE}(candidate_id);

-- Phase 4 (AI analyst / research layer) tables. AI is never on the
-- realtime trading path -- these exist purely to make AI analysis runs
-- auditable, cacheable, and cost-trackable offline.
CREATE TABLE IF NOT EXISTS {AI_ANALYSES_TABLE} (
  analysis_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  strategy_version TEXT,
  analysis_period_start_ms INTEGER,
  analysis_period_end_ms INTEGER,
  sample_size INTEGER,
  trigger_reason TEXT,
  cache_key TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  input_json TEXT NOT NULL,
  output_json TEXT,
  confidence TEXT,
  requires_more_data INTEGER,
  status TEXT NOT NULL DEFAULT 'completed',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_cache_key ON {AI_ANALYSES_TABLE}(cache_key);

CREATE TABLE IF NOT EXISTS {AI_REJECTED_PROPOSALS_TABLE} (
  id TEXT PRIMARY KEY,
  analysis_id TEXT,
  created_at_ms INTEGER NOT NULL,
  attempted_parameter TEXT NOT NULL,
  reason TEXT NOT NULL,
  raw_proposal_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_rejected_proposals_analysis ON {AI_REJECTED_PROPOSALS_TABLE}(analysis_id);

CREATE TABLE IF NOT EXISTS {AI_USAGE_LOG_TABLE} (
  request_id TEXT PRIMARY KEY,
  analysis_id TEXT,
  timestamp_ms INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  analysis_reason TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL,
  error TEXT,
  latency_ms REAL,
  estimated_cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_timestamp ON {AI_USAGE_LOG_TABLE}(timestamp_ms);
"""


# Additive columns for learning_runs (Phase 3-alt task 23): granular
# per-run fields a strategy performance report or a scheduler needs to
# inspect without re-parsing summary_json. Added via idempotent ALTER TABLE
# (mirroring engine/src/ledger/db.ts's applyAdditiveColumns) so existing
# Phase 2 databases upgrade in place rather than needing a destructive
# migration.
_LEARNING_RUNS_ADDITIVE_COLUMNS: tuple[str, ...] = (
    "data_range_start_ms",
    "data_range_end_ms",
    "candidates_tested",
    "candidates_passed",
    "candidates_rejected",
    "error",
)

# Phase 4: distinguishes an AI-proposed candidate from one generated by
# local pattern discovery alone, for audit/reporting -- never changes how a
# candidate is validated or promoted (the pipeline is identical either way).
_CANDIDATE_STRATEGIES_ADDITIVE_COLUMNS: tuple[str, ...] = ("origin",)


def _apply_additive_columns(conn: sqlite3.Connection, table: str, columns: tuple[str, ...]) -> None:
    existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    for column in columns:
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column}")


@contextmanager
def open_learning_db(db_path: str) -> Iterator[sqlite3.Connection]:
    """Read-write connection, but ONLY ever used against the tables this
    module creates above -- never trades/token_evaluations/daily_risk_state.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(_SCHEMA)
    _apply_additive_columns(conn, LEARNING_RUNS_TABLE, _LEARNING_RUNS_ADDITIVE_COLUMNS)
    _apply_additive_columns(conn, CANDIDATE_STRATEGIES_TABLE, _CANDIDATE_STRATEGIES_ADDITIVE_COLUMNS)
    conn.commit()
    try:
        yield conn
    finally:
        conn.close()


def record_strategy_version(
    conn: sqlite3.Connection,
    version: str,
    parent_version: str | None,
    parameters: dict[str, Any],
    created_at_ms: int,
    reason: str | None = None,
    evidence: str | None = None,
) -> None:
    conn.execute(
        f"""INSERT INTO {STRATEGY_VERSIONS_TABLE}
            (version, parent_version, parameters_json, created_at_ms, reason, evidence)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(version) DO NOTHING""",
        (version, parent_version, json.dumps(parameters), created_at_ms, reason, evidence),
    )
    conn.commit()


def update_strategy_validation_status(conn: sqlite3.Connection, version: str, status: str) -> None:
    conn.execute(
        f"UPDATE {STRATEGY_VERSIONS_TABLE} SET validation_status = ? WHERE version = ?",
        (status, version),
    )
    conn.commit()


def start_learning_run(conn: sqlite3.Connection, run_id: str, trigger: str, started_at_ms: int) -> None:
    conn.execute(
        f"""INSERT INTO {LEARNING_RUNS_TABLE} (id, started_at_ms, trigger, status)
            VALUES (?, ?, ?, 'running')""",
        (run_id, started_at_ms, trigger),
    )
    conn.commit()


def complete_learning_run(
    conn: sqlite3.Connection,
    run_id: str,
    completed_at_ms: int,
    sample_size: int,
    strategy_version: str,
    summary: dict[str, Any],
    status: str = "completed",
    data_range_start_ms: int | None = None,
    data_range_end_ms: int | None = None,
    candidates_tested: int = 0,
    candidates_passed: int = 0,
    candidates_rejected: int = 0,
    error: str | None = None,
) -> None:
    conn.execute(
        f"""UPDATE {LEARNING_RUNS_TABLE}
            SET completed_at_ms = ?, sample_size = ?, strategy_version = ?, summary_json = ?, status = ?,
                data_range_start_ms = ?, data_range_end_ms = ?,
                candidates_tested = ?, candidates_passed = ?, candidates_rejected = ?, error = ?
            WHERE id = ?""",
        (
            completed_at_ms,
            sample_size,
            strategy_version,
            json.dumps(summary),
            status,
            data_range_start_ms,
            data_range_end_ms,
            candidates_tested,
            candidates_passed,
            candidates_rejected,
            error,
            run_id,
        ),
    )
    conn.commit()


def has_running_learning_run(conn: sqlite3.Connection, now_ms: int, stale_after_ms: int = 600_000) -> bool:
    """True if a learning_runs row is status='running' and was started
    recently enough to still plausibly be alive (spec task 22: 'avoid
    duplicate learning runs'). A 'running' row older than `stale_after_ms`
    is treated as an orphan from a crashed process, NOT as still running --
    otherwise one crash would permanently wedge every future run."""
    row = conn.execute(
        f"SELECT COUNT(*) AS n FROM {LEARNING_RUNS_TABLE} WHERE status = 'running' AND ? - started_at_ms < ?",
        (now_ms, stale_after_ms),
    ).fetchone()
    return bool(row["n"])


def get_last_processed_watermark_ms(conn: sqlite3.Connection, strategy_version: str) -> int | None:
    """Latest `data_range_end_ms` among this strategy version's COMPLETED
    (non-skipped, non-failed) learning runs -- the incremental-learning
    watermark (task 24). None if no completed run has recorded a data range
    yet, meaning the next run must treat everything as new."""
    row = conn.execute(
        f"""SELECT MAX(data_range_end_ms) AS watermark FROM {LEARNING_RUNS_TABLE}
            WHERE strategy_version = ? AND status = 'completed' AND data_range_end_ms IS NOT NULL""",
        (strategy_version,),
    ).fetchone()
    return row["watermark"]


def update_candidate_status(conn: sqlite3.Connection, candidate_id: str, status: str, rejection_reason: str | None = None) -> None:
    conn.execute(
        f"""UPDATE {CANDIDATE_STRATEGIES_TABLE}
            SET status = ?, rejected = ?, rejection_reason = ?
            WHERE candidate_id = ?""",
        (status, 1 if status == "rejected" else 0, rejection_reason, candidate_id),
    )
    conn.commit()


def record_candidate(conn: sqlite3.Connection, candidate: dict[str, Any], learning_run_id: str | None = None, origin: str = "local_pattern_discovery") -> None:
    conn.execute(
        f"""INSERT INTO {CANDIDATE_STRATEGIES_TABLE}
            (candidate_id, parent_strategy, changes_json, reason, evidence, sample_size,
             created_at_ms, learning_run_id, rejected, rejection_reason, status, origin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            candidate["candidate_id"],
            candidate["parent_strategy"],
            json.dumps(candidate["changes"]),
            candidate.get("reason"),
            candidate.get("evidence"),
            candidate["sample_size"],
            candidate["created_at_ms"],
            learning_run_id,
            0,
            None,
            candidate.get("status", "pending"),
            origin,
        ),
    )
    conn.commit()


def record_validation_result(
    conn: sqlite3.Connection,
    result_id: str,
    candidate_id: str,
    stage: str,
    passed: bool | None,
    metrics: dict[str, Any],
    sample_size: int,
    created_at_ms: int,
    notes: str | None = None,
) -> None:
    conn.execute(
        f"""INSERT INTO {VALIDATION_RESULTS_TABLE}
            (id, candidate_id, stage, passed, metrics_json, sample_size, created_at_ms, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            result_id,
            candidate_id,
            stage,
            None if passed is None else int(passed),
            json.dumps(metrics),
            sample_size,
            created_at_ms,
            notes,
        ),
    )
    conn.commit()


def record_feature_snapshot(
    conn: sqlite3.Connection,
    snapshot_id: str,
    trade_id: str | None,
    computed_at_ms: int,
    buckets: dict[str, str],
    features: dict[str, Any],
) -> None:
    conn.execute(
        f"""INSERT INTO {FEATURE_SNAPSHOTS_TABLE}
            (id, trade_id, computed_at_ms, token_age_bucket, liquidity_bucket, price_velocity_bucket,
             buy_sell_ratio_bucket, volume_acceleration_bucket, price_impact_bucket, slippage_bucket,
             entry_score_bucket, features_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            snapshot_id,
            trade_id,
            computed_at_ms,
            buckets.get("token_age_bucket"),
            buckets.get("liquidity_bucket"),
            buckets.get("price_velocity_bucket"),
            buckets.get("buy_sell_ratio_bucket"),
            buckets.get("volume_acceleration_bucket"),
            buckets.get("price_impact_bucket"),
            buckets.get("slippage_bucket"),
            buckets.get("entry_score_bucket"),
            json.dumps(features),
        ),
    )
    conn.commit()


# --- Phase 4: AI analyst / research layer -----------------------------------


def get_cached_ai_analysis(conn: sqlite3.Connection, cache_key: str) -> dict[str, Any] | None:
    """Most recent COMPLETED analysis for this cache key, or None. A cache
    hit means the provider is never called again for semantically identical
    input (spec task 14)."""
    row = conn.execute(
        f"""SELECT * FROM {AI_ANALYSES_TABLE} WHERE cache_key = ? AND status = 'completed'
            ORDER BY created_at_ms DESC LIMIT 1""",
        (cache_key,),
    ).fetchone()
    return dict(row) if row else None


def get_latest_ai_analysis(conn: sqlite3.Connection, strategy_version: str) -> dict[str, Any] | None:
    """Most recent COMPLETED analysis for this strategy version, regardless
    of cache key -- used to recover the previous win rate for the
    meaningful-change detector (learning.ai.service.detect_meaningful_change),
    not for cache lookup."""
    row = conn.execute(
        f"""SELECT * FROM {AI_ANALYSES_TABLE} WHERE strategy_version = ? AND status = 'completed'
            ORDER BY created_at_ms DESC LIMIT 1""",
        (strategy_version,),
    ).fetchone()
    return dict(row) if row else None


def record_ai_analysis(
    conn: sqlite3.Connection,
    analysis_id: str,
    created_at_ms: int,
    strategy_version: str | None,
    analysis_period_start_ms: int | None,
    analysis_period_end_ms: int | None,
    sample_size: int,
    trigger_reason: str,
    cache_key: str | None,
    cache_hit: bool,
    provider: str,
    model: str,
    prompt_version: str,
    input_json: str,
    output_json: str | None,
    confidence: str | None,
    requires_more_data: bool | None,
    status: str = "completed",
    error: str | None = None,
) -> None:
    conn.execute(
        f"""INSERT INTO {AI_ANALYSES_TABLE}
            (analysis_id, created_at_ms, strategy_version, analysis_period_start_ms, analysis_period_end_ms,
             sample_size, trigger_reason, cache_key, cache_hit, provider, model, prompt_version,
             input_json, output_json, confidence, requires_more_data, status, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            analysis_id,
            created_at_ms,
            strategy_version,
            analysis_period_start_ms,
            analysis_period_end_ms,
            sample_size,
            trigger_reason,
            cache_key,
            1 if cache_hit else 0,
            provider,
            model,
            prompt_version,
            input_json,
            output_json,
            confidence,
            None if requires_more_data is None else int(requires_more_data),
            status,
            error,
        ),
    )
    conn.commit()


def record_ai_rejected_proposal(
    conn: sqlite3.Connection,
    proposal_id: str,
    analysis_id: str | None,
    created_at_ms: int,
    attempted_parameter: str,
    reason: str,
    raw_proposal: dict[str, Any],
) -> None:
    conn.execute(
        f"""INSERT INTO {AI_REJECTED_PROPOSALS_TABLE}
            (id, analysis_id, created_at_ms, attempted_parameter, reason, raw_proposal_json)
            VALUES (?, ?, ?, ?, ?, ?)""",
        (proposal_id, analysis_id, created_at_ms, attempted_parameter, reason, json.dumps(raw_proposal)),
    )
    conn.commit()


def record_ai_usage(
    conn: sqlite3.Connection,
    request_id: str,
    analysis_id: str | None,
    timestamp_ms: int,
    provider: str,
    model: str,
    analysis_reason: str,
    input_tokens: int,
    output_tokens: int,
    cache_hit: bool,
    success: bool,
    latency_ms: float,
    error: str | None = None,
    estimated_cost_usd: float | None = None,
) -> None:
    conn.execute(
        f"""INSERT INTO {AI_USAGE_LOG_TABLE}
            (request_id, analysis_id, timestamp_ms, provider, model, analysis_reason,
             input_tokens, output_tokens, total_tokens, cache_hit, success, error, latency_ms, estimated_cost_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            request_id,
            analysis_id,
            timestamp_ms,
            provider,
            model,
            analysis_reason,
            input_tokens,
            output_tokens,
            input_tokens + output_tokens,
            1 if cache_hit else 0,
            1 if success else 0,
            error,
            latency_ms,
            estimated_cost_usd,
        ),
    )
    conn.commit()


def get_ai_usage_report(conn: sqlite3.Connection, since_ms: int | None = None) -> dict[str, Any]:
    """Aggregates learning/ai/*'s own usage log -- daily/weekly AI-call
    counts, token totals, cache hit rate, estimated cost, failure count
    (spec task 20). `since_ms=None` reports over the entire log."""
    where = "WHERE timestamp_ms >= ?" if since_ms is not None else ""
    params = (since_ms,) if since_ms is not None else ()
    row = conn.execute(
        f"""SELECT
                COUNT(*) AS request_count,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(cache_hit), 0) AS cache_hits,
                COALESCE(SUM(CASE WHEN cache_hit = 0 THEN 1 ELSE 0 END), 0) AS cache_misses,
                COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed_calls,
                COALESCE(SUM(estimated_cost_usd), 0.0) AS estimated_cost_usd
            FROM {AI_USAGE_LOG_TABLE} {where}""",
        params,
    ).fetchone()
    request_count = row["request_count"] or 0
    return {
        "request_count": request_count,
        "input_tokens": row["input_tokens"] or 0,
        "output_tokens": row["output_tokens"] or 0,
        "total_tokens": row["total_tokens"] or 0,
        "cache_hits": row["cache_hits"] or 0,
        "cache_misses": row["cache_misses"] or 0,
        "cache_hit_rate": (row["cache_hits"] / request_count) if request_count else None,
        "failed_calls": row["failed_calls"] or 0,
        "estimated_cost_usd": row["estimated_cost_usd"] or 0.0,
    }
