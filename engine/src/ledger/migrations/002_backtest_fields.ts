// Additive schema evolution for Phase 3-alt's historical replay/backtesting
// engine (see docs/PHASE_3_ALT_BACKTEST_LEARNING.md). Adds two columns to
// token_evaluations that the live engine already computes every evaluation
// tick (see orchestrator/loop.ts) but previously discarded rather than
// persisting: the observed price at that instant, and the observed
// transaction count. Both are required to replay TP/SL/trailing-exit logic
// and transaction-velocity-based entry scoring against real historical
// snapshots -- without them, a backtester would have to invent a price
// series, which this project treats as unacceptable (see task 5/27: never
// invent missing historical data).
//
// No existing column is renamed, retyped, or removed; no trading strategy,
// risk parameter, or existing row's values are affected. SQLite has no
// "ADD COLUMN IF NOT EXISTS" -- ledger/db.ts applies this by first checking
// PRAGMA table_info(token_evaluations) so re-running it is a no-op.
export const MIGRATION_002_BACKTEST_FIELDS_TABLE = 'token_evaluations';
export const MIGRATION_002_BACKTEST_FIELDS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'price_sol', ddl: 'ALTER TABLE token_evaluations ADD COLUMN price_sol REAL' },
  { column: 'tx_count_1m', ddl: 'ALTER TABLE token_evaluations ADD COLUMN tx_count_1m REAL' },
];
