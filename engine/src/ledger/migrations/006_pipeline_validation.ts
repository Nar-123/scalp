// Phase 5.6: additive columns only. Everything needed to REPRODUCE a simulated/dry-run decision and to audit its
// exit: the raw token amount held, the entry decision context, the exit context (incl. the independently computed
// SELL price impact), and the per-tick sell impact / buy-sell volume on evaluations.
export const MIGRATION_006_TRADES_TABLE = 'trades';
export const MIGRATION_006_SHADOW_TABLE = 'shadow_trades';
const tradeColumns = (table: string): ReadonlyArray<{ column: string; ddl: string }> => [
  { column: 'entry_token_amount_raw', ddl: `ALTER TABLE ${table} ADD COLUMN entry_token_amount_raw TEXT` },
  { column: 'entry_context_json', ddl: `ALTER TABLE ${table} ADD COLUMN entry_context_json TEXT` },
  { column: 'exit_context_json', ddl: `ALTER TABLE ${table} ADD COLUMN exit_context_json TEXT` },
];
export const MIGRATION_006_TRADES = tradeColumns('trades');
export const MIGRATION_006_SHADOW_TRADES = tradeColumns('shadow_trades');

export const MIGRATION_006_EVALUATIONS_TABLE = 'token_evaluations';
export const MIGRATION_006_EVALUATIONS: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'estimated_sell_price_impact_pct', ddl: 'ALTER TABLE token_evaluations ADD COLUMN estimated_sell_price_impact_pct REAL' },
  { column: 'buy_volume_1m_sol', ddl: 'ALTER TABLE token_evaluations ADD COLUMN buy_volume_1m_sol REAL' },
  { column: 'sell_volume_1m_sol', ddl: 'ALTER TABLE token_evaluations ADD COLUMN sell_volume_1m_sol REAL' },
];
