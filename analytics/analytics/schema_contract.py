"""Table/column names mirroring engine/src/ledger/migrations/001_init.ts.

Kept as plain constants (not an ORM model) so this stays a thin, obviously
correct mirror of the TypeScript schema rather than a second source of
truth that can drift silently.
"""

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
