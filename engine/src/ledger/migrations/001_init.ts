// Kept as a TS string constant (rather than a loose .sql asset file) so it
// ships correctly in the compiled dist/ output with no separate asset-copy
// build step.
export const MIGRATION_001_INIT = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_evaluations (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  pool_address TEXT,
  discovery_source TEXT NOT NULL,
  discovered_at_ms INTEGER NOT NULL,
  evaluated_at_ms INTEGER NOT NULL,
  token_age_sec REAL,
  safety_passed INTEGER NOT NULL,
  safety_reasons TEXT,
  mint_authority_renounced INTEGER,
  freeze_authority_renounced INTEGER,
  top10_holder_pct REAL,
  liquidity_sol REAL,
  volume_1m_sol REAL,
  buy_sell_ratio REAL,
  price_velocity_5s_pct REAL,
  volume_acceleration_x REAL,
  estimated_price_impact_pct REAL,
  entry_score REAL,
  entry_score_components TEXT,
  expected_net_edge_pct REAL,
  expected_net_edge_breakdown TEXT,
  risk_allowed INTEGER,
  risk_reject_reasons TEXT,
  led_to_trade_id TEXT,
  strategy_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_mint ON token_evaluations(mint);
CREATE INDEX IF NOT EXISTS idx_eval_time ON token_evaluations(evaluated_at_ms);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  pool_address TEXT,
  strategy_version TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  reentry_index INTEGER NOT NULL DEFAULT 0,

  entry_time_ms INTEGER NOT NULL,
  entry_price_sol REAL NOT NULL,
  entry_size_sol REAL NOT NULL,
  entry_token_age_sec REAL,
  entry_liquidity_sol REAL,
  entry_volume_1m_sol REAL,
  entry_buy_sell_ratio REAL,
  entry_price_velocity_5s_pct REAL,
  entry_volume_acceleration_x REAL,
  entry_score REAL,
  entry_score_components TEXT,
  expected_net_edge_pct REAL,
  expected_net_edge_breakdown TEXT,
  entry_slippage_pct REAL,
  entry_price_impact_pct REAL,
  entry_fees_sol REAL,
  entry_tx_signature TEXT,
  entry_safety_check_id TEXT REFERENCES token_evaluations(id),
  daily_realized_pnl_sol_at_entry REAL,

  exit_time_ms INTEGER,
  exit_price_sol REAL,
  exit_reason TEXT,
  exit_fees_sol REAL,
  exit_tx_signature TEXT,
  exit_slippage_pct REAL,
  hold_duration_ms INTEGER,
  pnl_sol REAL,
  pnl_pct REAL,
  max_favorable_excursion_pct REAL,
  max_adverse_excursion_pct REAL,
  daily_realized_pnl_sol_at_exit REAL,

  status TEXT NOT NULL DEFAULT 'open',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time_ms);

CREATE TABLE IF NOT EXISTS daily_risk_state (
  trading_date_utc TEXT PRIMARY KEY,
  starting_balance_sol REAL NOT NULL,
  realized_pnl_sol REAL NOT NULL DEFAULT 0,
  circuit_breaker_triggered INTEGER NOT NULL DEFAULT 0,
  circuit_breaker_triggered_at_ms INTEGER
);
`;
