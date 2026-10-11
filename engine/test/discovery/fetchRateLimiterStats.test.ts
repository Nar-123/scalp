import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { DiscoveryLimiterReporter, type LimiterStatsSource } from '../../src/discovery/limiterStatsReporter.js';
import { FetchRateLimiter } from '../../src/discovery/fetchRateLimiter.js';
import { PumpFunLogSubscriber } from '../../src/discovery/pumpFunLogSubscriber.js';
import { RaydiumLogSubscriber } from '../../src/discovery/raydiumLogSubscriber.js';

/**
 * Stage 1 (observability only). The limiter's DECISIONS must be exactly the baseline's (commit 67f85c2); the new counters
 * must be exact; and nothing about the limiter may queue, retry or schedule anything.
 */

/** Verbatim copy of the baseline `FetchRateLimiter` at commit 67f85c2 -- the reference for the equivalence tests. */
class BaselineFetchRateLimiter {
  private windowStartMs: number;
  private countThisWindow = 0;
  constructor(
    private readonly maxPerWindow: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(maxPerWindow > 0)) throw new Error('FetchRateLimiter maxPerWindow must be positive');
    this.windowStartMs = this.now();
  }
  allow(): boolean {
    const now = this.now();
    if (now - this.windowStartMs >= 1000) {
      this.windowStartMs = now;
      this.countThisWindow = 0;
    }
    if (this.countThisWindow >= this.maxPerWindow) return false;
    this.countThisWindow += 1;
    return true;
  }
}

/** A clock whose value is set by the test and which counts how many times it was read. */
function clock(start = 0) {
  const c = { t: start, reads: 0, now: () => (c.reads++, c.t) };
  return c;
}

/** Deterministic pseudo-random sequence (LCG) so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

describe('FetchRateLimiter (Stage 1): decisions are identical to the baseline', () => {
  it('produces the same allow/reject sequence as the baseline for bursty, windowed and long-gap arrivals (N = 1, 2, 3, 5, 1000; several seeds)', () => {
    for (const n of [1, 2, 3, 5, 1000]) {
      for (const seed of [1, 7, 42, 2026, 99991]) {
        const r = rng(seed);
        const cOld = clock(1_000_000);
        const cNew = clock(1_000_000);
        const oldL = new BaselineFetchRateLimiter(n, cOld.now);
        const newL = new FetchRateLimiter(n, cNew.now, { label: 'x' });
        let t = 1_000_000;
        let mismatches = 0;
        for (let i = 0; i < 4_000; i += 1) {
          const u = r();
          // 40% same instant (burst), 35% sub-second, 15% around one window, 8% seconds, 2% minutes
          t += u < 0.4 ? 0 : u < 0.75 ? Math.floor(r() * 999) : u < 0.9 ? 990 + Math.floor(r() * 20) : u < 0.98 ? Math.floor(r() * 20_000) : Math.floor(r() * 400_000);
          cOld.t = t;
          cNew.t = t;
          if (newL.allow() !== oldL.allow()) mismatches += 1;
          if (i % 97 === 0) newL.stats(); // reading the counters must not change anything
        }
        expect(mismatches, `n=${n} seed=${seed}`).toBe(0);
        // exactly one clock read per allow() (plus the constructor's), so the injected-clock contract is unchanged
        expect(cNew.reads).toBeGreaterThanOrEqual(cOld.reads);
      }
    }
  });

  it('reads the injected clock exactly once per allow() -- no extra clock access on the decision path', () => {
    const c = clock(5);
    const l = new FetchRateLimiter(1, c.now);
    const afterCtor = c.reads;
    for (let i = 0; i < 50; i += 1) l.allow();
    expect(c.reads - afterCtor).toBe(50);
  });

  it('keeps the original window semantics at the boundary: 999 ms is still the same window, 1000 ms opens a new one', () => {
    const c = clock(0);
    const l = new FetchRateLimiter(1, c.now);
    expect(l.allow()).toBe(true);
    c.t = 999;
    expect(l.allow()).toBe(false);
    c.t = 1000;
    expect(l.allow()).toBe(true);
    c.t = 1999;
    expect(l.allow()).toBe(false);
    c.t = 2000;
    expect(l.allow()).toBe(true);
  });

  it('a clock that steps backwards cannot crash or reopen a closed interval, and decisions still match the baseline', () => {
    const c1 = clock(100_000);
    const c2 = clock(100_000);
    const b = new BaselineFetchRateLimiter(1, c1.now);
    const l = new FetchRateLimiter(1, c2.now);
    for (const t of [100_000, 100_500, 99_000, 101_200, 101_300, 50_000, 160_000, 159_000]) {
      c1.t = t;
      c2.t = t;
      expect(l.allow()).toBe(b.allow());
    }
    const s = l.stats();
    expect(s.offeredTotal).toBe(8);
    expect(s.currentInterval.index).toBeGreaterThanOrEqual(1);
  });

  it('the default maxPerWindow stays 1 on both discovery subscribers (no configuration was added)', () => {
    const conn = { onLogs: vi.fn(), removeOnLogsListener: vi.fn(), getParsedTransaction: vi.fn() } as unknown as Connection;
    const pump = new PumpFunLogSubscriber(conn, { programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' });
    const ray = new RaydiumLogSubscriber(conn, { programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' });
    expect(pump.getFetchLimiterStats().maxPerWindow).toBe(1);
    expect(pump.getFetchLimiterStats().label).toBe('pumpfun');
    expect(ray.getFetchLimiterStats().maxPerWindow).toBe(1);
    expect(ray.getFetchLimiterStats().label).toBe('raydium');
  });

  it('the limiter source contains no timer, queue, retry or async construct (a rejected event can only be counted, never deferred)', () => {
    const src = readFileSync(new URL('../../src/discovery/fetchRateLimiter.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const token of ['setTimeout', 'setInterval', 'setImmediate', 'Promise', 'async ', 'await ', '.then(', 'queueMicrotask', 'retry']) {
      expect(src.includes(token), `forbidden token in limiter: ${token}`).toBe(false);
    }
  });
});

describe('FetchRateLimiter (Stage 1): counters are exact', () => {
  it('counts allowed, rejected and offered exactly, and reports the effective limit', () => {
    const c = clock(0);
    const l = new FetchRateLimiter(2, c.now, { label: 'pumpfun' });
    const decisions: boolean[] = [];
    for (let i = 0; i < 5; i += 1) decisions.push(l.allow()); // same instant: 2 allowed, 3 rejected
    c.t = 1000;
    for (let i = 0; i < 3; i += 1) decisions.push(l.allow()); // new window: 2 allowed, 1 rejected
    const s = l.stats();
    expect(decisions.filter(Boolean).length).toBe(4);
    expect(s.label).toBe('pumpfun');
    expect(s.maxPerWindow).toBe(2);
    expect(s.allowedTotal).toBe(4);
    expect(s.rejectedTotal).toBe(4);
    expect(s.offeredTotal).toBe(8);
    expect(s.rejectedPct).toBe(50);
    expect(s.windowsWithRejection).toBe(2);
    expect(s.peakOfferedInWindow).toBe(5); // the 5-event burst
  });

  it('a burst of 1,000 simultaneous events: 1 allowed, 999 rejected, peak 1,000, one window with rejection', () => {
    const c = clock(10);
    const l = new FetchRateLimiter(1, c.now);
    let allowed = 0;
    for (let i = 0; i < 1000; i += 1) if (l.allow()) allowed += 1;
    const s = l.stats();
    expect(allowed).toBe(1);
    expect(s.allowedTotal).toBe(1);
    expect(s.rejectedTotal).toBe(999);
    expect(s.peakOfferedInWindow).toBe(1000);
    expect(s.windowsWithRejection).toBe(1);
  });

  it('reports zeros and nulls before anything is offered', () => {
    const l = new FetchRateLimiter(1, clock(0).now);
    const s = l.stats();
    expect(s.offeredTotal).toBe(0);
    expect(s.rejectedPct).toBe(0);
    expect(s.completedIntervals).toBe(0);
    expect(s.lastCompletedInterval).toBeNull();
    expect(s.perInterval.allowed.max).toBeNull();
    expect(s.perInterval.rejected.p99).toBeNull();
  });

  it('closes the 60 s interval exactly at the boundary (59,999 ms stays, 60,000 ms rolls over)', () => {
    const c = clock(0);
    const l = new FetchRateLimiter(1, c.now);
    l.allow(); // t=0, interval 0: allowed
    c.t = 500;
    l.allow(); // rejected (same window)
    c.t = 59_999;
    l.allow(); // new window, still interval 0: allowed
    let s = l.stats();
    expect(s.currentInterval).toEqual({ index: 0, allowed: 2, rejected: 1 });
    expect(s.completedIntervals).toBe(0);
    c.t = 60_000;
    // 60,000 ms is only 1 ms after the window opened at 59,999 ms, so the limiter (baseline semantics) rejects it;
    // it is nonetheless attributed to the NEW 60 s interval.
    expect(l.allow()).toBe(false);
    s = l.stats();
    expect(s.completedIntervals).toBe(1);
    expect(s.lastCompletedInterval).toEqual({ allowed: 2, rejected: 1 });
    expect(s.currentInterval).toEqual({ index: 1, allowed: 0, rejected: 1 });
  });

  it('counts idle intervals as zeros in the distribution (they were real minutes with nothing offered)', () => {
    const c = clock(0);
    const l = new FetchRateLimiter(1, c.now);
    l.allow(); // interval 0: 1 allowed
    c.t = 5 * 60_000 + 10; // five minutes later: intervals 1..4 are idle
    l.allow();
    const s = l.stats();
    expect(s.completedIntervals).toBe(5);
    expect(s.lastCompletedInterval).toEqual({ allowed: 0, rejected: 0 });
    expect(s.perInterval.allowed.min).toBe(0);
    expect(s.perInterval.allowed.max).toBe(1);
    expect(s.perInterval.allowed.mean).toBe(0.2);
  });

  it('stats() itself closes elapsed intervals using the clock (an idle limiter keeps accruing zero intervals)', () => {
    const c = clock(0);
    const l = new FetchRateLimiter(1, c.now);
    l.allow();
    c.t = 3 * 60_000 + 1;
    expect(l.stats().completedIntervals).toBe(3);
    c.t = 10 * 60_000 + 1;
    expect(l.stats().completedIntervals).toBe(10);
  });

  it('matches an independent bucketing of the same events (totals, per-interval sums, max, mean, quantiles)', () => {
    const r = rng(2026);
    const c = clock(1_700_000_000_000);
    const origin = c.t;
    const l = new FetchRateLimiter(1, c.now, { ringSize: 360 });
    const perIntervalAllowed = new Map<number, number>();
    const perIntervalRejected = new Map<number, number>();
    let t = origin;
    let lastIndex = 0;
    for (let i = 0; i < 6000; i += 1) {
      t += r() < 0.35 ? 0 : Math.floor(r() * 4000);
      c.t = t;
      const idx = Math.floor((t - origin) / 60_000);
      lastIndex = idx;
      const ok = l.allow();
      const m = ok ? perIntervalAllowed : perIntervalRejected;
      m.set(idx, (m.get(idx) ?? 0) + 1);
    }
    const s = l.stats();
    const completedIdx = Array.from({ length: lastIndex }, (_, k) => k); // intervals 0..lastIndex-1 are closed
    const a = completedIdx.map((k) => perIntervalAllowed.get(k) ?? 0);
    const rej = completedIdx.map((k) => perIntervalRejected.get(k) ?? 0);
    const total = (m: Map<number, number>): number => [...m.values()].reduce((x, y) => x + y, 0);
    expect(s.allowedTotal).toBe(total(perIntervalAllowed));
    expect(s.rejectedTotal).toBe(total(perIntervalRejected));
    expect(s.completedIntervals).toBe(lastIndex);
    expect(s.currentInterval.allowed).toBe(perIntervalAllowed.get(lastIndex) ?? 0);
    expect(s.currentInterval.rejected).toBe(perIntervalRejected.get(lastIndex) ?? 0);
    const q = (arr: number[], p: number): number => [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(p * arr.length))] as number;
    expect(s.perInterval.allowed.max).toBe(Math.max(...a));
    expect(s.perInterval.allowed.min).toBe(Math.min(...a));
    expect(s.perInterval.rejected.max).toBe(Math.max(...rej));
    expect(s.perInterval.allowed.p50).toBe(q(a, 0.5));
    expect(s.perInterval.allowed.p99).toBe(q(a, 0.99));
    expect(s.perInterval.rejected.p90).toBe(q(rej, 0.9));
    expect(s.perInterval.allowed.mean).toBe(Math.round((100 * a.reduce((x, y) => x + y, 0)) / a.length) / 100);
  });

  it('memory stays bounded: the quantile sample never exceeds the ring, while totals and max still cover every interval', () => {
    const c = clock(0);
    const l = new FetchRateLimiter(1, c.now, { ringSize: 3 });
    for (let minute = 0; minute < 10; minute += 1) {
      c.t = minute * 60_000;
      const burst = minute === 2 ? 7 : 1; // the largest interval happens early, outside the final ring
      for (let k = 0; k < burst; k += 1) l.allow();
    }
    c.t = 10 * 60_000;
    const s = l.stats();
    expect(s.quantileSampleIntervals).toBe(3);
    expect(s.completedIntervals).toBe(10);
    expect(s.perInterval.rejected.max).toBe(6); // from interval 2, no longer in the ring
    expect(s.allowedTotal).toBe(10);
    expect(s.rejectedTotal).toBe(6);
  });

  it('a gap of years does not loop over every missed interval (bounded work) and still reports correctly', () => {
    const c = clock(0);
    const l = new FetchRateLimiter(1, c.now, { ringSize: 8 });
    l.allow();
    c.t = 5 * 365 * 24 * 3600 * 1000;
    const started = performance.now();
    l.allow();
    const s = l.stats();
    expect(performance.now() - started).toBeLessThan(200);
    expect(s.completedIntervals).toBe(5 * 365 * 24 * 60);
    expect(s.quantileSampleIntervals).toBe(8);
    expect(s.allowedTotal).toBe(2);
  });
});

/** Minimal fake `Connection` (same shape the existing subscriber tests use). */
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const creationLogs = (): string[] => [`Program ${PUMP_PROGRAM} invoke [1]`, 'Program log: Instruction: CreateV2', `Program ${PUMP_PROGRAM} success`];
const buyLogs = (): string[] => [`Program ${PUMP_PROGRAM} invoke [1]`, 'Program log: Instruction: Buy', `Program ${PUMP_PROGRAM} success`];
type LogsCallback = (logs: { signature: string; err: unknown; logs: string[] }, ctx: { slot: number }) => void;
function fakeConnection() {
  let callback: LogsCallback | null = null;
  const calls: string[] = [];
  const connection = {
    onLogs: (_pk: unknown, cb: LogsCallback) => {
      callback = cb;
      return 1;
    },
    removeOnLogsListener: vi.fn(async () => undefined),
    getParsedTransaction: (signature: string) => {
      calls.push(signature);
      return Promise.resolve(null);
    },
  } as unknown as Connection;
  return { connection, calls, fire: (sig: string, logs: string[]) => callback!({ signature: sig, err: null, logs }, { slot: 1 }) };
}

describe('PumpFunLogSubscriber (Stage 1): rejected events are counted and nothing else changes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a burst: exactly one fetch is started, the rest are counted as rejected, none is queued or retried later', async () => {
    const { connection, calls, fire } = fakeConnection();
    const sub = new PumpFunLogSubscriber(connection, { programId: PUMP_PROGRAM });
    await sub.start(() => undefined);
    for (let i = 0; i < 12; i += 1) fire(`sig${i}`, creationLogs());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['sig0']);
    await vi.advanceTimersByTimeAsync(30_000); // far past the window: nothing is retried
    expect(calls).toEqual(['sig0']);
    const s = sub.getFetchLimiterStats();
    expect(s.allowedTotal).toBe(1);
    expect(s.rejectedTotal).toBe(11);
    expect(s.offeredTotal).toBe(12);
    expect(s.peakOfferedInWindow).toBe(12);
    expect(vi.getTimerCount()).toBe(0); // the counters scheduled nothing
  });

  it('events that are not creation-shaped never reach the limiter, so they are not counted as offered', async () => {
    const { connection, calls, fire } = fakeConnection();
    const sub = new PumpFunLogSubscriber(connection, { programId: PUMP_PROGRAM });
    await sub.start(() => undefined);
    for (let i = 0; i < 20; i += 1) fire(`buy${i}`, buyLogs());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    expect(sub.getFetchLimiterStats().offeredTotal).toBe(0);
  });

  it('one allowed event per second over a minute: 60 allowed, the per-minute interval is exactly 60', async () => {
    const { connection, calls, fire } = fakeConnection();
    const sub = new PumpFunLogSubscriber(connection, { programId: PUMP_PROGRAM });
    await sub.start(() => undefined);
    for (let i = 0; i < 60; i += 1) {
      fire(`a${i}`, creationLogs());
      fire(`b${i}`, creationLogs()); // second event in the same second: rejected
      await vi.advanceTimersByTimeAsync(1000);
    }
    fire('tail', creationLogs()); // opens the next interval so the previous one is closed
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(61);
    const s = sub.getFetchLimiterStats();
    expect(s.completedIntervals).toBeGreaterThanOrEqual(1);
    expect(s.lastCompletedInterval).toEqual({ allowed: 60, rejected: 60 });
  });
});

describe('DiscoveryLimiterReporter (Stage 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const source = (name: string): LimiterStatsSource & { limiter: FetchRateLimiter } => {
    const limiter = new FetchRateLimiter(1, undefined, { label: name });
    return { name, limiter, getFetchLimiterStats: () => limiter.stats() };
  };

  it('logs one line per interval with every source, plus a final line on stop, and leaves no timer behind', () => {
    const a = source('pumpfun');
    const b = source('raydium');
    a.limiter.allow();
    a.limiter.allow();
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const rep = new DiscoveryLimiterReporter([a, b], { info: (obj, msg) => void lines.push({ obj, msg }) }, 60_000);
    rep.start();
    vi.advanceTimersByTime(180_000);
    expect(lines.filter((l) => l.obj.kind === 'periodic')).toHaveLength(3);
    const last = lines.at(-1)!;
    const lim = last.obj.discoveryLimiter as Record<string, { allowedTotal: number; rejectedTotal: number; maxPerWindow: number }>;
    expect(Object.keys(lim).sort()).toEqual(['pumpfun', 'raydium']);
    expect(lim.pumpfun).toMatchObject({ allowedTotal: 1, rejectedTotal: 1, maxPerWindow: 1 });
    rep.stop();
    expect(lines.at(-1)!.obj.kind).toBe('final');
    expect(vi.getTimerCount()).toBe(0);
    rep.stop(); // idempotent
    expect(lines.filter((l) => l.obj.kind === 'final')).toHaveLength(1);
  });

  it('never throws, even when a source or the logger fails', () => {
    const bad: LimiterStatsSource = { name: 'bad', getFetchLimiterStats: () => { throw new Error('boom'); } };
    const rep = new DiscoveryLimiterReporter([bad], { info: () => { throw new Error('log down'); } }, 1000);
    rep.start();
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(() => rep.stop()).not.toThrow();
  });

  it('a non-positive interval starts no timer', () => {
    const rep = new DiscoveryLimiterReporter([source('x')], { info: () => undefined }, 0);
    rep.start();
    expect(vi.getTimerCount()).toBe(0);
  });
});
