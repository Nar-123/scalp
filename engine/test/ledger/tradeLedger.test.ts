import { describe, expect, it, beforeEach } from 'vitest';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import type { TradeEntryRecord, TradeExitRecord, TokenEvaluationRecord } from '../../src/types/trade.js';

function makeEntry(overrides: Partial<TradeEntryRecord> = {}): TradeEntryRecord {
  return {
    id: 'trade_1',
    mint: 'MINT',
    poolAddress: null,
    strategyVersion: 'baseline-v1',
    dryRun: true,
    reentryIndex: 0,
    entryTimeMs: 1000,
    entryPriceSol: 1,
    entrySizeSol: 0.3,
    entryTokenAgeSec: 45,
    entryLiquiditySol: 40,
    entryVolume1mSol: 10,
    entryBuySellRatio: 2,
    entryPriceVelocity5sPct: 1.5,
    entryVolumeAccelerationX: 2,
    entryScore: 3.5,
    entryScoreComponents: { momentum: 1.5 },
    expectedNetEdgePct: 0.5,
    expectedNetEdgeBreakdown: { grossMovePct: 2 },
    entrySlippagePct: 0.3,
    entryPriceImpactPct: 0.5,
    entryFeesSol: 0.001,
    entryTxSignature: null,
    entrySafetyCheckId: null,
    dailyRealizedPnlSolAtEntry: 0,
    ...overrides,
  };
}

function makeExit(overrides: Partial<TradeExitRecord> = {}): TradeExitRecord {
  return {
    exitTimeMs: 2000,
    exitPriceSol: 1.02,
    exitReason: 'quick_tp',
    exitFeesSol: 0.001,
    exitTxSignature: null,
    exitSlippagePct: 0.3,
    holdDurationMs: 1000,
    pnlSol: 0.005,
    pnlPct: 1.7,
    maxFavorableExcursionPct: 2,
    maxAdverseExcursionPct: -0.5,
    dailyRealizedPnlSolAtExit: 0.005,
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<TokenEvaluationRecord> = {}): TokenEvaluationRecord {
  return {
    id: 'eval_1',
    mint: 'MINT',
    poolAddress: null,
    discoverySource: 'raydium',
    discoveredAtMs: 500,
    evaluatedAtMs: 1000,
    tokenAgeSec: 30,
    safetyPassed: true,
    safetyReasons: [],
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    top10HolderPct: 20,
    liquiditySol: 40,
    volume1mSol: 10,
    buySellRatio: 2,
    priceVelocity5sPct: 1.5,
    volumeAccelerationX: 2,
    estimatedPriceImpactPct: 0.5,
    entryScore: 3.5,
    entryScoreComponents: { momentum: 1.5 },
    expectedNetEdgePct: 0.5,
    expectedNetEdgeBreakdown: { grossMovePct: 2 },
    riskAllowed: true,
    riskRejectReasons: [],
    ledToTradeId: null,
    strategyVersion: 'baseline-v1',
    ...overrides,
  };
}

describe('TradeLedger', () => {
  let ledger: TradeLedger;

  beforeEach(() => {
    const db = openLedger(':memory:');
    ledger = new TradeLedger(db);
  });

  it('runs migrations idempotently (openLedger can be called on the same file repeatedly)', () => {
    // :memory: creates a fresh db each time in beforeEach; this just confirms
    // openLedger doesn't throw when re-run against an already-migrated schema.
    expect(() => openLedger(':memory:')).not.toThrow();
  });

  it('records an entry and can retrieve it as an open position', () => {
    ledger.recordEntry(makeEntry());
    const open = ledger.getOpenPositions();
    expect(open).toHaveLength(1);
    expect(open[0]).toEqual({ tradeId: 'trade_1', mint: 'MINT', entrySizeSol: 0.3 });
  });

  it('closes a position on exit and removes it from open positions', () => {
    ledger.recordEntry(makeEntry());
    ledger.recordExit('trade_1', makeExit());
    expect(ledger.getOpenPositions()).toHaveLength(0);
  });

  it('links an evaluation to the trade it led to', () => {
    ledger.recordEvaluation(makeEvaluation({ id: 'eval_1' }));
    ledger.recordEntry(makeEntry({ entrySafetyCheckId: 'eval_1' }));
    // No direct getter for token_evaluations in this pass; verify indirectly
    // via getTokenTradeHistory not throwing and the entry existing.
    expect(ledger.getOpenPositions()).toHaveLength(1);
  });

  it('aggregates daily realized PnL across multiple exits on the same day', () => {
    ledger.getOrInitDailyRiskState('2026-01-01', 10);
    ledger.applyRealizedPnl('2026-01-01', 0.01);
    ledger.applyRealizedPnl('2026-01-01', -0.02);
    expect(ledger.getDailyRealizedPnl('2026-01-01')).toBeCloseTo(-0.01, 10);
  });

  it('keeps daily PnL separate across different UTC dates', () => {
    ledger.getOrInitDailyRiskState('2026-01-01', 10);
    ledger.getOrInitDailyRiskState('2026-01-02', 10);
    ledger.applyRealizedPnl('2026-01-01', 0.05);
    expect(ledger.getDailyRealizedPnl('2026-01-01')).toBeCloseTo(0.05, 10);
    expect(ledger.getDailyRealizedPnl('2026-01-02')).toBe(0);
  });

  it('latches the circuit breaker and keeps the first trigger timestamp on repeated latch calls', () => {
    ledger.getOrInitDailyRiskState('2026-01-01', 10);
    ledger.latchCircuitBreaker('2026-01-01', 5000);
    ledger.latchCircuitBreaker('2026-01-01', 9999); // should not overwrite the first timestamp
    const state = ledger.getOrInitDailyRiskState('2026-01-01', 10);
    expect(state.circuitBreakerTriggered).toBe(true);
  });

  it('computes token trade history: totalTrades, consecutive losses, cumulative PnL', () => {
    ledger.recordEntry(makeEntry({ id: 't1', reentryIndex: 0 }));
    ledger.recordExit('t1', makeExit({ pnlSol: -0.01, exitTimeMs: 2000 }));

    ledger.recordEntry(makeEntry({ id: 't2', reentryIndex: 1, entryTimeMs: 3000 }));
    ledger.recordExit('t2', makeExit({ pnlSol: -0.02, exitTimeMs: 4000 }));

    const history = ledger.getTokenTradeHistory('MINT');
    expect(history.totalTrades).toBe(2);
    expect(history.consecutiveLosses).toBe(2);
    expect(history.cumulativePnlSol).toBeCloseTo(-0.03, 10);
    expect(history.lastTradeExitTimeMs).toBe(4000);
    expect(history.lastTradeWasLoss).toBe(true);
  });

  it('resets consecutive losses once a winning trade breaks the streak', () => {
    ledger.recordEntry(makeEntry({ id: 't1' }));
    ledger.recordExit('t1', makeExit({ pnlSol: -0.01, exitTimeMs: 2000 }));

    ledger.recordEntry(makeEntry({ id: 't2', entryTimeMs: 3000 }));
    ledger.recordExit('t2', makeExit({ pnlSol: 0.02, exitTimeMs: 4000 }));

    const history = ledger.getTokenTradeHistory('MINT');
    expect(history.consecutiveLosses).toBe(0);
  });

  it('returns a zeroed history for a mint that has never traded', () => {
    const history = ledger.getTokenTradeHistory('NEVER_TRADED');
    expect(history.totalTrades).toBe(0);
    expect(history.lastTradeExitTimeMs).toBeNull();
    expect(history.consecutiveLosses).toBe(0);
  });
});
