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

  // investigate/production-fetch-abandon, Phase 1 (prepared-statement caching): every statement below is now
  // prepared ONCE in the constructor and reused for the lifetime of the instance, instead of being re-prepared on
  // every call. These tests target exactly the failure modes that reuse (rather than per-call prepare()) could
  // introduce -- stale bound parameters leaking across calls, a statement left unusable after a constraint error,
  // or a cached statement outliving a closed database differently than a fresh prepare() would.
  describe('prepared-statement caching regression', () => {
    it('repeated calls to the same cached statement never leak bound parameters from a previous call', () => {
      // Same cached statement (stmtUpsertHealthCounter), many distinct logical calls, interleaved names/values.
      ledger.incrementCounter('a', 1);
      ledger.incrementCounter('b', 5);
      ledger.incrementCounter('a', 2);
      ledger.incrementCounter('c', 100);
      ledger.incrementCounter('b', 1);
      ledger.incrementCounter('a', 1);
      expect(ledger.getCounters()).toEqual({ a: 4, b: 6, c: 100 });
    });

    it('repeated getOpenPosition calls for different mints never return a stale/previous row', () => {
      ledger.recordEntry(makeTrade({ tradeId: 't1', strategyVersion: 'V1', mint: 'MINT_A' }));
      ledger.recordEntry(makeTrade({ tradeId: 't2', strategyVersion: 'V1', mint: 'MINT_B' }));
      // Interrogate the SAME cached statement (stmtSelectOpenPosition) back and forth, many times, across both keys
      // and a key that doesn't exist -- a statement that retained state from a prior .get() would surface here.
      for (let i = 0; i < 5; i++) {
        expect(ledger.getOpenPosition('V1', 'MINT_A')?.tradeId).toBe('t1');
        expect(ledger.getOpenPosition('V1', 'MINT_B')?.tradeId).toBe('t2');
        expect(ledger.getOpenPosition('V1', 'MINT_NONEXISTENT')).toBeNull();
        expect(ledger.getOpenPosition('V2', 'MINT_A')).toBeNull(); // right mint, wrong strategy
      }
    });

    it('interleaved calls across every hot-path method (as a real evaluation tick would make them) stay isolated per strategy/mint', () => {
      // Mirrors the real call order inside ShadowRunner.onMarketTick(): data-quality event, missed signal, latency
      // sample and health counter, interleaved for two different strategies/mints in the same "tick batch" -- proving
      // the caching doesn't cross-contaminate concurrent LOGICAL calls sharing one cached statement.
      ledger.recordDataQualityEvent('dq_v1', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 1000, kind: 'stale_market_data', severity: 'warning', detail: 'x' });
      ledger.recordMissedSignal('m_v1', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 1000, reason: 'reentry_cooldown_active', detail: 'v1-detail' });
      ledger.recordDataQualityEvent('dq_v2', { mint: 'MINT_B', strategyVersion: 'V2', observedAtMs: 1001, kind: 'impossible_price_change', severity: 'block', detail: 'y' });
      ledger.recordMissedSignal('m_v2', { mint: 'MINT_B', strategyVersion: 'V2', observedAtMs: 1001, reason: 'daily_loss_limit', detail: 'v2-detail' });
      ledger.recordLatencySample('lat_v1', {
        mint: 'MINT_A', observedAtMs: 1000, discoveryTimeMs: 0, signalTimeMs: 500, quoteTimeMs: null,
        simulationTimeMs: 600, exitSignalTimeMs: null, discoveryLatencyMs: 500, signalLatencyMs: 100,
        quoteLatencyMs: null, processingLatencyMs: 600,
      });
      ledger.incrementCounter('shadow_ticks_received', 1);
      ledger.recordDataQualityEvent('dq_v1_second', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 1002, kind: 'stale_market_data', severity: 'warning', detail: 'x2' });
      ledger.incrementCounter('shadow_ticks_received', 1);

      const v1Missed = ledger.getRecentMissedSignals('V1', 0);
      const v2Missed = ledger.getRecentMissedSignals('V2', 0);
      expect(v1Missed).toHaveLength(1);
      expect(v1Missed[0]!.detail).toBe('v1-detail');
      expect(v2Missed).toHaveLength(1);
      expect(v2Missed[0]!.detail).toBe('v2-detail');

      const dqEvents = ledger.getRecentDataQualityEvents(0);
      expect(dqEvents).toHaveLength(3);
      expect(dqEvents.filter((e) => e.strategyVersion === 'V1')).toHaveLength(2);
      expect(dqEvents.filter((e) => e.strategyVersion === 'V2')).toHaveLength(1);

      expect(ledger.getRecentLatencySamples(0)).toHaveLength(1);
      expect(ledger.getCounters()).toEqual({ shadow_ticks_received: 2 });
    });

    it('a UNIQUE/PRIMARY KEY constraint violation throws, and the cached statement remains fully usable afterward', () => {
      // recordEntry twice with the same tradeId -- shadow_trades.trade_id is PRIMARY KEY. This is the exact class of
      // bug statement reuse (vs. a fresh prepare() every call) could introduce: does the cached StatementSync survive
      // throwing mid-bind/execute and remain correctly usable for the NEXT, distinct call?
      ledger.recordEntry(makeTrade({ tradeId: 'dup_1', mint: 'MINT_A' }));
      expect(() => ledger.recordEntry(makeTrade({ tradeId: 'dup_1', mint: 'MINT_A' }))).toThrow();
      // The cached stmtInsertTrade statement must still work for a fresh, non-conflicting call right after the error.
      ledger.recordEntry(makeTrade({ tradeId: 'dup_2', mint: 'MINT_B' }));
      expect(ledger.getOpenPositions('V1').map((p) => p.tradeId).sort()).toEqual(['dup_1', 'dup_2']);

      // Same check for the other three PK-guarded INSERT statements used on the hot path.
      ledger.recordMissedSignal('missed_dup', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 1, reason: 'reentry_cooldown_active', detail: 'first' });
      expect(() => ledger.recordMissedSignal('missed_dup', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 2, reason: 'reentry_cooldown_active', detail: 'second' })).toThrow();
      ledger.recordMissedSignal('missed_ok', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 3, reason: 'reentry_cooldown_active', detail: 'third' });
      expect(ledger.getRecentMissedSignals('V1', 0)).toHaveLength(2);

      ledger.recordDataQualityEvent('dq_dup', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 1, kind: 'stale_market_data', severity: 'warning', detail: 'first' });
      expect(() => ledger.recordDataQualityEvent('dq_dup', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 2, kind: 'stale_market_data', severity: 'warning', detail: 'second' })).toThrow();
      ledger.recordDataQualityEvent('dq_ok', { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 3, kind: 'stale_market_data', severity: 'warning', detail: 'third' });
      expect(ledger.getRecentDataQualityEvents(0)).toHaveLength(2);

      ledger.recordLatencySample('lat_dup', {
        mint: 'MINT_A', observedAtMs: 1, discoveryTimeMs: 0, signalTimeMs: 1, quoteTimeMs: null,
        simulationTimeMs: 1, exitSignalTimeMs: null, discoveryLatencyMs: 1, signalLatencyMs: 1, quoteLatencyMs: null, processingLatencyMs: 1,
      });
      expect(() =>
        ledger.recordLatencySample('lat_dup', {
          mint: 'MINT_A', observedAtMs: 2, discoveryTimeMs: 0, signalTimeMs: 1, quoteTimeMs: null,
          simulationTimeMs: 1, exitSignalTimeMs: null, discoveryLatencyMs: 1, signalLatencyMs: 1, quoteLatencyMs: null, processingLatencyMs: 1,
        }),
      ).toThrow();
      ledger.recordLatencySample('lat_ok', {
        mint: 'MINT_A', observedAtMs: 3, discoveryTimeMs: 0, signalTimeMs: 1, quoteTimeMs: null,
        simulationTimeMs: 1, exitSignalTimeMs: null, discoveryLatencyMs: 1, signalLatencyMs: 1, quoteLatencyMs: null, processingLatencyMs: 1,
      });
      expect(ledger.getRecentLatencySamples(0)).toHaveLength(2);
    });

    it('recordExit on a non-existent tradeId affects no rows and does not throw or corrupt subsequent calls', () => {
      ledger.recordEntry(makeTrade({ tradeId: 'real_trade', mint: 'MINT_A' }));
      expect(() =>
        ledger.recordExit('does_not_exist', {
          exitTimeMs: 2000, exitPriceSol: 1, exitReason: 'quick_tp', exitFeesSol: 0,
          pnlSol: 0, pnlPct: 0, holdDurationMs: 0, maxFavorableExcursionPct: 0, maxAdverseExcursionPct: 0,
        }),
      ).not.toThrow();
      // The real position is untouched, and the cached UPDATE statement still works correctly for it.
      expect(ledger.getOpenPositions('V1')).toHaveLength(1);
      ledger.recordExit('real_trade', {
        exitTimeMs: 2000, exitPriceSol: 1.1, exitReason: 'quick_tp', exitFeesSol: 0,
        pnlSol: 0.03, pnlPct: 10, holdDurationMs: 1000, maxFavorableExcursionPct: 10, maxAdverseExcursionPct: 0,
      });
      expect(ledger.getOpenPositions('V1')).toHaveLength(0);
      expect(ledger.getAllClosedTrades('V1')[0]!.tradeId).toBe('real_trade');
    });

    it('throws when used after the underlying database is closed, exactly like a fresh prepare() would', () => {
      const db = openLedger(':memory:');
      const closingLedger = new ShadowLedger(db);
      closingLedger.incrementCounter('probe', 1); // proves the cached statements work before close()
      db.close();
      expect(() => closingLedger.incrementCounter('probe', 1)).toThrow();
      expect(() => closingLedger.getOpenPosition('V1', 'MINT_A')).toThrow();
    });

    it('a second ShadowLedger instance over a fresh DatabaseSync gets its own independently cached statements', () => {
      // Guards against any accidental module-level/static statement sharing between instances.
      const dbTwo = openLedger(':memory:');
      const ledgerTwo = new ShadowLedger(dbTwo);
      ledger.recordEntry(makeTrade({ tradeId: 'only_in_first', mint: 'MINT_A' }));
      expect(ledger.getOpenPositions('V1')).toHaveLength(1);
      expect(ledgerTwo.getOpenPositions('V1')).toHaveLength(0);
      ledgerTwo.recordEntry(makeTrade({ tradeId: 'only_in_second', mint: 'MINT_A' }));
      expect(ledger.getOpenPositions('V1').map((p) => p.tradeId)).toEqual(['only_in_first']);
      expect(ledgerTwo.getOpenPositions('V1').map((p) => p.tradeId)).toEqual(['only_in_second']);
    });
  });
});
