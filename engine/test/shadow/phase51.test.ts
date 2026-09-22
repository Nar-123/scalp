import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEVERITY_BY_KIND, checkTickDataQuality, isBlockingSeverity } from '../../src/shadow/dataQualityMonitor.js';
import { openLedger } from '../../src/ledger/db.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import type { ShadowStrategyConfig } from '../../src/shadow/shadowRunner.js';
import { HealthCounters } from '../../src/shadow/shadowStatus.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleTick } from './fixtures.js';

const V1: ShadowStrategyConfig = { strategyVersion: 'V1', config: DEFAULT_CONFIG };
const ENGINE_SRC = join(__dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
function codeOnly(source: string): string {
  return source.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
}

describe('data-quality severity policy', () => {
  it('maps kinds to the specified severities', () => {
    expect(SEVERITY_BY_KIND.duplicate_event).toBe('block');
    expect(SEVERITY_BY_KIND.out_of_order_event).toBe('block');
    expect(SEVERITY_BY_KIND.stale_market_data).toBe('warning');
    for (const k of ['impossible_price_change', 'invalid_liquidity', 'malformed_market_data'] as const) expect(SEVERITY_BY_KIND[k]).toBe('reject');
    expect(isBlockingSeverity('warning')).toBe(false);
    expect(isBlockingSeverity('reject')).toBe(true);
    expect(isBlockingSeverity('block')).toBe(true);
  });

  it('flags malformed values (NaN, non-positive price, negative volume) as reject', () => {
    for (const bad of [{ priceSol: Number.NaN }, { priceSol: 0 }, { priceSol: -1 }, { volume1mSol: -5 }, { buySellRatio: Number.NaN }, { volumeAccelerationX: Number.NEGATIVE_INFINITY }]) {
      const issues = checkTickDataQuality('MINT_A', null, null, entryEligibleTick(bad));
      expect(issues.some((i) => i.kind === 'malformed_market_data' && i.severity === 'reject'), JSON.stringify(bad)).toBe(true);
    }
  });

  it('records +Infinity ratios (division by zero on brand-new tokens) as a warning, not malformed', () => {
    const issues = checkTickDataQuality('MINT_A', null, null, entryEligibleTick({ buySellRatio: Number.POSITIVE_INFINITY, volumeAccelerationX: Number.POSITIVE_INFINITY }));
    expect(issues.map((i) => `${i.kind}:${i.severity}`)).toEqual(['degenerate_ratio:warning']);
    expect(isBlockingSeverity(issues[0]!.severity)).toBe(false);
  });

  it('every event carries timestamp, token, strategy version slot, kind, severity and reason', () => {
    const [issue] = checkTickDataQuality('MINT_A', 'V1', null, entryEligibleTick({ liquiditySol: -1, observedAtMs: 123 }));
    expect(issue).toMatchObject({ mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 123, kind: 'invalid_liquidity', severity: 'reject' });
    expect(issue!.detail).toContain('liquiditySol');
  });
});

describe('malformed / impossible data never becomes a trade signal', () => {
  it.each([
    ['NaN price', { priceSol: Number.NaN }],
    ['negative liquidity', { liquiditySol: -40 }],
    ['negative volume', { volume1mSol: -1 }],
  ])('rejects an otherwise entry-eligible tick with %s', (_name, overrides) => {
    const ledger = new ShadowLedger(openLedger(':memory:'));
    const runner = new ShadowRunner({ ledger, strategies: [V1], assumptions: DEFAULT_ASSUMPTIONS });
    const outcomes = runner.onMarketTick(entryEligibleTick(overrides));
    expect(outcomes[0]!.kind).toBe('skipped_data_quality');
    expect(ledger.getOpenPositions('V1')).toHaveLength(0);
    expect(ledger.getRecentDataQualityEvents(0).some((e) => e.severity === 'reject')).toBe(true);
  });

  it('rejects an impossible price jump, does not use it as the next baseline, and re-baselines after repeated consistent ticks', () => {
    const ledger = new ShadowLedger(openLedger(':memory:'));
    const runner = new ShadowRunner({ ledger, strategies: [V1], assumptions: DEFAULT_ASSUMPTIONS });
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000, liquiditySol: 5 })); // baseline tick (baseline-rejected, fine)
    const jump = runner.onMarketTick(entryEligibleTick({ observedAtMs: 42_000, priceSol: 50 }));
    expect(jump[0]!.kind).toBe('skipped_data_quality');
    // a normal tick right after the bad one is compared against the GOOD baseline, so it is not flagged
    const normal = runner.onMarketTick(entryEligibleTick({ observedAtMs: 44_000, priceSol: 1.01, liquiditySol: 5 }));
    expect(normal[0]!.kind).not.toBe('skipped_data_quality');
    // a genuine permanent re-pricing is accepted as the baseline after 3 consistent rejections
    for (const t of [46_000, 48_000, 50_000]) runner.onMarketTick(entryEligibleTick({ observedAtMs: t, priceSol: 50, liquiditySol: 5 }));
    expect(runner.onMarketTick(entryEligibleTick({ observedAtMs: 52_000, priceSol: 50.5, liquiditySol: 5 }))[0]!.kind).not.toBe('skipped_data_quality');
  });

  it('blocks duplicate and out-of-order ticks; stale is a warning and still used', () => {
    const health = new HealthCounters();
    const ledger = new ShadowLedger(openLedger(':memory:'));
    const runner = new ShadowRunner({ ledger, strategies: [V1], assumptions: DEFAULT_ASSUMPTIONS, health });
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 50_000, liquiditySol: 5 }));
    expect(runner.onMarketTick(entryEligibleTick({ observedAtMs: 50_000, liquiditySol: 5 }))[0]!.kind).toBe('skipped_data_quality');
    expect(runner.onMarketTick(entryEligibleTick({ observedAtMs: 49_000, liquiditySol: 5 }))[0]!.kind).toBe('skipped_data_quality');
    expect(runner.onMarketTick(entryEligibleTick({ observedAtMs: 80_000, liquiditySol: 5 }))[0]!.kind).toBe('rejected_baseline'); // stale but processed
    const snap = health.snapshot().counters;
    expect(snap.shadow_ticks_received).toBe(4);
    expect(snap.shadow_ticks_rejected_data_quality).toBe(2);
    const severities = ledger.getRecentDataQualityEvents(0).map((e) => `${e.kind}:${e.severity}`);
    expect(severities).toContain('stale_market_data:warning');
    expect(severities).toContain('duplicate_event:block');
    expect(severities).toContain('out_of_order_event:block');
  });

  it('never emits missing_event (no reliable expected-event source exists)', () => {
    const ledger = new ShadowLedger(openLedger(':memory:'));
    const runner = new ShadowRunner({ ledger, strategies: [V1], assumptions: DEFAULT_ASSUMPTIONS });
    for (const t of [40_000, 90_000, 400_000]) runner.onMarketTick(entryEligibleTick({ observedAtMs: t, liquiditySol: 5 }));
    expect(ledger.getRecentDataQualityEvents(0).some((e) => e.kind === 'missing_event')).toBe(false);
  });
});

describe('restart recovery against a real ledger file', () => {
  it('survives process restart: open position, daily risk, counters; no duplicate processing; version isolation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scalp-shadow-restart-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const V2: ShadowStrategyConfig = { strategyVersion: 'V2', config: { ...DEFAULT_CONFIG, filters: { ...DEFAULT_CONFIG.filters, minLiquiditySol: 1000 } } };
    try {
      // --- process 1 ---
      let db = openLedger(dbPath);
      let ledger = new ShadowLedger(db);
      let health = new HealthCounters((n, by) => ledger.incrementCounter(n, by));
      let runner = new ShadowRunner({ ledger, strategies: [V1, V2], assumptions: DEFAULT_ASSUMPTIONS, health });
      runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
      for (const [m, at] of [['M2', 50_000], ['M3', 60_000], ['M4', 70_000], ['M5', 80_000], ['M6', 90_000]] as const) {
        runner.onMarketTick(entryEligibleTick({ mint: m, observedAtMs: at }));
        runner.onMarketTick(entryEligibleTick({ mint: m, observedAtMs: at + 2_000, priceSol: 0.25 }));
      }
      expect(ledger.getOpenPositions('V1')).toHaveLength(1); // MINT_A still open
      expect(ledger.getOrInitDailyRiskState('V1', '1970-01-01', 10).circuitBreakerTriggered).toBe(true);
      db.close();

      // --- process 2 (restart): brand-new objects over the same file ---
      db = openLedger(dbPath);
      ledger = new ShadowLedger(db);
      health = new HealthCounters((n, by) => ledger.incrementCounter(n, by), ledger.getCounters());
      runner = new ShadowRunner({ ledger, strategies: [V1, V2], assumptions: DEFAULT_ASSUMPTIONS, health });

      expect(ledger.getOpenPositions('V1')).toHaveLength(1);
      expect(ledger.getOrInitDailyRiskState('V1', '1970-01-01', 10).circuitBreakerTriggered).toBe(true); // limit NOT reset by restart
      const before = ledger.getAllClosedTrades('V1').length;

      // a fresh entry is still blocked by the persisted circuit breaker
      const blocked = runner.onMarketTick(entryEligibleTick({ mint: 'M7', observedAtMs: 100_000 }));
      expect(blocked.find((o) => o.strategyVersion === 'V1')!.kind).toBe('missed_signal');

      // the open position exits normally after restart, exactly once
      const exit = runner.onMarketTick(entryEligibleTick({ observedAtMs: 102_000, priceSol: 1.03 }));
      expect(exit.find((o) => o.strategyVersion === 'V1')!.kind).toBe('exited');
      expect(ledger.getAllClosedTrades('V1')).toHaveLength(before + 1);
      // replaying the same tick after the restart is a no-op (position already closed, no second exit/entry)
      runner.onMarketTick(entryEligibleTick({ observedAtMs: 102_000, priceSol: 1.03 }));
      expect(ledger.getAllClosedTrades('V1')).toHaveLength(before + 1);

      // V2 (tighter filters) never saw V1's positions or risk state
      expect(ledger.getOpenPositions('V2')).toHaveLength(0);
      expect(ledger.getOrInitDailyRiskState('V2', '1970-01-01', 10).circuitBreakerTriggered).toBe(false);

      // counters persisted across the restart and kept accumulating
      expect(ledger.getCounters().shadow_ticks_received).toBeGreaterThan(before);

      // production tables untouched throughout
      for (const t of ['trades', 'token_evaluations', 'daily_risk_state']) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
      }
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort on Windows
      }
    }
  });
});

describe('security regression: shadow + production read path can never sign, send or broadcast', () => {
  const shadowFiles = walk(join(ENGINE_SRC, 'shadow'));
  const loop = join(ENGINE_SRC, 'orchestrator', 'loop.ts');

  it('no shadow file imports execution/signer or any signer class', () => {
    expect(shadowFiles.length).toBeGreaterThan(5);
    for (const f of shadowFiles) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      expect(code, f).not.toMatch(/execution\/signer/);
      expect(code, f).not.toMatch(/KeypairSigner|WindowsDpapi|DryRunGuardedSigner|NullSigner|SecretProvider/);
    }
  });

  it('no shadow file, loop.ts, or quote client can send/sign/broadcast a transaction', () => {
    const files = [...shadowFiles, loop, join(ENGINE_SRC, 'execution', 'marketPriceSource.ts'), join(ENGINE_SRC, 'execution', 'jupiterQuoteClient.ts')];
    for (const f of files) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      expect(code, f).not.toMatch(/sendTransaction|sendRawTransaction|signTransaction|sendAndConfirm|\/swap['"`]|swap-instructions|simulateTransaction/);
    }
  });

  it('the quote client only issues read-only GET requests', () => {
    const code = codeOnly(readFileSync(join(ENGINE_SRC, 'execution', 'jupiterQuoteClient.ts'), 'utf8'));
    expect(code).toMatch(/method: 'GET'/);
    expect(code).not.toMatch(/method: 'POST'|method: 'PUT'/);
  });

  it('there is no realtime AI/LLM call anywhere in the TypeScript engine', () => {
    for (const f of walk(ENGINE_SRC)) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      expect(code, f).not.toMatch(/openai|anthropic|api\.openai|generativelanguage|\bLLM\b|learning\/ai|chat\/completions/i);
    }
  });
});
