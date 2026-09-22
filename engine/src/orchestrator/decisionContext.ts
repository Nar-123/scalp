/**
 * Everything needed to REPRODUCE an entry decision and to audit its exit (Phase 5.6). Built from values the
 * decision itself used -- never from anything observed afterwards. Stored as JSON next to the trade row.
 */
export interface EntryContextInput {
  strategyVersion: string;
  mint: string;
  discoveredAtMs: number;
  observedAtMs: number;
  tokenAgeSec: number | null;
  marketSource: 'pumpfun_native' | 'dexscreener' | null;
  marketDataTimeMs: number | null;
  marketDataAsOfSec: number | null;
  volumeWindowEndSec: number | null;
  stateEventSec: number | null;
  priceSol: number | null;
  liquiditySol: number | null;
  volume1mSol: number | null;
  buyVolume1mSol: number | null;
  sellVolume1mSol: number | null;
  buySellRatio: number | null;
  priceVelocity5sPct: number | null;
  volumeAccelerationX: number | null;
  buyPriceImpactPct: number | null;
  sellPriceImpactPct: number | null;
  buyTokenAmountRaw: string | null;
  safetyPassed: boolean | null;
  safetyReasons: string[];
  entryScore: number | null;
  expectedNetEdgePct: number | null;
  expectedNetEdgeBreakdown: Record<string, number> | null;
  entryDecision: 'enter';
  /** Phase 5.6H accounting of the BUY leg (additive; absent on contexts written by older versions). */
  feeModel?: 'pumpfun_curve' | 'configured_flat';
  feeBps?: number;
  entrySpendSol?: number;
  buyVenueFeeSol?: number;
  buyFixedCostSol?: number;
  buyPriceImpactSol?: number;
  buyLatencySlippageSol?: number;
  entryFilledAmountSol?: number;
}

const finite = (v: number | null): number | string | null => (v === null ? null : Number.isFinite(v) ? v : String(v)); // +Infinity survives JSON as "Infinity"

export function buildEntryContext(i: EntryContextInput): Record<string, unknown> {
  return {
    version: 1,
    strategyVersion: i.strategyVersion,
    mint: i.mint,
    discoveredAtMs: i.discoveredAtMs,
    decisionObservedAtMs: i.observedAtMs,
    tokenAgeSec: i.tokenAgeSec,
    marketSource: i.marketSource,
    marketDataTimeMs: i.marketDataTimeMs,
    marketDataAsOfSec: i.marketDataAsOfSec,
    volumeWindowEndSec: i.volumeWindowEndSec,
    stateEventSec: i.stateEventSec,
    priceSol: i.priceSol,
    liquiditySol: i.liquiditySol,
    volume1mSol: i.volume1mSol,
    buyVolume1mSol: i.buyVolume1mSol,
    sellVolume1mSol: i.sellVolume1mSol,
    buySellRatio: finite(i.buySellRatio),
    priceVelocity5sPct: i.priceVelocity5sPct,
    volumeAccelerationX: finite(i.volumeAccelerationX),
    buyPriceImpactPct: i.buyPriceImpactPct,
    sellPriceImpactPct: i.sellPriceImpactPct,
    buyTokenAmountRaw: i.buyTokenAmountRaw,
    safetyPassed: i.safetyPassed,
    safetyReasons: i.safetyReasons,
    entryScore: i.entryScore,
    expectedNetEdgePct: i.expectedNetEdgePct,
    expectedNetEdgeBreakdown: i.expectedNetEdgeBreakdown,
    entryDecision: i.entryDecision,
    ...(i.feeModel !== undefined
      ? {
          feeModel: i.feeModel,
          feeBps: i.feeBps ?? null,
          entrySpendSol: i.entrySpendSol ?? null,
          buyVenueFeeSol: i.buyVenueFeeSol ?? null,
          buyFixedCostSol: i.buyFixedCostSol ?? null,
          buyPriceImpactSol: i.buyPriceImpactSol ?? null,
          buyLatencySlippageSol: i.buyLatencySlippageSol ?? null,
          entryFilledAmountSol: i.entryFilledAmountSol ?? null,
        }
      : {}),
  };
}

export interface ExitContextInput {
  exitReason: string;
  exitObservedAtMs: number;
  entryPriceSol: number;
  exitPriceSol: number;
  entrySizeSol: number;
  entryFilledAmountSol: number;
  exitFilledAmountSol: number;
  entryFeesSol: number | null;
  exitFeesSol: number;
  sellPriceImpactPct: number | null;
  exitSlippagePct: number | null;
  holdDurationMs: number;
  /** Phase 5.6H accounting of the SELL leg (additive). */
  feeModel?: 'pumpfun_curve' | 'configured_flat';
  feeBps?: number;
  sellVenueFeeSol?: number;
  sellFixedCostSol?: number;
  sellPriceImpactSol?: number;
  sellLatencySlippageSol?: number;
}

export function buildExitContext(i: ExitContextInput): Record<string, unknown> {
  // Gross PnL = the pure price move on the deployed size (before fees, impact and slippage); net PnL is what the fill realized.
  const grossPnlSol = i.entryFilledAmountSol > 0 && i.entryPriceSol > 0 ? i.entryFilledAmountSol * (i.exitPriceSol / i.entryPriceSol - 1) : null;
  const netPnlSol = i.exitFilledAmountSol - i.entrySizeSol;
  return {
    version: 1,
    exitReason: i.exitReason,
    exitObservedAtMs: i.exitObservedAtMs,
    holdDurationMs: i.holdDurationMs,
    entryPriceSol: i.entryPriceSol,
    exitPriceSol: i.exitPriceSol,
    sellPriceImpactPct: i.sellPriceImpactPct,
    exitSlippagePct: i.exitSlippagePct,
    entryFeesSol: i.entryFeesSol,
    exitFeesSol: i.exitFeesSol,
    grossPnlSol,
    netPnlSol,
    ...(i.feeModel !== undefined
      ? {
          feeModel: i.feeModel,
          feeBps: i.feeBps ?? null,
          sellVenueFeeSol: i.sellVenueFeeSol ?? null,
          sellFixedCostSol: i.sellFixedCostSol ?? null,
          sellPriceImpactSol: i.sellPriceImpactSol ?? null,
          sellLatencySlippageSol: i.sellLatencySlippageSol ?? null,
        }
      : {}),
  };
}
