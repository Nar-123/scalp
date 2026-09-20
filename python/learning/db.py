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
"""


@contextmanager
def open_learning_db(db_path: str) -> Iterator[sqlite3.Connection]:
    """Read-write connection, but ONLY ever used against the tables this
    module creates above -- never trades/token_evaluations/daily_risk_state.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(_SCHEMA)
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
) -> None:
    conn.execute(
        f"""UPDATE {LEARNING_RUNS_TABLE}
            SET completed_at_ms = ?, sample_size = ?, strategy_version = ?, summary_json = ?, status = ?
            WHERE id = ?""",
        (completed_at_ms, sample_size, strategy_version, json.dumps(summary), status, run_id),
    )
    conn.commit()


def record_candidate(conn: sqlite3.Connection, candidate: dict[str, Any], learning_run_id: str | None = None) -> None:
    conn.execute(
        f"""INSERT INTO {CANDIDATE_STRATEGIES_TABLE}
            (candidate_id, parent_strategy, changes_json, reason, evidence, sample_size,
             created_at_ms, learning_run_id, rejected, rejection_reason, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
