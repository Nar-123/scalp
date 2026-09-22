// Phase 5: realtime shadow trading tables. Deliberately SEPARATE from
// `trades`/`token_evaluations`/`daily_risk_state` (never mixed in) so a
// shadow strategy's simulated activity can never be confused with, or
// accidentally counted toward, real/production accounting. Every table is
// scoped by strategy_version because multiple shadow strategies (e.g. V1
// shadow + a V2 candidate shadow) run concurrently against the same
// realtime market events, in isolation from each other.
export const MIGRATION_003_SHADOW_TABLES = `
CREATE TABLE IF NOT EXISTS shadow_trades (
  trade_id TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'shadow',
  simulator_version TEXT NOT NULL,
  mint TEXT NOT NULL,
  reentry_index INTEGER NOT NULL DEFAULT 0,

  entry_time_ms INTEGER NOT NULL,
  entry_price_sol REAL NOT NULL,
  entry_size_sol REAL NOT NULL,
  entry_filled_amount_sol REAL NOT NULL,
  entry_fees_sol REAL NOT NULL,
  entry_score REAL NOT NULL,
  expected_net_edge_pct REAL NOT NULL,
  entry_liquidity_sol REAL,
  entry_quote_json TEXT,

  exit_time_ms INTEGER,
  exit_price_sol REAL,
  exit_reason TEXT,
  exit_fees_sol REAL,

  status TEXT NOT NULL DEFAULT 'open',
  pnl_sol REAL,
  pnl_pct REAL,
  hold_duration_ms INTEGER,
  max_favorable_excursion_pct REAL,
  max_adverse_excursion_pct REAL,

  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_strategy_mint ON shadow_trades(strategy_version, mint);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_strategy_status ON shadow_trades(strategy_version, status);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_entry_time ON shadow_trades(entry_time_ms);

CREATE TABLE IF NOT EXISTS shadow_daily_risk_state (
  strategy_version TEXT NOT NULL,
  trading_date_utc TEXT NOT NULL,
  starting_balance_sol REAL NOT NULL,
  realized_pnl_sol REAL NOT NULL DEFAULT 0,
  circuit_breaker_triggered INTEGER NOT NULL DEFAULT 0,
  circuit_breaker_triggered_at_ms INTEGER,
  PRIMARY KEY (strategy_version, trading_date_utc)
);

CREATE TABLE IF NOT EXISTS shadow_missed_signals (
  id TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  mint TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_shadow_missed_signals_strategy_time ON shadow_missed_signals(strategy_version, observed_at_ms);

CREATE TABLE IF NOT EXISTS shadow_data_quality_events (
  id TEXT PRIMARY KEY,
  strategy_version TEXT,
  mint TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_shadow_dq_events_time ON shadow_data_quality_events(observed_at_ms);

CREATE TABLE IF NOT EXISTS shadow_latency_samples (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  discovery_time_ms INTEGER NOT NULL,
  signal_time_ms INTEGER NOT NULL,
  quote_time_ms INTEGER,
  simulation_time_ms INTEGER NOT NULL,
  exit_signal_time_ms INTEGER,
  discovery_latency_ms REAL,
  signal_latency_ms REAL NOT NULL,
  quote_latency_ms REAL,
  processing_latency_ms REAL NOT NULL,
  detected_at_ms INTEGER,
  market_data_time_ms INTEGER,
  market_data_latency_ms REAL,
  shadow_processing_latency_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_shadow_latency_time ON shadow_latency_samples(observed_at_ms);

-- Persisted so the separate status CLI process can report the running
-- engine's health (RPC / aggregator / market-data / quote / tick counters).
CREATE TABLE IF NOT EXISTS shadow_health_counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
`;

// Columns added after the first Phase 5 cut, applied idempotently so a ledger
// created by that earlier cut upgrades in place.
export const MIGRATION_003_ADDITIVE_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'shadow_data_quality_events', column: 'severity', ddl: "ALTER TABLE shadow_data_quality_events ADD COLUMN severity TEXT NOT NULL DEFAULT 'warning'" },
  { table: 'shadow_latency_samples', column: 'detected_at_ms', ddl: 'ALTER TABLE shadow_latency_samples ADD COLUMN detected_at_ms INTEGER' },
  { table: 'shadow_latency_samples', column: 'market_data_time_ms', ddl: 'ALTER TABLE shadow_latency_samples ADD COLUMN market_data_time_ms INTEGER' },
  { table: 'shadow_latency_samples', column: 'market_data_latency_ms', ddl: 'ALTER TABLE shadow_latency_samples ADD COLUMN market_data_latency_ms REAL' },
  { table: 'shadow_latency_samples', column: 'shadow_processing_latency_ms', ddl: 'ALTER TABLE shadow_latency_samples ADD COLUMN shadow_processing_latency_ms REAL' },
];
