"""Documented shared SQLite schema contract between the TypeScript engine
and this Python package (Phase 2 task 11).

SQLite remains the single source of truth -- there is exactly one database
file (the engine's `data/ledger.sqlite`), never two competing databases.
Ownership is split cleanly by table:

  * "Trading truth" tables -- created and written ONLY by the TypeScript
    engine (see engine/src/ledger/migrations/001_init.ts): token_evaluations,
    trades (which holds both entry_* and exit_* columns per spec section
    11's separate entry/exit field lists), daily_risk_state. Python treats
    these as READ-ONLY (see analytics/reader.py's read-only connection) and
    never writes to them -- this package must never duplicate or shadow the
    trade ledger.

  * "Learning" tables -- created and written ONLY by this Python package
    (see learning/db.py's idempotent CREATE TABLE IF NOT EXISTS), in the
    SAME database file: strategy_versions, feature_snapshots, learning_runs,
    candidate_strategies, validation_results. The TypeScript engine does not
    read or write these in this phase (no production behavior depends on
    them yet -- see docs/PHASE_2_ARCHITECTURE.md).

Kept as plain constants (not an ORM model) so this stays a thin, obviously
correct mirror rather than a second source of truth that can drift silently.
"""

# --- Trading truth tables (TypeScript-owned, Python read-only) ------------

TOKEN_EVALUATIONS_TABLE = "token_evaluations"
TRADES_TABLE = "trades"
DAILY_RISK_STATE_TABLE = "daily_risk_state"

TRADES_COLUMNS = (
    "id",
    "mint",
    "pool_address",
    "strategy_version",
    "dry_run",
    "reentry_index",
    # --- entry fields (spec section 11) ---
    "entry_time_ms",
    "entry_price_sol",
    "entry_size_sol",
    "entry_token_age_sec",
    "entry_liquidity_sol",
    "entry_volume_1m_sol",
    "entry_buy_sell_ratio",
    "entry_price_velocity_5s_pct",
    "entry_volume_acceleration_x",
    "entry_score",
    "entry_score_components",
    "expected_net_edge_pct",
    "expected_net_edge_breakdown",
    "entry_slippage_pct",
    "entry_price_impact_pct",
    "entry_fees_sol",
    "entry_tx_signature",
    "entry_safety_check_id",
    "daily_realized_pnl_sol_at_entry",
    # --- exit fields (spec section 11) ---
    "exit_time_ms",
    "exit_price_sol",
    "exit_reason",
    "exit_fees_sol",
    "exit_tx_signature",
    "exit_slippage_pct",
    "hold_duration_ms",
    "pnl_sol",
    "pnl_pct",
    "max_favorable_excursion_pct",
    "max_adverse_excursion_pct",
    "daily_realized_pnl_sol_at_exit",
    "status",
    "created_at_ms",
    "updated_at_ms",
)

TOKEN_EVALUATIONS_COLUMNS = (
    "id",
    "mint",
    "pool_address",
    "discovery_source",
    "discovered_at_ms",
    "evaluated_at_ms",
    "token_age_sec",
    "safety_passed",
    "safety_reasons",
    "mint_authority_renounced",
    "freeze_authority_renounced",
    "top10_holder_pct",
    "liquidity_sol",
    "volume_1m_sol",
    "buy_sell_ratio",
    "price_velocity_5s_pct",
    "volume_acceleration_x",
    "estimated_price_impact_pct",
    "entry_score",
    "entry_score_components",
    "expected_net_edge_pct",
    "expected_net_edge_breakdown",
    "risk_allowed",
    "risk_reject_reasons",
    "led_to_trade_id",
    "strategy_version",
)

DAILY_RISK_STATE_COLUMNS = (
    "trading_date_utc",
    "starting_balance_sol",
    "realized_pnl_sol",
    "circuit_breaker_triggered",
    "circuit_breaker_triggered_at_ms",
)

# --- Learning tables (Python-owned, TS does not touch these yet) ----------

STRATEGY_VERSIONS_TABLE = "strategy_versions"
STRATEGY_VERSIONS_COLUMNS = (
    "version",
    "parent_version",
    "parameters_json",
    "created_at_ms",
    "reason",
    "evidence",
    "backtest_result_json",
    "oos_result_json",
    "shadow_result_json",
    "validation_status",  # proposed | backtested | oos_tested | shadow_tested | validated | rejected
)

FEATURE_SNAPSHOTS_TABLE = "feature_snapshots"
FEATURE_SNAPSHOTS_COLUMNS = (
    "id",
    "trade_id",  # loose reference to trades.id -- not an enforced FK (separate schema owners)
    "computed_at_ms",
    "token_age_bucket",
    "liquidity_bucket",
    "price_velocity_bucket",
    "buy_sell_ratio_bucket",
    "volume_acceleration_bucket",
    "price_impact_bucket",
    "slippage_bucket",
    "entry_score_bucket",
    "features_json",
)

LEARNING_RUNS_TABLE = "learning_runs"
LEARNING_RUNS_COLUMNS = (
    "id",
    "started_at_ms",
    "completed_at_ms",
    "trigger",  # 'manual' | 'scheduled'
    "sample_size",
    "strategy_version",
    "summary_json",
    "status",  # running | completed | failed
    # --- Phase 3-alt additive columns (task 23), applied idempotently by
    # learning/db.py's _apply_additive_columns -- see that module for why
    # these are ALTER TABLE additions rather than part of the original
    # CREATE TABLE above. ---
    "data_range_start_ms",
    "data_range_end_ms",
    "candidates_tested",
    "candidates_passed",
    "candidates_rejected",
    "error",
)

CANDIDATE_STRATEGIES_TABLE = "candidate_strategies"
CANDIDATE_STRATEGIES_COLUMNS = (
    "candidate_id",
    "parent_strategy",
    "changes_json",
    "reason",
    "evidence",
    "sample_size",
    "created_at_ms",
    "learning_run_id",
    "rejected",
    "rejection_reason",
    "status",  # pending | accepted_for_backtest | rejected | promoted
    # 'promoted' (set only by learning/promotion.py's evaluate_promotion +
    # apply_promotion_decision, task 20) is a DATABASE LABEL ONLY: nothing
    # in this codebase reads a 'promoted' candidate_strategies row and
    # applies it to the TypeScript engine's live strategyVersion. Adopting
    # a promoted candidate into production remains a separate, explicit,
    # human-initiated action -- "no silent promotion".
    "origin",  # Phase 4 additive column: 'local_pattern_discovery' | 'ai_analyst'
)

# --- Phase 4: AI analyst / research layer (Python-owned, TS never touches these) ---

AI_ANALYSES_TABLE = "ai_analyses"
AI_ANALYSES_COLUMNS = (
    "analysis_id",
    "created_at_ms",
    "strategy_version",
    "analysis_period_start_ms",
    "analysis_period_end_ms",
    "sample_size",
    "trigger_reason",
    "cache_key",
    "cache_hit",
    "provider",
    "model",
    "prompt_version",
    "input_json",
    "output_json",
    "confidence",
    "requires_more_data",
    "status",  # completed | rejected | failed
    "error",
)

AI_REJECTED_PROPOSALS_TABLE = "ai_rejected_proposals"
AI_REJECTED_PROPOSALS_COLUMNS = (
    "id",
    "analysis_id",
    "created_at_ms",
    "attempted_parameter",
    "reason",  # HARD_PARAMETER_MODIFICATION_REJECTED | UNAUTHORIZED_PARAMETER_REJECTED | INVALID_VALUE_REJECTED | INSUFFICIENT_DATA
    "raw_proposal_json",
)

AI_USAGE_LOG_TABLE = "ai_usage_log"
AI_USAGE_LOG_COLUMNS = (
    "request_id",
    "analysis_id",
    "timestamp_ms",
    "provider",
    "model",
    "analysis_reason",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cache_hit",
    "success",
    "error",
    "latency_ms",
    "estimated_cost_usd",
)

VALIDATION_RESULTS_TABLE = "validation_results"
VALIDATION_RESULTS_COLUMNS = (
    "id",
    "candidate_id",
    "stage",  # backtest | out_of_sample | shadow
    "passed",
    "metrics_json",
    "sample_size",
    "created_at_ms",
    "notes",
)

# --- Phase 5: realtime shadow trading (TypeScript-owned, Python READ-ONLY) ---
# Created and written only by engine/src/ledger/migrations/003_shadow_tables.ts
# and engine/src/shadow/shadowLedger.ts. Deliberately separate from `trades`:
# shadow activity is simulated and must never be counted as production.

SHADOW_TRADES_TABLE = "shadow_trades"
SHADOW_DAILY_RISK_STATE_TABLE = "shadow_daily_risk_state"
SHADOW_MISSED_SIGNALS_TABLE = "shadow_missed_signals"
SHADOW_DATA_QUALITY_EVENTS_TABLE = "shadow_data_quality_events"
SHADOW_LATENCY_SAMPLES_TABLE = "shadow_latency_samples"

SHADOW_TRADES_COLUMNS = (
    "trade_id", "strategy_version", "execution_mode", "simulator_version", "mint", "reentry_index",
    "entry_time_ms", "entry_price_sol", "entry_size_sol", "entry_filled_amount_sol", "entry_fees_sol",
    "entry_score", "expected_net_edge_pct", "entry_liquidity_sol", "entry_quote_json",
    "exit_time_ms", "exit_price_sol", "exit_reason", "exit_fees_sol",
    "status", "pnl_sol", "pnl_pct", "hold_duration_ms",
    "max_favorable_excursion_pct", "max_adverse_excursion_pct", "created_at_ms", "updated_at_ms",
)

# --- Market-data UNIT CONTRACT (Phase 5.2) ---------------------------------
# Every *_sol column above (entry_liquidity_sol, entry_volume_1m_sol,
# liquidity_sol, volume_1m_sol, ...) is denominated in SOL or NULL. The
# TypeScript aggregator only reports a value in SOL when the source pair is
# provably TOKEN/SOL (see engine/src/discovery/dexscreenerUnits.ts): liquidity
# is the pair's SOL-side amount (never the token amount), and 1-minute volume
# is NULL because no real 1-minute source exists (5-minute USD volume is never
# relabelled). Rows written BEFORE Phase 5.2 used token amounts as
# "liquidity_sol" and USD-based numbers as "volume_1m_sol"; they must not be
# pooled with post-fix rows in analytics or backtests.
MARKET_DATA_UNIT_CONTRACT_VERSION = "sol-units-v2"
