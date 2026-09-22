// Phase 5.6H: shadow price-path instrumentation. Purely additive (two new tables, no change to any existing table).
// trade_price_paths: one row per scheduled observation offset (plus one 'exit' point) of a shadow trade. A missing observation is a
// row with status != 'observed', null values and a reason -- never an interpolated or default value.
// trade_path_metrics: one row per trade with the entry snapshot and the metrics derived from the observed points.
export const MIGRATION_008_PRICE_PATHS = `
CREATE TABLE IF NOT EXISTS trade_price_paths (
  trade_id TEXT NOT NULL,
  point_kind TEXT NOT NULL,
  offset_ms INTEGER NOT NULL,
  mint TEXT NOT NULL,
  status TEXT NOT NULL,
  missing_reason TEXT,
  scheduled_at_ms INTEGER,
  observed_at_ms INTEGER,
  observation_lag_ms INTEGER,
  price_sol REAL,
  liquidity_sol REAL,
  state_event_sec INTEGER,
  state_age_ms INTEGER,
  sell_price_impact_pct REAL,
  venue_fee_bps REAL,
  gross_move_pct REAL,
  net_pnl_sol REAL,
  net_pnl_pct REAL,
  net_unavailable_reason TEXT,
  PRIMARY KEY (trade_id, point_kind, offset_ms)
);
CREATE INDEX IF NOT EXISTS idx_trade_price_paths_mint ON trade_price_paths (mint);

CREATE TABLE IF NOT EXISTS trade_path_metrics (
  trade_id TEXT PRIMARY KEY,
  trade_kind TEXT NOT NULL,
  strategy_version TEXT,
  mint TEXT NOT NULL,
  entry_time_ms INTEGER NOT NULL,
  entry_price_sol REAL NOT NULL,
  entry_size_sol REAL NOT NULL,
  entry_filled_amount_sol REAL,
  entry_fee_sol REAL,
  entry_token_amount_raw TEXT,
  entry_liquidity_sol REAL,
  entry_volume_1m_sol REAL,
  entry_fee_bps REAL,
  entry_fee_model TEXT,
  exit_time_ms INTEGER,
  exit_price_sol REAL,
  exit_fee_sol REAL,
  exit_reason TEXT,
  net_pnl_sol REAL,
  net_pnl_pct REAL,
  holding_time_ms INTEGER,
  path_status TEXT NOT NULL,
  observations_expected INTEGER NOT NULL,
  observations_observed INTEGER NOT NULL,
  path_complete_30s INTEGER NOT NULL,
  mfe_pct REAL,
  mae_pct REAL,
  time_to_mfe_ms INTEGER,
  time_to_mae_ms INTEGER,
  max_gross_move_pct REAL,
  time_to_max_gross_ms INTEGER,
  max_net_pnl_pct REAL,
  time_to_max_net_ms INTEGER,
  ever_net_positive INTEGER,
  net_observations INTEGER NOT NULL,
  finalized_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_path_metrics_mint ON trade_path_metrics (mint);
`;
