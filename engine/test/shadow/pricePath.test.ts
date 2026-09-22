import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { simulateSellFill } from '../../src/execution/fillSimulation.js';
import { openLedger } from '../../src/ledger/db.js';
import {
  computePathMetrics,
  DEFAULT_PATH_OFFSETS_MS,
  NativePathObserver,
  PricePathRecorder,
  PricePathStore,
  type PathObservationSource,
  type PathObserver,
  type PathPoint,
  type PricePathScheduler,
  type TrackedEntry,
} from '../../src/shadow/pricePath.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import { BASE_TS, CurveSim, Feed, at, mintId } from '../volume/helpers.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleTick } from './fixtures.js';

const cfg = getDefaultConfig();
const T0 = 1_000_000;

/** Deterministic clock + timers: nothing here ever waits in real time. */
class FakeTime implements PricePathScheduler {
  now = T0;
  private seq = 0;
  private timers = new Map<number, { due: number; fn: () => void }>();
  cleared = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { due: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (this.timers.delete(handle as number)) this.cleared += 1;
  }
  get pending(): number {
    return this.timers.size;
  }
  advanceTo(target: number): void {
    for (;;) {
      const next = [...this.timers.entries()].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.now = Math.max(this.now, next[1].due);
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.now = target;
  }
}

const ENTRY: TrackedEntry = {
  tradeId: 'shadow_t1',
  tradeKind: 'shadow',
  strategyVersion: 'V1',
  mint: 'MINT_A',
  entryTimeMs: T0,
  entryPriceSol: 1,
  entrySizeSol: 0.3,
  entryFilledAmountSol: 0.29,
  entryFeesSol: 0.004,
  entryTokenAmountRaw: '10000000000',
  entryLiquiditySol: 40,
  entryVolume1mSol: 12,
  entryFeeModel: 'pumpfun_curve',
  entryFeeBps: 125,
};

function obs(over: Partial<PathObservationSource> = {}): PathObservationSource {
  return { priceSol: 1.01, liquiditySol: 40, stateEventSec: Math.floor(T0 / 1000), venueFeeBps: 125, sellPriceImpactPct: 0.5, unavailableReason: null, sellImpactUnavailableReason: null, ...over };
}

function harness(observe: (mint: string, tokens: string | null, nowMs: number) => PathObservationSource) {
  const db = openLedger(':memory:');
  const time = new FakeTime();
  const errors: string[] = [];
  const observer: PathObserver = { observe };
  const recorder = new PricePathRecorder({
    store: new PricePathStore(db),
    observer,
    edge: cfg.edge,
    latencySlippageBufferPct: cfg.execution.latencySlippageBufferPct,
    now: () => time.now,
    scheduler: time,
    onError: (m) => errors.push(m),
  });
  const points = () => db.prepare('SELECT * FROM trade_price_paths WHERE trade_id = ? ORDER BY point_kind DESC, offset_ms').all('shadow_t1') as Array<Record<string, unknown>>;
  const metrics = () => db.prepare('SELECT * FROM trade_path_metrics WHERE trade_id = ?').get('shadow_t1') as Record<string, unknown>;
  return { db, time, recorder, errors, points, metrics };
}

const p = (over: Partial<PathPoint>): PathPoint => ({
  kind: 'scheduled', offsetMs: 1000, status: 'observed', missingReason: null, scheduledAtMs: null, observedAtMs: null, observationLagMs: null, priceSol: 1, liquiditySol: null,
  stateEventSec: null, stateAgeMs: null, sellPriceImpactPct: null, venueFeeBps: null, grossMovePct: 0, netPnlSol: null, netPnlPct: null, netUnavailableReason: null, ...over,
});

describe('computePathMetrics (pure)', () => {
  it('MFE / MAE / max gross move and their times come from observed points only', () => {
    const m = computePathMetrics(
      [p({ offsetMs: 1000, grossMovePct: 1.5 }), p({ offsetMs: 2000, grossMovePct: 4 }), p({ offsetMs: 3000, grossMovePct: -2 }), p({ offsetMs: 5000, grossMovePct: 0.5 })],
      7,
    );
    expect(m).toMatchObject({ mfePct: 4, timeToMfeMs: 2000, maePct: -2, timeToMaeMs: 3000, maxGrossMovePct: 4, timeToMaxGrossMs: 2000, observationsObserved: 4, observationsExpected: 7, pathComplete30s: false });
  });

  it('a path that never went above the entry has MFE 0 and NO time-to-MFE (never a favorable move that did not happen)', () => {
    const m = computePathMetrics([p({ offsetMs: 1000, grossMovePct: -0.5 }), p({ offsetMs: 2000, grossMovePct: -1.2 })], 7);
    expect(m.mfePct).toBe(0);
    expect(m.timeToMfeMs).toBeNull();
    expect(m.maxGrossMovePct).toBe(-0.5); // the honest (negative) best observation
    expect(m.maePct).toBe(-1.2);
  });

  it('missing / after-exit / interrupted points contribute nothing; with nothing observed every metric is null', () => {
    const m = computePathMetrics(
      [p({ status: 'missing', priceSol: null, grossMovePct: null }), p({ offsetMs: 2000, status: 'after_exit', priceSol: null, grossMovePct: null }), p({ offsetMs: 3000, status: 'interrupted', priceSol: null, grossMovePct: null })],
      7,
    );
    expect(m).toMatchObject({ mfePct: null, maePct: null, maxGrossMovePct: null, maxNetPnlPct: null, everNetPositive: null, observationsObserved: 0, pathComplete30s: false });
  });

  it('net-positive is true only when a calculable observation is positive: false if all calculable are <= 0, null if none is calculable', () => {
    expect(computePathMetrics([p({ netPnlPct: -1.1 }), p({ offsetMs: 2000, netPnlPct: -0.2 })], 7)).toMatchObject({ everNetPositive: false, maxNetPnlPct: -0.2, timeToMaxNetMs: 2000, netObservations: 2 });
    expect(computePathMetrics([p({ netPnlPct: -1.1 }), p({ offsetMs: 2000, netPnlPct: 0.4 })], 7)).toMatchObject({ everNetPositive: true, maxNetPnlPct: 0.4 });
    expect(computePathMetrics([p({ netPnlPct: null, netUnavailableReason: 'sell_impact_unavailable' })], 7)).toMatchObject({ everNetPositive: null, maxNetPnlPct: null, netObservations: 0 });
  });
});

describe('PricePathRecorder: schedule and storage', () => {
  it('observes at +1, 2, 3, 5, 10, 15 and 30 s from the entry, stores entry snapshot + every point, then completes', () => {
    expect(DEFAULT_PATH_OFFSETS_MS).toEqual([1000, 2000, 3000, 5000, 10_000, 15_000, 30_000]);
    const seen: number[] = [];
    const h = harness((_m, _t, now) => (seen.push(now - T0), obs({ priceSol: 1 + (now - T0) / 100_000 })));
    h.recorder.startTrade(ENTRY);
    expect(h.metrics()).toMatchObject({ path_status: 'open', entry_price_sol: 1, entry_size_sol: 0.3, entry_filled_amount_sol: 0.29, entry_fee_sol: 0.004 });
    expect(h.metrics()).toMatchObject({ entry_token_amount_raw: '10000000000', entry_liquidity_sol: 40, entry_volume_1m_sol: 12, entry_fee_bps: 125, entry_fee_model: 'pumpfun_curve' });
    h.time.advanceTo(T0 + 40_000);
    expect(seen).toEqual([1000, 2000, 3000, 5000, 10_000, 15_000, 30_000]);
    const rows = h.points();
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.status === 'observed' && r.point_kind === 'scheduled')).toBe(true);
    expect(h.metrics()).toMatchObject({ path_status: 'complete', path_complete_30s: 1, observations_observed: 7, observations_expected: 7 });
    expect(h.time.pending).toBe(0);
    expect(h.errors).toEqual([]);
  });

  it('a missing observation is stored as missing with its reason and NULL values: nothing is interpolated or carried forward', () => {
    const h = harness((_m, _t, now) => (now - T0 === 5000 ? obs({ priceSol: null, unavailableReason: 'native_stale:no_recent_trades' }) : obs({ priceSol: 1.02 })));
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 40_000);
    const missing = h.points().find((r) => r.offset_ms === 5000)!;
    expect(missing).toMatchObject({ status: 'missing', missing_reason: 'native_stale:no_recent_trades', price_sol: null, gross_move_pct: null, net_pnl_pct: null });
    expect(h.metrics()).toMatchObject({ observations_observed: 6, path_complete_30s: 0, path_status: 'complete' });
  });

  it('an observer that throws yields a missing point (observer_error), never a crash and never a value', () => {
    const h = harness(() => {
      throw new Error('boom');
    });
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 31_000);
    expect(h.points().every((r) => r.status === 'missing' && r.missing_reason === 'observer_error' && r.price_sol === null)).toBe(true);
    expect(h.metrics()).toMatchObject({ mfe_pct: null, mae_pct: null, observations_observed: 0 });
    expect(h.errors.length).toBeGreaterThan(0);
  });

  it('exact net PnL per observation uses the simulator sell leg with the ACTUAL held tokens, the observed sell impact and the observed fee', () => {
    const calls: Array<string | null> = [];
    const h = harness((_m, tokens) => (calls.push(tokens), obs({ priceSol: 1.05, sellPriceImpactPct: 0.6, venueFeeBps: 125 })));
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 1000);
    expect(calls).toEqual(['10000000000']);
    const row = h.points()[0]!;
    const expected = simulateSellFill(0.29 * 1.05, 0.6, cfg.execution.latencySlippageBufferPct, cfg.edge, 125).filledAmountSol - 0.3;
    expect(row.net_pnl_sol as number).toBeCloseTo(expected, 12);
    expect(row.net_pnl_pct as number).toBeCloseTo((expected / 0.3) * 100, 9);
    expect(row.gross_move_pct as number).toBeCloseTo(5, 9);
  });

  it('when the sell impact is unavailable the gross move is still recorded but the net PnL is null WITH a reason (never a guessed net)', () => {
    const h = harness(() => obs({ priceSol: 1.08, sellPriceImpactPct: null, sellImpactUnavailableReason: 'native_unavailable:stale' }));
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 1000);
    expect(h.points()[0]).toMatchObject({ status: 'observed', net_pnl_pct: null, net_unavailable_reason: 'native_unavailable:stale' });
    expect(h.points()[0]!.gross_move_pct as number).toBeCloseTo(8, 9);
    expect(h.metrics()).toMatchObject({ ever_net_positive: null, max_net_pnl_pct: null, net_observations: 0 });
    expect(h.metrics().max_gross_move_pct as number).toBeCloseTo(8, 9);
  });

  it('falls back to the ENTRY fee model when an observation carries no venue fee, so both legs stay consistent', () => {
    const h = harness(() => obs({ priceSol: 1.05, venueFeeBps: null }));
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 1000);
    const expected = simulateSellFill(0.29 * 1.05, 0.5, cfg.execution.latencySlippageBufferPct, cfg.edge, 125).filledAmountSol - 0.3;
    expect(h.points()[0]!.net_pnl_sol as number).toBeCloseTo(expected, 12);
    expect(h.points()[0]!.venue_fee_bps).toBe(125);
  });
});

describe('PricePathRecorder: exit, early exit and shutdown', () => {
  it('an exit before 30 s keeps what was observed, marks later offsets after_exit (not observed), adds the exit point and finalizes', () => {
    const h = harness(() => obs({ priceSol: 1.03 }));
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 2500);
    h.recorder.recordExit('shadow_t1', { exitTimeMs: T0 + 2500, exitPriceSol: 1.03, exitFeesSol: 0.0041, exitReason: 'quick_tp', netPnlSol: -0.0011, netPnlPct: -0.37 });
    const rows = h.points();
    expect(rows.filter((r) => r.point_kind === 'scheduled' && r.status === 'observed').map((r) => r.offset_ms)).toEqual([1000, 2000]);
    expect(rows.filter((r) => r.status === 'after_exit').map((r) => r.offset_ms)).toEqual([3000, 5000, 10_000, 15_000, 30_000]);
    expect(rows.find((r) => r.point_kind === 'exit')).toMatchObject({ offset_ms: 2500, status: 'observed', price_sol: 1.03, net_pnl_pct: -0.37 });
    expect(rows.filter((r) => r.status === 'after_exit').every((r) => r.price_sol === null && r.gross_move_pct === null)).toBe(true);
    expect(h.metrics()).toMatchObject({ path_status: 'exited_early', path_complete_30s: 0, exit_time_ms: T0 + 2500, exit_price_sol: 1.03, exit_fee_sol: 0.0041, exit_reason: 'quick_tp', holding_time_ms: 2500, net_pnl_pct: -0.37 });
    expect(h.time.pending).toBe(0); // the unfired timers were cancelled
    expect(h.recorder.activeCount).toBe(0);
    h.time.advanceTo(T0 + 40_000);
    expect(h.points()).toHaveLength(8); // nothing more is ever written after the exit
  });

  it('an exit after the full 30 s path is exited_after_path and the exit point joins the metrics', () => {
    const h = harness((_m, _t, now) => obs({ priceSol: now - T0 === 30_000 ? 1.07 : 1.0 }));
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 30_000);
    expect(h.metrics().path_status).toBe('complete');
    h.recorder.recordExit('shadow_t1', { exitTimeMs: T0 + 31_000, exitPriceSol: 0.99, exitFeesSol: 0.004, exitReason: 'max_hold_timeout', netPnlSol: -0.01, netPnlPct: -3.3 });
    expect(h.metrics()).toMatchObject({ path_status: 'exited_after_path', path_complete_30s: 1, holding_time_ms: 31_000 });
    expect(h.metrics().mfe_pct as number).toBeCloseTo(7, 9);
    expect(h.metrics().time_to_mfe_ms).toBe(30_000);
    expect(h.metrics().mae_pct as number).toBeCloseTo(-1, 9); // the exit price is a real observation and counts
  });

  it('shutdown cancels every pending timer, marks unobserved offsets interrupted and never observes afterwards', () => {
    let observed = 0;
    const h = harness(() => (observed += 1, obs()));
    h.recorder.startTrade(ENTRY);
    h.time.advanceTo(T0 + 3500);
    expect(observed).toBe(3);
    h.recorder.stop();
    expect(h.time.pending).toBe(0);
    expect(h.points().filter((r) => r.status === 'interrupted').map((r) => r.offset_ms)).toEqual([5000, 10_000, 15_000, 30_000]);
    expect(h.metrics()).toMatchObject({ path_status: 'interrupted', observations_observed: 3 });
    h.time.advanceTo(T0 + 60_000);
    expect(observed).toBe(3);
  });

  it('a second startTrade for the same id is ignored (no duplicate schedule), and recording an unknown exit is a no-op', () => {
    const h = harness(() => obs());
    h.recorder.startTrade(ENTRY);
    h.recorder.startTrade(ENTRY);
    expect(h.time.pending).toBe(7);
    h.recorder.recordExit('unknown', { exitTimeMs: T0, exitPriceSol: 1, exitFeesSol: 0, exitReason: 'x', netPnlSol: 0, netPnlPct: 0 });
    expect(h.recorder.activeCount).toBe(1);
  });
});

describe('NativePathObserver reads only the in-memory native cache', () => {
  it('a valid curve token yields price, liquidity, the curve fee (95 + 30 bps) and the exact sell impact of the HELD tokens', () => {
    const f = new Feed();
    f.pace(BASE_TS, BASE_TS + 200);
    const sim = new CurveSim();
    f.create(mintId(11), BASE_TS + 100);
    f.curveTrade(mintId(11), sim.buy(8_000_000_000n), BASE_TS + 150);
    // A second, small trade close to the query time keeps the curve within the default 5 s per-token freshness
    // bound (see the P1 fix in pumpfunVolumeEngine.ts:resolveCurve).
    f.curveTrade(mintId(11), sim.buy(100_000_000n), BASE_TS + 200);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const snap = f.engine.getNativeMarketSnapshot(mintId(11), 0.3, at(BASE_TS + 201));
    const o = new NativePathObserver(f.engine).observe(mintId(11), snap.buyTokenAmountRaw, at(BASE_TS + 201));
    expect(o.unavailableReason).toBeNull();
    expect(o.priceSol).toBe(snap.priceSol);
    expect(o.venueFeeBps).toBe(125);
    expect(o.sellPriceImpactPct).toBeCloseTo(snap.sellPriceImpactPct as number, 12);
    expect(o.stateEventSec).not.toBeNull();
  });

  it('an unobserved token is unavailable with a reason, and a missing held amount leaves the net unavailable but keeps the price', () => {
    const f = new Feed();
    f.pace(BASE_TS, BASE_TS + 200);
    const obsv = new NativePathObserver(f.engine);
    const none = obsv.observe(mintId(99), '1000', at(BASE_TS + 201));
    expect(none.priceSol).toBeNull();
    expect(none.unavailableReason).toMatch(/^native_/);

    const sim = new CurveSim();
    f.create(mintId(12), BASE_TS + 100);
    f.curveTrade(mintId(12), sim.buy(8_000_000_000n), BASE_TS + 150);
    // A second, small trade close to the query time keeps the curve within the default 5 s per-token freshness
    // bound (see the P1 fix in pumpfunVolumeEngine.ts:resolveCurve).
    f.curveTrade(mintId(12), sim.buy(100_000_000n), BASE_TS + 200);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const noAmount = obsv.observe(mintId(12), null, at(BASE_TS + 201));
    expect(noAmount.priceSol).not.toBeNull();
    expect(noAmount.sellPriceImpactPct).toBeNull();
    expect(noAmount.sellImpactUnavailableReason).toBe('entry_token_amount_missing');
    expect(obsv.observe(mintId(12), 'not-a-number', at(BASE_TS + 201)).sellImpactUnavailableReason).toBe('entry_token_amount_invalid');
  });
});

describe('instrumentation cannot influence trading decisions', () => {
  function run(lifecycle?: ConstructorParameters<typeof ShadowRunner>[0]['lifecycle']) {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: 'V1', config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS, lifecycle });
    const outcomes = [
      runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }))[0]!.kind,
      runner.onMarketTick(entryEligibleTick({ observedAtMs: 42_000, priceSol: 1.03 }))[0]!.kind,
    ];
    const trades = ledger.getAllClosedTrades('V1').map((t) => ({ pnl: t.pnlSol, exit: t.exitReason, fees: t.entryFeesSol, filled: t.entryFilledAmountSol }));
    return { outcomes, trades };
  }

  it('a throwing listener changes nothing: same outcomes, same trades as a runner with no listener', () => {
    const baseline = run();
    expect(baseline.outcomes).toEqual(['entered', 'exited']);
    const throwing = run({
      onEntry: () => {
        throw new Error('listener failure');
      },
      onExit: () => {
        throw new Error('listener failure');
      },
    });
    expect(throwing).toEqual(baseline);
  });

  it('a working recorder attached to the runner sees the entry and the exit, and the trades are identical to the un-instrumented run', () => {
    const baseline = run();
    const entries: string[] = [];
    const exits: string[] = [];
    const instrumented = run({ onEntry: (e) => entries.push(`${e.tradeKind}:${e.mint}:${e.entryFeeModel}`), onExit: (_id, x) => exits.push(x.exitReason) });
    expect(instrumented).toEqual(baseline);
    expect(entries).toEqual(['shadow:MINT_A:configured_flat']);
    expect(exits).toEqual(['quick_tp']);
  });

  it('end to end: shadow entry -> recorder schedules -> observations -> shadow exit finalizes the path', () => {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const time = new FakeTime();
    const recorder = new PricePathRecorder({
      store: new PricePathStore(db),
      observer: { observe: () => obs({ priceSol: 1.02 }) },
      edge: cfg.edge,
      latencySlippageBufferPct: cfg.execution.latencySlippageBufferPct,
      now: () => time.now,
      scheduler: time,
    });
    const runner = new ShadowRunner({
      ledger,
      strategies: [{ strategyVersion: 'V1', config: DEFAULT_CONFIG }],
      assumptions: DEFAULT_ASSUMPTIONS,
      lifecycle: { onEntry: (e) => recorder.startTrade({ ...e, entryTimeMs: time.now }), onExit: (id, x) => recorder.recordExit(id, { ...x, exitTimeMs: time.now + 2000 }) },
    });
    expect(runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }))[0]!.kind).toBe('entered');
    time.advanceTo(T0 + 2000);
    expect(runner.onMarketTick(entryEligibleTick({ observedAtMs: 42_000, priceSol: 1.03 }))[0]!.kind).toBe('exited');
    const m = db.prepare('SELECT * FROM trade_path_metrics').get() as Record<string, unknown>;
    expect(m).toMatchObject({ trade_kind: 'shadow', mint: 'MINT_A', exit_reason: 'quick_tp', path_status: 'exited_early', observations_observed: 2 });
    expect(m.mfe_pct as number).toBeGreaterThan(0);
  });
});
