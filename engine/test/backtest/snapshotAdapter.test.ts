import { describe, expect, it } from 'vitest';
import { groupSnapshotsByMint, toHistoricalSnapshot } from '../../src/backtest/snapshotAdapter.js';
import type { TokenEvaluationRecord } from '../../src/types/trade.js';

function makeRecord(overrides: Partial<TokenEvaluationRecord> = {}): TokenEvaluationRecord {
  return {
    id: 'eval_1',
    mint: 'MINT_A',
    poolAddress: null,
    discoverySource: 'raydium',
    discoveredAtMs: 0,
    evaluatedAtMs: 40_000,
    tokenAgeSec: 40,
    safetyPassed: true,
    safetyReasons: [],
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    top10HolderPct: 20,
    priceSol: 1,
    liquiditySol: 40,
    volume1mSol: 10,
    buySellRatio: 2,
    priceVelocity5sPct: 5,
    volumeAccelerationX: 2,
    txCount1m: 30,
    estimatedPriceImpactPct: 0.2,
    entryScore: 5,
    entryScoreComponents: null,
    expectedNetEdgePct: 1,
    expectedNetEdgeBreakdown: null,
    riskAllowed: true,
    riskRejectReasons: [],
    ledToTradeId: null,
    strategyVersion: 'baseline-v1',
    ...overrides,
  };
}

describe('toHistoricalSnapshot', () => {
  it('losslessly renames/regroups fields, never inventing a value', () => {
    const record = makeRecord({ safetyPassed: false, safetyReasons: ['liquidity_below_minimum'] });
    const snapshot = toHistoricalSnapshot(record);
    expect(snapshot).toEqual({
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
      estimatedSellPriceImpactPct: null, // Phase 5.6: never invented when the record has none
      safetyPassedAtObservationTime: false,
      safetyReasonsAtObservationTime: ['liquidity_below_minimum'],
    });
  });

  it('passes through nulls rather than substituting a fabricated default', () => {
    const record = makeRecord({ priceSol: null, liquiditySol: null, txCount1m: null });
    const snapshot = toHistoricalSnapshot(record);
    expect(snapshot.priceSol).toBeNull();
    expect(snapshot.liquiditySol).toBeNull();
    expect(snapshot.txCount1m).toBeNull();
  });
});

describe('groupSnapshotsByMint', () => {
  it('groups records by mint while preserving relative order within each mint', () => {
    const records = [
      makeRecord({ mint: 'A', evaluatedAtMs: 1000 }),
      makeRecord({ mint: 'B', evaluatedAtMs: 1500 }),
      makeRecord({ mint: 'A', evaluatedAtMs: 2000 }),
    ];
    const grouped = groupSnapshotsByMint(records);
    expect([...grouped.keys()].sort()).toEqual(['A', 'B']);
    expect(grouped.get('A')!.map((s) => s.observedAtMs)).toEqual([1000, 2000]);
    expect(grouped.get('B')!.map((s) => s.observedAtMs)).toEqual([1500]);
  });
});
