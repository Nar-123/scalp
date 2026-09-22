// Phase 5.5: additive columns only (no existing column renamed, retyped or removed).
//  - pumpfun_trade_events: the post-trade bonding-curve state carried by each TradeEvent, so the
//    native market snapshot can be replayed exactly (u64 reserves stored as TEXT: exact, no float).
//  - token_evaluations: which source produced the market data and its event-time stamps.
export const MIGRATION_005_TRADE_EVENT_CURVE_TABLE = 'pumpfun_trade_events';
export const MIGRATION_005_TRADE_EVENT_CURVE: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'virtual_sol_reserves', ddl: 'ALTER TABLE pumpfun_trade_events ADD COLUMN virtual_sol_reserves TEXT' },
  { column: 'virtual_token_reserves', ddl: 'ALTER TABLE pumpfun_trade_events ADD COLUMN virtual_token_reserves TEXT' },
  { column: 'real_sol_reserves', ddl: 'ALTER TABLE pumpfun_trade_events ADD COLUMN real_sol_reserves TEXT' },
  { column: 'real_token_reserves', ddl: 'ALTER TABLE pumpfun_trade_events ADD COLUMN real_token_reserves TEXT' },
  { column: 'fee_basis_points', ddl: 'ALTER TABLE pumpfun_trade_events ADD COLUMN fee_basis_points INTEGER' },
  { column: 'creator_fee_basis_points', ddl: 'ALTER TABLE pumpfun_trade_events ADD COLUMN creator_fee_basis_points INTEGER' },
  { column: 'mayhem_mode', ddl: 'ALTER TABLE pumpfun_trade_events ADD COLUMN mayhem_mode INTEGER' },
];

export const MIGRATION_005_EVALUATION_MARKET_TABLE = 'token_evaluations';
export const MIGRATION_005_EVALUATION_MARKET: ReadonlyArray<{ column: string; ddl: string }> = [
  { column: 'market_source', ddl: 'ALTER TABLE token_evaluations ADD COLUMN market_source TEXT' },
  { column: 'market_data_asof_sec', ddl: 'ALTER TABLE token_evaluations ADD COLUMN market_data_asof_sec INTEGER' },
  { column: 'volume_window_end_sec', ddl: 'ALTER TABLE token_evaluations ADD COLUMN volume_window_end_sec INTEGER' },
  { column: 'state_event_sec', ddl: 'ALTER TABLE token_evaluations ADD COLUMN state_event_sec INTEGER' },
];
