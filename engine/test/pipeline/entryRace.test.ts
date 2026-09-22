import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { AggregatorClient, TokenDiscoverySource } from '../../src/discovery/types.js';
import { DryRunExecutor } from '../../src/execution/dryRunExecutor.js';
import type { ExecutionEngine } from '../../src/execution/types.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { NativeFirstAggregator, NativeFirstPriceSource } from '../../src/orchestrator/nativeFirst.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';
import { PumpfunVolumeService } from '../../src/volume/pumpfunVolumeService.js';
import { CurveSim, LAG_MS, createPayload, mintId, notification, patchTrade, realTradePayload } from '../volume/helpers.js';

// DUPLICATE-ENTRY RACE regression (production loop, real timers). Only the safety gate is replaced, because its latency
// is the variable under test: with the quote limiter at 0.5 rps the real gate takes longer than the 2 s evaluation tick.
// Everything else is the real production wiring: native market data, filters, edge, risk, dry-run executor, position
// monitor and ledger. The market stream is a SYNTHETIC bonding curve.

interface GateResult {
  passed: boolean;
  reasons: string[];
  details: Record<string, unknown>;
  mintAuthorityRenounced: boolean;
  freezeAuthorityRenounced: boolean;
  top10HolderPct: number;
  liquiditySol: number;
  dataAsOfMs: number;
}
type GateImpl = (mint: string, callIndex: number) => Promise<GateResult>;
const gateHolder: { impl: GateImpl } = { impl: async () => passResult() };
const passResult = (): GateResult => ({ passed: true, reasons: [], details: {}, mintAuthorityRenounced: true, freezeAuthorityRenounced: true, top10HolderPct: 12, liquiditySol: 30, dataAsOfMs: Date.now() });
const failResult = (): GateResult => ({ ...passResult(), passed: false, reasons: ['holder_data_unavailable'] });

vi.mock('../../src/safety/safetyGate.js', () => ({ runSafetyGate: (mint: string) => gateHolder.impl(mint, 0) }));

const noop = () => undefined;
const logged: string[] = [];
const logger = { info: noop, warn: (...a: unknown[]) => logged.push('W ' + JSON.stringify(a)), error: (...a: unknown[]) => logged.push('E ' + JSON.stringify(a)), debug: noop, fatal: noop, trace: noop, child: () => logger } as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gate with a per-mint call counter and concurrency accounting. */
function instrumentedGate(body: (mint: string, callIndex: number) => Promise<GateResult>) {
  const stats = { calls: {} as Record<string, number>, activeByMint: {} as Record<string, number>, maxActiveByMint: 0, active: 0, maxActive: 0 };
  gateHolder.impl = async (mint) => {
    const idx = (stats.calls[mint] = (stats.calls[mint] ?? 0) + 1);
    stats.active += 1;
    stats.activeByMint[mint] = (stats.activeByMint[mint] ?? 0) + 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    stats.maxActiveByMint = Math.max(stats.maxActiveByMint, stats.activeByMint[mint] as number);
    try {
      return await body(mint, idx);
    } finally {
      stats.active -= 1;
      (stats.activeByMint[mint] as number) -= 1;
    }
  };
  return stats;
}

async function harness(mintNs: number[], opts: { cfgOver?: Parameters<typeof getDefaultConfig>[0]; evaluationTimeoutMs?: number; buyDelayMs?: number } = {}) {
  // Phase 5.6H: the edge gate prices a complete round trip at the curve's real 125 bps fee per leg, so the strategy's expected move (quick take-profit)
  // must exceed the break-even move for an entry to be favorable. The exit levels are raised for THIS test only (production values are untouched).
  const cfg = getDefaultConfig({ shadow: { enabled: false }, exits: { quickTpMinPct: 6, quickTpMaxPct: 8, momentumTpMinPct: 9, momentumTpMaxPct: 12 }, ...(opts.cfgOver ?? {}) });
  const db = openLedger(':memory:');
  const ledger = new TradeLedger(db);
  const service = new PumpfunVolumeService({ db, watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0, engine: { silenceMs: 3_600_000 } });
  const end = Math.floor(Date.now() / 1000) - 2;
  service.start((end - 300) * 1000);
  const send = (payload: Buffer): void => service.onLogNotification(notification([payload], { receivedAtMs: Date.now() - LAG_MS }));
  for (let t = end - 200; t <= end - 60; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  const sims = new Map<string, CurveSim>();
  const mints: string[] = [];
  for (const n of mintNs) {
    const mint = mintId(n);
    mints.push(mint);
    const sim = new CurveSim();
    sims.set(mint, sim);
    const step = (s: ReturnType<CurveSim['buy']> | ReturnType<CurveSim['sell']>, ts: number): void =>
      send(patchTrade(realTradePayload(s.isBuy ? 'sol_buy' : 'sol_sell'), { mint, solLamports: s.solLamports, tokenAmount: s.tokenAmount, isBuy: s.isBuy, timestampSec: ts, curve: s.curve }));
    send(createPayload(mint, end - 24));
    step(sim.buy(9_000_000_000n), end - 22);
    step(sim.buy(7_000_000_000n), end - 18);
    step(sim.buy(6_000_000_000n), end - 14);
    step(sim.sell(20_000_000_000_000n), end - 10);
  }
  for (let t = end - 59; t <= end; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  const fresh = () => Math.floor(Date.now() / 1000) - 1;

  const baseAgg: AggregatorClient = { getLiquidityAndVolume: async () => null, getHolderConcentration: async () => null, getPrice: async () => null };
  const basePrice: PriceSource = { getPrice: async () => null, getEstimatedPriceImpactPct: async () => null, getBuyExecutionQuote: async () => null, getSellPriceImpactPct: async () => null };
  const aggregator = new NativeFirstAggregator(baseAgg, service);
  const priceSource = new NativeFirstPriceSource(basePrice, service);
  const real = new DryRunExecutor(priceSource, cfg, logger);
  // A slow execution call widens the window between "risk allows" and "position recorded" (the second race window).
  const executor: ExecutionEngine = opts.buyDelayMs ? { ...real, buy: async (r) => (await sleep(opts.buyDelayMs as number), real.buy(r)), sell: (r) => real.sell(r) } : real;
  let emit: (e: DiscoveredTokenEvent) => void = noop;
  const source: TokenDiscoverySource = { name: 'fake', async start(cb) { emit = cb; }, async stop() {} };
  const stop = await startOrchestrator(cfg, {
    discoverySources: [source],
    aggregator,
    connection: {} as never,
    executor,
    priceSource,
    jupiterClient: { getRoundTripQuote: async () => null } as never,
    ledger,
    logger,
    volumeProvider: service,
    nativeMarket: service,
    ...(opts.evaluationTimeoutMs ? { evaluationTimeoutMs: opts.evaluationTimeoutMs } : {}),
  });
  for (const mint of mints) emit({ mint, poolAddress: null, source: 'pumpfun', createdAtSlot: 1, createdAtMs: Date.now() - 60_000, initialLiquiditySol: null });
  await sleep(1200);
  const feeder = setInterval(() => {
    for (const mint of mints) {
      const sim = sims.get(mint) as CurveSim;
      const s = sim.buy(300_000_000n);
      send(patchTrade(realTradePayload('sol_buy'), { mint, solLamports: s.solLamports, tokenAmount: s.tokenAmount, isBuy: s.isBuy, timestampSec: fresh(), curve: s.curve }));
    }
  }, 1000);
  const finish = async () => {
    clearInterval(feeder);
    await stop();
    service.stop();
  };
  const trades = () => db.prepare('SELECT * FROM trades ORDER BY entry_time_ms').all() as Array<Record<string, any>>;
  const waitFor = async (cond: () => boolean, maxMs: number) => {
    for (let i = 0; i < maxMs / 200 && !cond(); i += 1) await sleep(200);
    return cond();
  };
  const perMint = (mint: string) => trades().filter((t) => t.mint === mint);
  const evaluationReasons = () => (db.prepare('SELECT risk_reject_reasons r FROM token_evaluations WHERE risk_reject_reasons IS NOT NULL').all() as Array<{ r: string }>).flatMap((x) => JSON.parse(x.r) as string[]);
  return { mints, db, trades, perMint, waitFor, finish, evaluationReasons };
}

/** Maximum number of trades open at the same instant, from recorded entry/exit times (still-open trades count until now). */
function peakOverlap(rows: Array<Record<string, any>>): number {
  const ev: Array<[number, number]> = [];
  for (const r of rows) {
    ev.push([Number(r.entry_time_ms), 1]);
    ev.push([r.exit_time_ms ? Number(r.exit_time_ms) : Number.MAX_SAFE_INTEGER, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of ev) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  return peak;
}

describe('duplicate-entry race (real production loop, synthetic curve)', () => {
  it('1/6/9. Jupiter-style delay > 2 s tick: the same token overlaps its own ticks but enters exactly once', async () => {
    const gate = instrumentedGate(async () => (await sleep(3500), passResult()));
    const h = await harness([801]);
    const [mint] = h.mints as [string];
    expect(await h.waitFor(() => h.perMint(mint).length >= 1, 40_000), 'the token should have entered').toBe(true);
    await sleep(9000); // several more ticks while the first evaluation and the position are still around
    const rows = h.perMint(mint);
    const closedAll = h.trades().every((t) => t.status === 'closed');
    await h.finish();
    expect(gate.maxActiveByMint, 'ticks of one token must never overlap').toBe(1);
    expect(rows.length, 'exactly one position for the token').toBe(1);
    expect(peakOverlap(rows)).toBe(1);
    expect(rows[0]!.dry_run).toBe(1);
    expect(typeof closedAll).toBe('boolean');
  }, 90_000);

  it('6. entry succeeds: a second, concurrent evaluation cannot create a duplicate position (no double exposure, PnL counted once)', async () => {
    instrumentedGate(async () => (await sleep(3500), passResult()));
    const h = await harness([802]);
    const [mint] = h.mints as [string];
    expect(await h.waitFor(() => h.perMint(mint).some((t) => t.status === 'closed'), 45_000), 'entry then exit').toBe(true);
    await sleep(3000);
    const rows = h.perMint(mint);
    const sumPnl = rows.reduce((a, t) => a + (t.pnl_sol ?? 0), 0);
    const exposure = rows.reduce((a, t) => a + t.entry_size_sol, 0);
    await h.finish();
    expect(rows.length).toBe(1);
    expect(exposure).toBeCloseTo(0.3, 10);
    expect(sumPnl).toBeCloseTo(rows[0]!.pnl_sol, 12); // counted once
    expect(new Set(rows.map((t) => t.entry_time_ms)).size).toBe(rows.length); // no two trades share an entry instant
  }, 90_000);

  it('2/8. different tokens overlap independently: both evaluate concurrently and each enters exactly once', async () => {
    const gate = instrumentedGate(async () => (await sleep(3500), passResult()));
    const h = await harness([803, 804]);
    expect(await h.waitFor(() => h.mints.every((m) => h.perMint(m).length >= 1), 45_000), 'both tokens should enter').toBe(true);
    await sleep(6000);
    const counts = h.mints.map((m) => h.perMint(m).length);
    await h.finish();
    expect(gate.maxActive, 'evaluations of different tokens ran at the same time (no global serialisation)').toBeGreaterThanOrEqual(2);
    expect(gate.maxActiveByMint).toBe(1);
    expect(counts).toEqual([1, 1]);
  }, 90_000);

  it('3. first evaluation fails safety: the guard is released and a later tick evaluates and enters', async () => {
    const gate = instrumentedGate(async (_m, i) => (await sleep(2500), i === 1 ? failResult() : passResult()));
    const h = await harness([805]);
    const [mint] = h.mints as [string];
    expect(await h.waitFor(() => h.perMint(mint).length >= 1, 45_000)).toBe(true);
    await sleep(4000);
    const n = h.perMint(mint).length;
    await h.finish();
    expect(gate.calls[mint]).toBeGreaterThanOrEqual(2);
    expect(n).toBe(1);
  }, 90_000);

  it('4. first evaluation throws: the guard is released, the error is contained, and the next tick evaluates', async () => {
    const gate = instrumentedGate(async (_m, i) => {
      if (i === 1) throw new Error('boom');
      return passResult();
    });
    const h = await harness([806]);
    const [mint] = h.mints as [string];
    expect(await h.waitFor(() => h.perMint(mint).length >= 1, 45_000)).toBe(true);
    await sleep(3000);
    const n = h.perMint(mint).length;
    await h.finish();
    expect(gate.calls[mint]).toBeGreaterThanOrEqual(2);
    expect(n).toBe(1);
    expect(logged.some((l) => l.includes('token evaluation tick failed unexpectedly'))).toBe(true);
  }, 90_000);

  it('5. first evaluation never returns (timeout): the next tick takes over after the limit; when the stuck one finally resumes it cannot enter', async () => {
    let releaseStuck: (() => void) | null = null;
    const gate = instrumentedGate(async (_m, i) => {
      if (i === 1) await new Promise<void>((r) => { releaseStuck = r; }); // hangs until the test releases it
      return passResult();
    });
    const h = await harness([807], { evaluationTimeoutMs: 3000 });
    const [mint] = h.mints as [string];
    expect(await h.waitFor(() => h.perMint(mint).length >= 1, 45_000), 'the takeover evaluation should enter').toBe(true);
    expect(gate.calls[mint]).toBeGreaterThanOrEqual(2);
    (releaseStuck as (() => void) | null)?.(); // the superseded evaluation resumes and reaches the entry commit
    await sleep(5000);
    const rows = h.perMint(mint);
    await h.finish();
    expect(rows.length, 'the resumed stale evaluation must not create a second position').toBe(1);
    expect(logged.some((l) => l.includes('exceeded its time limit'))).toBe(true);
  }, 90_000);

  it('7. re-entry after the position CLOSES stays possible under the existing policy (cooldown 0 here): a later, separate, non-overlapping entry', async () => {
    instrumentedGate(async () => passResult());
    const h = await harness([808], { cfgOver: { reentry: { cooldownMs: 0 } } as never });
    const [mint] = h.mints as [string];
    expect(await h.waitFor(() => h.perMint(mint).length >= 2, 60_000), 'a legitimate re-entry should occur after the first position closed').toBe(true);
    const rows = h.perMint(mint);
    await h.finish();
    const [first, second] = rows as [Record<string, any>, Record<string, any>];
    expect(first.status).toBe('closed');
    expect(Number(second.entry_time_ms)).toBeGreaterThanOrEqual(Number(first.exit_time_ms)); // never concurrent with the first
    expect(second.reentry_index).toBe(1);
    expect(peakOverlap(rows)).toBe(1);
  }, 90_000);

  it('a still-open position blocks a second position on the same token (position_already_open), without touching the re-entry policy', async () => {
    instrumentedGate(async () => passResult());
    // exits disabled by keeping the price flat is not possible here, so use the reason recorded on evaluations made while it is open
    const h = await harness([809]);
    const [mint] = h.mints as [string];
    expect(await h.waitFor(() => h.perMint(mint).length >= 1, 45_000)).toBe(true);
    const isGuardReason = (r: string) => r === 'position_already_open' || r === 'reentry_cooldown_active' || r === 'entry_in_progress';
    expect(await h.waitFor(() => h.evaluationReasons().some(isGuardReason), 15_000), 'a later tick must be refused by the entry commit or the policy').toBe(true);
    const reasons = h.evaluationReasons();
    const rows = h.perMint(mint);
    await h.finish();
    expect(peakOverlap(rows)).toBe(1);
    expect(rows.length).toBe(1);
    expect(reasons.some(isGuardReason)).toBe(true);
  }, 90_000);

  it('cross-token: slow execution widens the risk-to-record window; the concurrent-position limit (3) still holds', async () => {
    instrumentedGate(async () => passResult());
    const h = await harness([811, 812, 813, 814], { buyDelayMs: 700 });
    expect(await h.waitFor(() => h.trades().length >= 3, 45_000)).toBe(true);
    await sleep(4000);
    const rows = h.trades();
    const reasons = h.evaluationReasons();
    await h.finish();
    expect(peakOverlap(rows), 'never more than maxConcurrentPositions (3) open at once').toBeLessThanOrEqual(3);
    expect(reasons).toContain('max_concurrent_positions_reached');
    expect(new Set(rows.filter((t) => t.status).map((t) => `${t.mint}:${t.entry_time_ms}`)).size).toBe(rows.length);
  }, 90_000);
});
