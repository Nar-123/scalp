import { getDefaultConfig } from '../../src/config/defaults.js';
import { DEFAULT_SIMULATOR_VERSION } from '../../src/backtest/types.js';
import type { HistoricalMarketSnapshot, SimulationAssumptions } from '../../src/backtest/types.js';

/** A snapshot that passes every entry gate (age window, baseline filters, entry score, expected net edge, risk) under DEFAULT_CONFIG below. */
export function entryEligibleSnapshot(overrides: Partial<HistoricalMarketSnapshot> = {}): HistoricalMarketSnapshot {
  return {
    mint: 'MINT_A',
    observedAtMs: 40_000,
    discoveredAtMs: 0,
    discoverySource: 'raydium',
    priceSol: 1,
    liquiditySol: 40,
    volume1mSol: 10,
    buySellRatio: 2,
    priceVelocity5sPct: 5,
    volumeAccelerationX: 2,
    txCount1m: 30,
    estimatedPriceImpactPct: 0.2,
    estimatedSellPriceImpactPct: 0.2, // the SELL direction, recorded independently of the buy figure (Phase 5.6)
    safetyPassedAtObservationTime: true,
    safetyReasonsAtObservationTime: [],
    ...overrides,
  };
}

// Phase 5.6H: the expected net edge is now a COMPLETE round trip (both legs, incl. fixed costs and the safety margin), so with the
// production cost schedule a 2 % quick-TP move is NOT favorable any more (that is the corrected accounting, tested in
// test/scoring/roundTripAccounting.test.ts). These lifecycle fixtures isolate entry/exit/risk mechanics from the cost schedule, so
// their `edge` block carries no fees, fixed costs or margin; every accounting property is tested against the real schedule elsewhere.
export const DEFAULT_CONFIG = getDefaultConfig({ edge: { dexFeeBps: 0, swapFeeBps: 0, networkFeeSol: 0, priorityFeeSol: 0, safetyMarginBps: 0 } });

export const DEFAULT_ASSUMPTIONS: SimulationAssumptions = {
  edge: DEFAULT_CONFIG.edge,
  fallbackPriceImpactPct: DEFAULT_CONFIG.execution.fallbackPriceImpactPct,
  latencySlippageBufferPct: DEFAULT_CONFIG.execution.latencySlippageBufferPct,
  simulatorVersion: DEFAULT_SIMULATOR_VERSION,
};

export function snapshotsByMint(snapshots: HistoricalMarketSnapshot[]): Map<string, HistoricalMarketSnapshot[]> {
  const map = new Map<string, HistoricalMarketSnapshot[]>();
  for (const s of snapshots) {
    const existing = map.get(s.mint);
    if (existing) existing.push(s);
    else map.set(s.mint, [s]);
  }
  return map;
}
