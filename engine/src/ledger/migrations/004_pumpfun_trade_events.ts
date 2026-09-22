// Phase 5.4B: normalized Pump.fun trade events + coverage log, for exact replay
// of the native 1-minute SOL volume. Engine-owned (Python only reads). No
// secrets or wallet data: `trader` is a public on-chain address and is
// deliberately NOT stored. Retention is bounded by the recorder (default 24 h).
export const MIGRATION_004_PUMPFUN_EVENTS = `
CREATE TABLE IF NOT EXISTS pumpfun_trade_events (
  signature TEXT NOT NULL,
  program TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL,
  mint TEXT NOT NULL,
  sol_amount_lamports INTEGER NOT NULL,
  token_amount TEXT NOT NULL,
  is_buy INTEGER NOT NULL,
  event_timestamp INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  quote_mint TEXT,
  quote_class TEXT NOT NULL,
  source TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (signature, program, event_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_pumpfun_trade_events_ts ON pumpfun_trade_events (event_timestamp);
CREATE INDEX IF NOT EXISTS idx_pumpfun_trade_events_mint_ts ON pumpfun_trade_events (mint, event_timestamp);

CREATE TABLE IF NOT EXISTS pumpfun_lifecycle_events (
  signature TEXT NOT NULL,
  program TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mint TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  quote_mint TEXT,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (signature, program, kind, event_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_pumpfun_lifecycle_mint ON pumpfun_lifecycle_events (mint);

CREATE TABLE IF NOT EXISTS volume_coverage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  event_second INTEGER,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_volume_coverage_log_at ON volume_coverage_log (at_ms);
`;
