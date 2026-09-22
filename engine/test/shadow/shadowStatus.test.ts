import { describe, expect, it } from 'vitest';
import { openLedger } from '../../src/ledger/db.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import { HealthCounters, buildShadowStatusReport } from '../../src/shadow/shadowStatus.js';
import { utcDateString } from '../../src/utils/time.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleTick } from './fixtures.js';

function setup() {
  const ledger = new ShadowLedger(openLedger(':memory:'));
  const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: 'V1', config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });
  return { ledger, runner };
}

describe('buildShadowStatusReport', () => {
  it('reports zeros and null rates for an empty ledger (never fabricated numbers)', () => {
    const { ledger } = setup();
    const health = new HealthCounters();
    const report = buildShadowStatusReport(ledger, ['V1'], utcDateString, 100_000, health);
    expect(report.strategies[0]).toMatchObject({ openPositions: 0, closedTrades: 0, winRate: null, netPnlSol: 0 });
    expect(report.latency.avgProcessingLatencyMs).toBeNull();
    expect(report.health.rpcSuccessRate).toBeNull();
    expect(report.health.quoteSuccessRate).toBeNull();
  });

  it('aggregates trades, missed signals, data-quality events, latency and daily loss', () => {
    const { ledger, runner } = setup();
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 42_000, priceSol: 1.03 })); // win
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 72_000 })); // cooldown -> missed signal
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 72_000 })); // duplicate -> data quality event

    const report = buildShadowStatusReport(ledger, ['V1'], utcDateString, 100_000, new HealthCounters(), 10_000_000_000_000, 10_000_000_000_000);
    const v1 = report.strategies[0]!;
    expect(v1.closedTrades).toBe(1);
    expect(v1.wins).toBe(1);
    expect(v1.winRate).toBe(1);
    expect(v1.missedSignalsByReason['reentry_cooldown_active']).toBe(1);
    expect(report.dataQualityEventCounts['duplicate_event']).toBe(1);
    expect(report.latency.sampleCount).toBeGreaterThan(0);
    expect(v1.dailySimulatedLossSol).toBe(0);
  });

  it('computes max drawdown and daily simulated loss from realized losses', () => {
    const { ledger, runner } = setup();
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 42_000, priceSol: 0.25 })); // loss ~0.23
    const report = buildShadowStatusReport(ledger, ['V1'], utcDateString, 100_000, new HealthCounters());
    expect(report.strategies[0]!.maxDrawdownSol).toBeGreaterThan(0.2);
    expect(report.strategies[0]!.dailySimulatedLossSol).toBeLessThan(-0.2);
  });
});

describe('HealthCounters', () => {
  it('computes success rates only from what was actually recorded', () => {
    const h = new HealthCounters();
    h.recordRpcResult(true);
    h.recordRpcResult(true);
    h.recordRpcResult(false);
    h.recordQuoteResult(false);
    expect(h.snapshot()).toMatchObject({ rpcSuccessRate: 2 / 3, rpcTotal: 3, quoteSuccessRate: 0, quoteTotal: 1, aggregatorSuccessRate: null, marketDataSuccessRate: null });
  });
});
