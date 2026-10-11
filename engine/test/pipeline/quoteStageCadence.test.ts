import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvaluationGuard } from '../../src/orchestrator/evaluationGuard.js';
import { EvaluationScheduler } from '../../src/orchestrator/evaluationScheduler.js';
import { ProviderGate, type FetchLike } from '../../src/providers/providerGate.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';
import { QuoteStage, StagedProviderGate, quoteStageOptions } from '../../src/providers/quoteStage.js';
import { makeResponse } from '../providers/helpers.js';

/**
 * P1 regression: the observed production collapse, reproduced with the REAL scheduler and the REAL rate-limited
 * ProviderGate (keyless Jupiter: 0.5 req/s, 4 concurrent, 8 s deadline), under fake time.
 *
 *   300 watched tokens tick every 2 s through a scheduler with 4 global slots. 12 of them are "candidates" whose
 *   evaluation must wait for a quote; the other 288 need no network.
 *
 * Before P1 the 12 candidates keep all 4 slots for ~8 s each, so EVERY token is evaluated only about every 24 s
 * (production: 12-26 s). With the quote stage the candidates give their slot back while they wait and the other 288
 * keep their 2 s cadence. The provider budget (0.5 req/s) is identical in both runs and is asserted.
 */
const TOKENS = 300;
const CANDIDATES = 12;
const TICK_MS = 2000;
const QUOTE_CFG = { maxConcurrent: 4, maxRequestsPerSecond: 0.5, timeoutMs: 4000 };

function quoteGateOptions(fetchImpl: FetchLike) {
  return {
    kind: 'quote' as const,
    endpoints: [{ baseUrl: 'https://quote.example' }],
    timeoutMs: QUOTE_CFG.timeoutMs,
    maxConcurrent: QUOTE_CFG.maxConcurrent,
    maxRequestsPerSecond: QUOTE_CFG.maxRequestsPerSecond,
    maxRetries: 0,
    baseBackoffMs: 300,
    maxBackoffMs: 2500,
    maxTotalMs: 8000,
    circuitFailureThreshold: 5,
    circuitCooldownMs: 15_000,
    unsupportedCooldownMs: 600_000,
    fetchImpl,
  };
}

interface World {
  scheduler: EvaluationScheduler;
  stage: QuoteStage | null;
  gate: ProviderGate;
  starts: Map<string, number[]>;
  fetchCalls: number[];
  concurrentPerMint: { max: number };
  quoteOutcomes: { ok: number; refused: number };
  stop(): void;
}

function buildWorld(staged: boolean): World {
  const fetchCalls: number[] = [];
  const fetchImpl: FetchLike = () => {
    fetchCalls.push(Date.now());
    return new Promise((resolve) => setTimeout(() => resolve(makeResponse({ status: 200, body: '{"ok":true}' })), 20));
  };
  const metrics = new ProviderMetrics();
  const stage = staged ? new QuoteStage(quoteStageOptions(QUOTE_CFG)) : null;
  const gate = stage ? new StagedProviderGate(quoteGateOptions(fetchImpl), metrics, undefined, stage) : new ProviderGate(quoteGateOptions(fetchImpl), metrics);
  const scheduler = new EvaluationScheduler({ maxConcurrent: 4 });
  const guard = new EvaluationGuard(30_000);
  const starts = new Map<string, number[]>();
  const inFlightPerMint = new Map<string, number>();
  const concurrentPerMint = { max: 0 };
  const quoteOutcomes = { ok: 0, refused: 0 };

  async function evaluate(mint: string, candidate: boolean): Promise<void> {
    const acquired = guard.tryAcquire(mint); // exactly what evaluateToken does first
    if (!acquired) return;
    try {
      const n = (inFlightPerMint.get(mint) ?? 0) + 1;
      inFlightPerMint.set(mint, n);
      concurrentPerMint.max = Math.max(concurrentPerMint.max, n);
      (starts.get(mint) ?? starts.set(mint, []).get(mint)!).push(Date.now());
      if (candidate) {
        try {
          await gate.execute({ method: 'GET', path: `/quote?mint=${mint}` });
          quoteOutcomes.ok += 1;
        } catch {
          quoteOutcomes.refused += 1; // fail closed: the caller treats it as "quote unavailable"
        }
      }
    } finally {
      inFlightPerMint.set(mint, (inFlightPerMint.get(mint) ?? 1) - 1);
      guard.release(acquired.lease);
    }
  }

  const timers: Array<ReturnType<typeof setInterval>> = [];
  for (let i = 0; i < TOKENS; i += 1) {
    const mint = `tok${i}`;
    const candidate = i < CANDIDATES;
    setTimeout(() => {
      scheduler.requestTick(mint, () => evaluate(mint, candidate));
      timers.push(setInterval(() => scheduler.requestTick(mint, () => evaluate(mint, candidate)), TICK_MS));
    }, Math.floor((i * TICK_MS) / TOKENS));
  }
  return {
    scheduler,
    stage,
    gate,
    starts,
    fetchCalls,
    concurrentPerMint,
    quoteOutcomes,
    stop() {
      timers.forEach(clearInterval);
    },
  };
}

function gaps(w: World, from: number, to: number, pick: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < TOKENS; i += 1) {
    if (!pick(i)) continue;
    const ts = (w.starts.get(`tok${i}`) ?? []).filter((t) => t >= from && t <= to);
    for (let k = 1; k < ts.length; k += 1) out.push(ts[k]! - ts[k - 1]!);
  }
  return out.sort((a, b) => a - b);
}
const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))]!;

describe('P1: slow quote waiters no longer collapse the evaluation cadence of every other token', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('CONTROL (the old behaviour: waiters keep their slot): every token, quote-free ones included, is stretched to ~24 s', async () => {
    const w = buildWorld(false);
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(90_000);
    w.stop();
    const free = gaps(w, t0 + 30_000, t0 + 90_000, (i) => i >= CANDIDATES);
    expect(free.length).toBeGreaterThan(100);
    expect(q(free, 0.5)).toBeGreaterThanOrEqual(8000); // production saw 12-26 s
    expect(w.scheduler.stats().maxActive).toBeLessThanOrEqual(4);
  }, 120_000);

  it('P1: tokens that need no quote keep their ~2 s cadence while 12 candidates wait on the rate-limited provider', async () => {
    const w = buildWorld(true);
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(90_000);
    w.stop();
    const free = gaps(w, t0 + 30_000, t0 + 90_000, (i) => i >= CANDIDATES);
    expect(free.length).toBeGreaterThan(8000); // 288 tokens x 30 ticks in the 60 s window = 8,640 gaps
    expect(q(free, 0.5)).toBeLessThanOrEqual(2100);
    expect(q(free, 0.99)).toBeLessThanOrEqual(2200);
    expect(free[free.length - 1]).toBeLessThanOrEqual(2500); // never anywhere near the 12-26 s collapse

    // bounded concurrency, everywhere
    const s = w.scheduler.stats();
    const st = w.stage!.stats();
    expect(s.maxActive).toBeLessThanOrEqual(4); // global slots HELD
    expect(st.maxPermitsInUse).toBeLessThanOrEqual(4); // calls inside the provider gate
    expect(st.maxQueued).toBeLessThanOrEqual(quoteStageOptions(QUOTE_CFG).maxQueued); // the line
    expect(s.maxSuspended).toBeLessThanOrEqual(CANDIDATES); // at most one per candidate token (the per-token guard)
    expect(w.concurrentPerMint.max).toBe(1); // never two evaluations of one token at once (no duplicate/race), even while suspended

    // the provider budget is exactly what it was: 0.5 req/s => at most ~1 + 45 requests in 90 s
    const budget = w.fetchCalls.length;
    expect(budget).toBeLessThanOrEqual(1 + Math.ceil(90 * QUOTE_CFG.maxRequestsPerSecond) + 1);

    // overload is refused (fail closed), not queued without bound; and the quotes that were served were served
    expect(st.rejectedQueueFull + st.rejectedWaitTimeout).toBeGreaterThan(0);
    expect(w.quoteOutcomes.ok).toBeGreaterThan(20);
    expect(st.admitted + st.rejectedQueueFull + st.rejectedWaitTimeout).toBeGreaterThan(0);
  }, 120_000);

  it('P1: candidates are served in line order, none starves: every candidate token gets quotes over a long window', async () => {
    const w = buildWorld(true);
    const served = new Map<string, number>();
    const original = w.gate.execute.bind(w.gate);
    w.gate.execute = async (req) => {
      const r = await original(req);
      const mint = /mint=(tok\d+)/.exec(req.path ?? '')?.[1] ?? '?';
      served.set(mint, (served.get(mint) ?? 0) + 1);
      return r;
    };
    await vi.advanceTimersByTimeAsync(300_000); // 5 minutes: 150 quotes at 0.5 req/s shared by 12 candidates
    w.stop();
    expect(served.size).toBe(CANDIDATES); // every candidate got served at least once
    const counts = [...served.values()];
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2); // nobody is locked out
    expect(Math.max(...counts) / Math.min(...counts)).toBeLessThanOrEqual(6); // and nobody takes it all
  }, 120_000);

  it('shutdown with many evaluations waiting on the provider: every one settles promptly, nothing is left suspended, queued or timed', async () => {
    const w = buildWorld(true);
    await vi.advanceTimersByTimeAsync(30_000);
    w.stop();
    const before = w.stage!.stats();
    expect(before.permitsInUse + before.queued).toBeGreaterThan(0); // there really are waiters right now
    w.scheduler.stop();
    w.gate.shutdown(); // StagedProviderGate: stage first (refuses the line), then the gate (aborts what is inside)
    await vi.advanceTimersByTimeAsync(200);
    expect(w.stage!.stats().queued).toBe(0);
    expect(w.stage!.stats().permitsInUse).toBe(0);
    expect(w.scheduler.suspendedCount).toBe(0);
    expect(w.scheduler.activeCount).toBe(0);
    expect(w.scheduler.pendingCount).toBe(0);
    expect(w.stage!.stats().rejectedShutdown).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
