import type { TokenEvaluationRecord } from '../types/trade.js';
import type { HistoricalMarketSnapshot } from './types.js';

/**
 * Converts the live engine's own evaluation log into the replay engine's
 * historical data contract -- a pure, lossless field rename/regroup, never
 * inventing or dropping a value (see backtest/types.ts's OBSERVED/DERIVED/
 * NEVER-AVAILABLE contract for why these fields, specifically, are the ones
 * that exist).
 */
export function toHistoricalSnapshot(record: TokenEvaluationRecord): HistoricalMarketSnapshot {
  return {
    mint: record.mint,
    observedAtMs: record.evaluatedAtMs,
    discoveredAtMs: record.discoveredAtMs,
    discoverySource: record.discoverySource,
    priceSol: record.priceSol,
    liquiditySol: record.liquiditySol,
    volume1mSol: record.volume1mSol,
    buySellRatio: record.buySellRatio,
    priceVelocity5sPct: record.priceVelocity5sPct,
    volumeAccelerationX: record.volumeAccelerationX,
    txCount1m: record.txCount1m,
    estimatedPriceImpactPct: record.estimatedPriceImpactPct,
    estimatedSellPriceImpactPct: record.estimatedSellPriceImpactPct ?? null,
    safetyPassedAtObservationTime: record.safetyPassed,
    safetyReasonsAtObservationTime: record.safetyReasons,
  };
}

/** Groups records by mint, preserving each mint's relative order (records must already be sorted upstream -- see TradeLedger.getEvaluationsForReplay). */
export function groupSnapshotsByMint(records: TokenEvaluationRecord[]): Map<string, HistoricalMarketSnapshot[]> {
  const byMint = new Map<string, HistoricalMarketSnapshot[]>();
  for (const record of records) {
    const snapshot = toHistoricalSnapshot(record);
    const existing = byMint.get(snapshot.mint);
    if (existing) {
      existing.push(snapshot);
    } else {
      byMint.set(snapshot.mint, [snapshot]);
    }
  }
  return byMint;
}
