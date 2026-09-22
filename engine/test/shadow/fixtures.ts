import { getDefaultConfig } from '../../src/config/defaults.js';
import { DEFAULT_SIMULATOR_VERSION } from '../../src/backtest/types.js';
import type { SimulationAssumptions } from '../../src/backtest/types.js';
import type { ShadowMarketTick } from '../../src/shadow/types.js';

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

/** A tick that passes every entry gate under DEFAULT_CONFIG. */
export function entryEligibleTick(overrides: Partial<ShadowMarketTick> = {}): ShadowMarketTick {
  const tick: ShadowMarketTick = {
    mint: 'MINT_A',
    discoveredAtMs: 0,
    observedAtMs: 40_000,
    priceSol: 1,
    liquiditySol: 40,
    volume1mSol: 10,
    buySellRatio: 2,
    priceVelocity5sPct: 5,
    volumeAccelerationX: 2,
    txCount1m: 30,
    estimatedPriceImpactPct: 0.2,
    estimatedSellPriceImpactPct: 0.2, // the SELL direction, supplied independently of the buy figure (Phase 5.6)
    safetyPassedAtObservationTime: true,
    safetyReasonsAtObservationTime: [],
    quote: null,
    timings: { discoveryTimeMs: 0, signalTimeMs: 40_000, quoteTimeMs: null, simulationTimeMs: 40_010, exitSignalTimeMs: null },
    fetchError: null,
    ...overrides,
  };
  // One observation is one moment: unless a test says otherwise the market data is stamped at the tick's own time.
  if (!('timings' in overrides) && tick.timings.marketDataTimeMs === undefined) tick.timings = { ...tick.timings, marketDataTimeMs: tick.observedAtMs };
  return tick;
}
