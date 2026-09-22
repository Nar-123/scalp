// P1 audit fixes: additive columns only, both on `trades` (the live ledger table; `shadow_trades` is untouched --
// shadow already has its own `entry_filled_amount_sol`, added in 003/008).
//
// entry_filled_amount_sol: the SOL value actually deployed after entry fees/impact/slippage (Position.
// entryFilledAmountSol). Recorded on the trade row itself so an open position can be safely RECONSTRUCTED after a
// process restart without fabricating this value (see orchestrator/positionRecovery.ts). A trade recorded before
// this migration -- or by any other path that does not supply it -- has NULL here, and recovery correctly treats
// that as "missing critical data": left open in the ledger, flagged for manual reconciliation, never guessed at.
//
// reconciliation_reason: set ONLY when a trade's real on-chain state may no longer match what the rest of this row
// says -- today, exclusively when a sell is confirmed EXECUTED but the atomic exit-persistence transaction that
// should have recorded it then fails (see TradeLedger.recordExitAtomic / positionMonitor.closePosition). A non-null
// reason means this trade must never be resumed for automatic trading after a restart, however complete its entry
// data looks; positionRecovery.ts checks this before ever reconstructing a live Position. COALESCE-preserved (see
// TradeLedger.markReconciliationNeeded): the first diagnostic reason recorded is kept, not overwritten.
export const MIGRATION_009_RELIABILITY_TABLE = 'trades';
export const MIGRATION_009_RELIABILITY_COLUMNS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'entry_filled_amount_sol', ddl: 'ALTER TABLE trades ADD COLUMN entry_filled_amount_sol REAL' },
  { column: 'reconciliation_reason', ddl: 'ALTER TABLE trades ADD COLUMN reconciliation_reason TEXT' },
];
