import { describe, expect, it } from 'vitest';
import { openLedger } from '../../src/ledger/db.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import type { ShadowStrategyConfig } from '../../src/shadow/shadowRunner.js';
import type { ShadowMarketTick } from '../../src/shadow/types.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleTick } from './fixtures.js';

function makeRunner(strategies: ShadowStrategyConfig[], dbPath = ':memory:') {
  const db = openLedger(dbPath);
  const ledger = new ShadowLedger(db);
  const runner = new ShadowRunner({ ledger, strategies, assumptions: DEFAULT_ASSUMPTIONS });
  return { db, ledger, runner };
}

const V1: ShadowStrategyConfig = { strategyVersion: 'V1', config: DEFAULT_CONFIG };

function winningExitTick(entryAtMs: number): ShadowMarketTick {
  return entryEligibleTick({ observedAtMs: entryAtMs + 2_000, priceSol: 1.03 });
}

function losingExitTick(entryAtMs: number): ShadowMarketTick {
  return entryEligibleTick({ observedAtMs: entryAtMs + 2_000, priceSol: 0.25 }); // -75%: a real loss that is NOT an impossible (>5x) one-tick move
}

describe('ShadowRunner: basic entry/exit', () => {
  it('opens on an entry-eligible tick and exits via quick_tp on a later tick', () => {
    const { ledger, runner } = makeRunner([V1]);

    const outcomes1 = runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    expect(outcomes1[0]!.kind).toBe('entered');

    const outcomes2 = runner.onMarketTick(winningExitTick(40_000));
    expect(outcomes2[0]!.kind).toBe('exited');
    expect(outcomes2[0]!.exitReason).toBe('quick_tp');

    const closed = ledger.getAllClosedTrades('V1');
    expect(closed).toHaveLength(1);
    expect(closed[0]!.pnlSol).toBeGreaterThan(0);
    expect(closed[0]!.executionMode).toBe('shadow');
  });

  it('never opens a second position on a mint while one is already open (no averaging down)', () => {
    const { ledger, runner } = makeRunner([V1]);
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 41_000 })); // still entry-eligible, position already open
    runner.onMarketTick(winningExitTick(40_000));
    expect(ledger.getAllClosedTrades('V1')).toHaveLength(1);
  });

  it('rejects entry when safety was not confirmed at observation time', () => {
    const { ledger, runner } = makeRunner([V1]);
    const outcomes = runner.onMarketTick(entryEligibleTick({ safetyPassedAtObservationTime: false, safetyReasonsAtObservationTime: ['top10_holder_pct_exceeded'] }));
    expect(outcomes[0]!.kind).toBe('rejected_safety');
    expect(ledger.getOpenPositions('V1')).toHaveLength(0);
  });

  it('records a missed_signal (never invents a fill) when required market data is missing', () => {
    const { ledger, runner } = makeRunner([V1]);
    const outcomes = runner.onMarketTick(entryEligibleTick({ priceSol: null }));
    expect(outcomes[0]!.kind).toBe('missed_signal');
    expect(ledger.getRecentMissedSignals('V1', 0)[0]!.reason).toBe('missing_market_data');
  });

  it('rejects entry when baseline filters fail', () => {
    const { runner } = makeRunner([V1]);
    const outcomes = runner.onMarketTick(entryEligibleTick({ liquiditySol: 5 }));
    expect(outcomes[0]!.kind).toBe('rejected_baseline');
  });
});

describe('ShadowRunner: re-entry replay', () => {
  it('blocks re-entry during cooldown and records a missed signal, then allows it after cooldown elapses', () => {
    const { ledger, runner } = makeRunner([V1]);
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    runner.onMarketTick(winningExitTick(40_000)); // exits at 42_000

    const duringCooldown = runner.onMarketTick(entryEligibleTick({ observedAtMs: 72_000 })); // 30s after exit, cooldown is 60s
    expect(duringCooldown[0]!.kind).toBe('missed_signal');
    expect(ledger.getRecentMissedSignals('V1', 0).some((m) => m.reason === 'reentry_cooldown_active')).toBe(true);

    const afterCooldown = runner.onMarketTick(entryEligibleTick({ observedAtMs: 102_001 })); // 60_001ms after exit
    expect(afterCooldown[0]!.kind).toBe('entered');

    const closed = ledger.getAllClosedTrades('V1');
    expect(closed).toHaveLength(1); // the second trade is still open
    expect(ledger.getOpenPositions('V1')).toHaveLength(1);
  });

  it('blocks re-entry once the consecutive-loss limit is reached', () => {
    const { ledger, runner } = makeRunner([V1]);
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    runner.onMarketTick(losingExitTick(40_000));

    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 + 2_000 + 60_001 }));
    runner.onMarketTick(losingExitTick(40_000 + 2_000 + 60_001));

    const thirdAttempt = runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 + 2 * (2_000 + 60_001) }));
    expect(thirdAttempt[0]!.kind).toBe('missed_signal');
    expect(ledger.getAllClosedTrades('V1')).toHaveLength(2);
  });

  it('blocks re-entry once MAX_REENTRY is exhausted (6 total trades)', () => {
    const { ledger, runner } = makeRunner([V1]);
    let t = 40_000;
    for (let i = 0; i < 6; i += 1) {
      runner.onMarketTick(entryEligibleTick({ observedAtMs: t }));
      runner.onMarketTick(winningExitTick(t));
      t += 2_000 + 60_001;
    }
    const seventh = runner.onMarketTick(entryEligibleTick({ observedAtMs: t }));
    expect(seventh[0]!.kind).toBe('missed_signal');
    expect(ledger.getAllClosedTrades('V1')).toHaveLength(6);
  });
});

describe('ShadowRunner: risk-limit replay', () => {
  it('latches the daily circuit breaker after cumulative losses breach the daily limit, blocking a fresh mint', () => {
    const { ledger, runner } = makeRunner([V1]);
    for (const [mint, entryAt] of [['MINT_1', 40_000], ['MINT_2', 50_000], ['MINT_3', 60_000], ['MINT_4', 70_000], ['MINT_5', 80_000]] as const) {
      runner.onMarketTick(entryEligibleTick({ mint, observedAtMs: entryAt }));
      runner.onMarketTick(entryEligibleTick({ mint, observedAtMs: entryAt + 2_000, priceSol: 0.25 }));
    }
    const outcome = runner.onMarketTick(entryEligibleTick({ mint: 'MINT_6', observedAtMs: 90_000 }));
    expect(outcome[0]!.kind).toBe('missed_signal');
    expect(ledger.getRecentMissedSignals('V1', 0).some((m) => m.reason === 'daily_loss_circuit_breaker_triggered')).toBe(true);
  });

  it('never opens more than the hard concurrent-position limit at once', () => {
    const { ledger, runner } = makeRunner([V1]);
    runner.onMarketTick(entryEligibleTick({ mint: 'MINT_1', observedAtMs: 40_000 }));
    runner.onMarketTick(entryEligibleTick({ mint: 'MINT_2', observedAtMs: 40_001 }));
    runner.onMarketTick(entryEligibleTick({ mint: 'MINT_3', observedAtMs: 40_002 }));
    const fourth = runner.onMarketTick(entryEligibleTick({ mint: 'MINT_4', observedAtMs: 40_003 }));
    expect(fourth[0]!.kind).toBe('missed_signal');
    expect(ledger.getOpenPositions('V1')).toHaveLength(3);
  });
});

describe('ShadowRunner: production isolation', () => {
  it('never writes to the real trades/token_evaluations/daily_risk_state tables', () => {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const runner = new ShadowRunner({ ledger, strategies: [V1], assumptions: DEFAULT_ASSUMPTIONS });
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    runner.onMarketTick(winningExitTick(40_000));

    const tradesCount = (db.prepare('SELECT COUNT(*) as n FROM trades').get() as { n: number }).n;
    const evalCount = (db.prepare('SELECT COUNT(*) as n FROM token_evaluations').get() as { n: number }).n;
    const riskCount = (db.prepare('SELECT COUNT(*) as n FROM daily_risk_state').get() as { n: number }).n;
    expect(tradesCount).toBe(0);
    expect(evalCount).toBe(0);
    expect(riskCount).toBe(0);

    const shadowTradesCount = (db.prepare('SELECT COUNT(*) as n FROM shadow_trades').get() as { n: number }).n;
    expect(shadowTradesCount).toBe(1);
  });
});

describe('ShadowRunner: candidate/shadow isolation', () => {
  it('runs two strategy versions against the identical tick stream without cross-contamination', () => {
    const tightV2: ShadowStrategyConfig = {
      strategyVersion: 'V2',
      config: { ...DEFAULT_CONFIG, filters: { ...DEFAULT_CONFIG.filters, minLiquiditySol: 1000 } },
    };
    const { ledger, runner } = makeRunner([V1, tightV2]);

    const outcomes = runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    const v1Outcome = outcomes.find((o) => o.strategyVersion === 'V1')!;
    const v2Outcome = outcomes.find((o) => o.strategyVersion === 'V2')!;

    expect(v1Outcome.kind).toBe('entered');
    expect(v2Outcome.kind).toBe('rejected_baseline');

    expect(ledger.getOpenPositions('V1')).toHaveLength(1);
    expect(ledger.getOpenPositions('V2')).toHaveLength(0);
  });

  it('a loss in one shadow strategy never affects another strategy\'s daily risk state', () => {
    const v2: ShadowStrategyConfig = { strategyVersion: 'V2', config: DEFAULT_CONFIG };
    const { ledger, runner } = makeRunner([V1, v2]);

    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 })); // both V1 and V2 process this same tick internally
    runner.onMarketTick(losingExitTick(40_000));

    const v1Daily = ledger.getOrInitDailyRiskState('V1', '1970-01-01', 10);
    const v2Daily = ledger.getOrInitDailyRiskState('V2', '1970-01-01', 10);
    expect(v1Daily.realizedPnlSol).toBeLessThan(0);
    expect(v2Daily.realizedPnlSol).toBeLessThan(0); // both lost identically since both entered the same trade -- but each recorded independently
    expect(ledger.getAllClosedTrades('V1')).toHaveLength(1);
    expect(ledger.getAllClosedTrades('V2')).toHaveLength(1);
  });
});

describe('ShadowRunner: data quality gating', () => {
  it('skips decision-making for every configured strategy on a duplicate tick, but still records exactly one data-quality event', () => {
    const v2: ShadowStrategyConfig = { strategyVersion: 'V2', config: DEFAULT_CONFIG };
    const { ledger, runner } = makeRunner([V1, v2]);

    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 })); // both V1 and V2 enter on this tick
    const duplicateOutcomes = runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 })); // exact duplicate

    expect(duplicateOutcomes.every((o) => o.kind === 'skipped_data_quality')).toBe(true);
    // The duplicate tick made NO further state change for either strategy --
    // both positions opened on the first tick remain open, untouched.
    expect(ledger.getOpenPositions('V1')).toHaveLength(1);
    expect(ledger.getOpenPositions('V2')).toHaveLength(1);
    const dqEvents = ledger.getRecentDataQualityEvents(0).filter((e) => e.kind === 'duplicate_event');
    expect(dqEvents).toHaveLength(1); // recorded once per tick, not once per strategy
  });

  it('records staleness but does NOT block decision-making (stale data is a warning, not a hard stop)', () => {
    const { ledger, runner } = makeRunner([V1]);
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    const outcomes = runner.onMarketTick(winningExitTick(40_000 + 20_000)); // a large, "stale" gap, but still forward-moving and unique
    expect(outcomes[0]!.kind).toBe('exited'); // the exit still processed despite the staleness
    expect(ledger.getRecentDataQualityEvents(0).some((e) => e.kind === 'stale_market_data')).toBe(true);
  });
});

describe('ShadowRunner: determinism and restart persistence', () => {
  it('produces identical trades when replaying the same ticks through two independent runners', () => {
    const runA = makeRunner([V1]);
    const runB = makeRunner([V1]);
    const ticks = [entryEligibleTick({ observedAtMs: 40_000 }), winningExitTick(40_000)];
    for (const tick of ticks) {
      runA.runner.onMarketTick(tick);
      runB.runner.onMarketTick(tick);
    }
    // tradeId is a genId()-based unique string (by design, never meant to be
    // reproducible across independent runs) -- everything else about the
    // decision must be identical.
    const stripTradeId = (trades: ReturnType<typeof runA.ledger.getAllClosedTrades>) =>
      trades.map(({ tradeId: _tradeId, ...rest }) => rest);
    expect(stripTradeId(runA.ledger.getAllClosedTrades('V1'))).toEqual(stripTradeId(runB.ledger.getAllClosedTrades('V1')));
  });

  it('persists open-position and daily-risk state across a simulated process restart (a fresh ShadowRunner over the same ledger)', () => {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const runnerBeforeRestart = new ShadowRunner({ ledger, strategies: [V1], assumptions: DEFAULT_ASSUMPTIONS });
    runnerBeforeRestart.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    expect(ledger.getOpenPositions('V1')).toHaveLength(1);

    // Simulate a restart: brand-new ShadowRunner instance (fresh in-memory
    // price-history/lastTick caches), same underlying ledger.
    const runnerAfterRestart = new ShadowRunner({ ledger, strategies: [V1], assumptions: DEFAULT_ASSUMPTIONS });
    const outcomes = runnerAfterRestart.onMarketTick(winningExitTick(40_000));
    expect(outcomes[0]!.kind).toBe('exited');
    expect(ledger.getOpenPositions('V1')).toHaveLength(0);
    expect(ledger.getAllClosedTrades('V1')).toHaveLength(1);
  });
});
