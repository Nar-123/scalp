import { describe, expect, it, beforeEach } from 'vitest';
import { openLedger } from '../../src/ledger/db.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import type { ShadowTradeRecord } from '../../src/shadow/types.js';

function makeTrade(overrides: Partial<ShadowTradeRecord> = {}): ShadowTradeRecord {
  return {
    tradeId: 'shadow_1',
    strategyVersion: 'V1',
    executionMode: 'shadow',
    simulatorVersion: 'shadow-v1',
    mint: 'MINT_A',
    reentryIndex: 0,
    entryTimeMs: 1000,
    entryPriceSol: 1,
    entrySizeSol: 0.3,
    entryFilledAmountSol: 0.297,
    entryFeesSol: 0.001,
    entryScore: 5,
    expectedNetEdgePct: 1,
    entryLiquiditySol: 40,
    entryQuote: null,
    exitTimeMs: null,
    exitPriceSol: null,
    exitReason: null,
    exitFeesSol: null,
    status: 'open',
    pnlSol: null,
    pnlPct: null,
    holdDurationMs: null,
    maxFavorableExcursionPct: null,
    maxAdverseExcursionPct: null,
    ...overrides,
  };
}

describe('ShadowLedger', () => {
  let ledger: ShadowLedger;

  beforeEach(() => {
    const db = openLedger(':memory:');
    ledger = new ShadowLedger(db);
  });

  it('records an entry and retrieves it as an open position', () => {
    ledger.recordEntry(makeTrade());
    const open = ledger.getOpenPositions('V1');
    expect(open).toEqual([{ tradeId: 'shadow_1', mint: 'MINT_A', entrySizeSol: 0.3 }]);
  });

  it('closes a position and removes it from open positions', () => {
    ledger.recordEntry(makeTrade());
    ledger.recordExit('shadow_1', {
      exitTimeMs: 2000, exitPriceSol: 1.03, exitReason: 'quick_tp', exitFeesSol: 0.001,
      pnlSol: 0.005, pnlPct: 1.7, holdDurationMs: 1000, maxFavorableExcursionPct: 3, maxAdverseExcursionPct: 0,
    });
    expect(ledger.getOpenPositions('V1')).toHaveLength(0);
    const closed = ledger.getAllClosedTrades('V1');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('quick_tp');
    expect(closed[0]!.pnlSol).toBeCloseTo(0.005, 10);
  });

  it('never mixes two strategy versions open positions, daily risk, or token history', () => {
    ledger.recordEntry(makeTrade({ tradeId: 't_v1', strategyVersion: 'V1', mint: 'MINT_A' }));
    ledger.recordEntry(makeTrade({ tradeId: 't_v2', strategyVersion: 'V2', mint: 'MINT_A' }));

    expect(ledger.getOpenPositions('V1')).toEqual([{ tradeId: 't_v1', mint: 'MINT_A', entrySizeSol: 0.3 }]);
    expect(ledger.getOpenPositions('V2')).toEqual([{ tradeId: 't_v2', mint: 'MINT_A', entrySizeSol: 0.3 }]);

    ledger.getOrInitDailyRiskState('V1', '2026-01-01', 10);
    ledger.applyRealizedPnl('V1', '2026-01-01', -1);
    expect(ledger.getOrInitDailyRiskState('V1', '2026-01-01', 10).realizedPnlSol).toBeCloseTo(-1, 10);
    expect(ledger.getOrInitDailyRiskState('V2', '2026-01-01', 10).realizedPnlSol).toBe(0);
  });

  it('computes token trade history scoped per strategy version', () => {
    ledger.recordEntry(makeTrade({ tradeId: 't1', strategyVersion: 'V1', mint: 'MINT_A', reentryIndex: 0 }));
    ledger.recordExit('t1', { exitTimeMs: 2000, exitPriceSol: 0.9, exitReason: 'dynamic_sl', exitFeesSol: 0.001, pnlSol: -0.02, pnlPct: -6, holdDurationMs: 1000, maxFavorableExcursionPct: 0, maxAdverseExcursionPct: -10 });

    const historyV1 = ledger.getTokenTradeHistory('V1', 'MINT_A');
    expect(historyV1.totalTrades).toBe(1);
    expect(historyV1.consecutiveLosses).toBe(1);

    const historyV2 = ledger.getTokenTradeHistory('V2', 'MINT_A');
    expect(historyV2.totalTrades).toBe(0); // V2 never traded this mint -- V1's history must not leak in
  });

  it('latches the circuit breaker per strategy version and keeps the first trigger timestamp', () => {
    ledger.getOrInitDailyRiskState('V1', '2026-01-01', 10);
    ledger.latchCircuitBreaker('V1', '2026-01-01', 5000);
    ledger.latchCircuitBreaker('V1', '2026-01-01', 9999);
    expect(ledger.getOrInitDailyRiskState('V1', '2026-01-01', 10).circuitBreakerTriggered).toBe(true);
    expect(ledger.getOrInitDailyRiskState('V2', '2026-01-01', 10).circuitBreakerTriggered).toBe(false);
  });

  it('records and retrieves missed signals scoped by strategy version', () => {
    ledger.recordMissedSignal('m1', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 1000, reason: 'reentry_cooldown_active', detail: 'x' });
    ledger.recordMissedSignal('m2', { mint: 'MINT_A', strategyVersion: 'V2', observedAtMs: 1000, reason: 'reentry_cooldown_active', detail: 'x' });
    expect(ledger.getRecentMissedSignals('V1', 0)).toHaveLength(1);
    expect(ledger.getRecentMissedSignals('V2', 0)).toHaveLength(1);
  });

  it('records and retrieves data quality events', () => {
    ledger.recordDataQualityEvent('dq1', { mint: 'MINT_A', strategyVersion: null, observedAtMs: 1000, kind: 'stale_market_data', severity: 'warning', detail: 'x' });
    const events = ledger.getRecentDataQualityEvents(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('stale_market_data');
  });

  it('records and retrieves latency samples', () => {
    ledger.recordLatencySample('lat1', {
      mint: 'MINT_A', observedAtMs: 1000, discoveryTimeMs: 0, signalTimeMs: 500, quoteTimeMs: null,
      simulationTimeMs: 600, exitSignalTimeMs: null, discoveryLatencyMs: 500, signalLatencyMs: 100,
      quoteLatencyMs: null, processingLatencyMs: 600,
    });
    ledger.recordLatencySample('lat2', {
      mint: 'MINT_A', observedAtMs: 1001, discoveryTimeMs: 0, detectedAtMs: null, marketDataTimeMs: null, signalTimeMs: 500, quoteTimeMs: null,
      simulationTimeMs: 600, exitSignalTimeMs: null, discoveryLatencyMs: null, marketDataLatencyMs: null,
      quoteLatencyMs: null, signalLatencyMs: 100, processingLatencyMs: 100, shadowProcessingLatencyMs: 2,
    });
    const samples = ledger.getRecentLatencySamples(0);
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.discoveryLatencyMs === null)?.shadowProcessingLatencyMs).toBe(2);
    expect(samples.find((s) => s.processingLatencyMs === 600)).toBeDefined();
  });

  it('round-trips an entry quote observation through JSON', () => {
    ledger.recordEntry(makeTrade({
      entryQuote: { quotedPriceSol: 1.001, quoteTimestampMs: 999, route: 'raydium', expectedOutputSol: 0.3, estimatedPriceImpactPct: 0.2, estimatedSlippagePct: 0.3 },
    }));
    const open = ledger.getOpenPosition('V1', 'MINT_A');
    expect(open?.entryQuote).toEqual({ quotedPriceSol: 1.001, quoteTimestampMs: 999, route: 'raydium', expectedOutputSol: 0.3, estimatedPriceImpactPct: 0.2, estimatedSlippagePct: 0.3 });
  });
});
