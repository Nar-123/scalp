import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvaluationScheduler } from '../../src/orchestrator/evaluationScheduler.js';
import type { FetchLike } from '../../src/providers/providerGate.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';
import { QuoteStage, StagedProviderGate, quoteStageOptions, type QuoteStageOptions } from '../../src/providers/quoteStage.js';
import { makeResponse } from '../providers/helpers.js';

/**
 * P1 follow-up regression: a saturated rate-limited gate must not waste the provider budget.
 *
 * Found live (30 min, keyless Jupiter 0.5 req/s): with 4 evaluations inside the gate at once every request waited about
 * `4 * spacing - previous latency` for its rate slot and was left an attempt window equal to the PREVIOUS request's latency
 * (`effectiveTimeoutMs = deadline - t0`). Slower-than-predecessor attempts were aborted (`gateCapacityRejected` 28 %,
 * `fetchAbandoned` 83, against 1 % / 1 for the old code). Here the same thing is reproduced under fake time with the REAL gate
 * and a fetch that honours its abort signal, with realistic 250-900 ms latencies and round-trip (two-leg) evaluations.
 */
const CFG = { maxConcurrent: 4, maxRequestsPerSecond: 0.5, timeoutMs: 4000 };
const TOKENS = 60;
const CANDIDATES = 12;
const MINUTES = 6;

function run(stageOpts: QuoteStageOptions) {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(makeResponse({ status: 200, body: '{"ok":true}' })), 250 + Math.floor(rnd() * 650));
      init.signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
    });
  const metrics = new ProviderMetrics();
  const stage = new QuoteStage(stageOpts);
  const gate = new StagedProviderGate(
    { kind: 'quote', endpoints: [{ baseUrl: 'https://quote.example' }], timeoutMs: CFG.timeoutMs, maxConcurrent: CFG.maxConcurrent, maxRequestsPerSecond: CFG.maxRequestsPerSecond, maxRetries: 0, baseBackoffMs: 300, maxBackoffMs: 2500, maxTotalMs: 8000, circuitFailureThreshold: 1000, circuitCooldownMs: 15_000, unsupportedCooldownMs: 600_000, fetchImpl },
    metrics,
    undefined,
    stage,
  );
  const scheduler = new EvaluationScheduler({ maxConcurrent: 4 });
  const outcome = { roundTripsDone: 0, roundTripsRefused: 0, secondLegRefused: 0 };
  const inflight = new Set<string>();
  const evaluate = async (mint: string, candidate: boolean): Promise<void> => {
    if (inflight.has(mint)) return;
    inflight.add(mint);
    try {
      if (!candidate) return;
      try {
        await gate.execute({ method: 'GET', path: `/quote?mint=${mint}&leg=1&t=${Date.now()}` });
      } catch {
        outcome.roundTripsRefused += 1;
        return;
      }
      try {
        await gate.execute({ method: 'GET', path: `/quote?mint=${mint}&leg=2&t=${Date.now()}` });
        outcome.roundTripsDone += 1;
      } catch {
        outcome.secondLegRefused += 1;
      }
    } finally {
      inflight.delete(mint);
    }
  };
  const timers: Array<ReturnType<typeof setInterval>> = [];
  for (let i = 0; i < TOKENS; i += 1) {
    const mint = `tok${i}`;
    setTimeout(() => {
      scheduler.requestTick(mint, () => evaluate(mint, i < CANDIDATES));
      timers.push(setInterval(() => scheduler.requestTick(mint, () => evaluate(mint, i < CANDIDATES)), 2000));
    }, Math.floor((i * 2000) / TOKENS));
  }
  return {
    outcome,
    stage,
    metrics,
    async finish() {
      await vi.advanceTimersByTimeAsync(MINUTES * 60_000);
      const c = { ...metrics.counters('quote') };
      timers.forEach(clearInterval);
      scheduler.stop();
      stage.shutdown();
      gate.shutdown();
      await vi.advanceTimersByTimeAsync(10_000);
      return c;
    },
  };
}

describe('P1: the quote stage does not waste the provider budget under saturation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('MUTATION (4 permits, the first P1 design) reproduces the live waste: many attempts aborted by their own shrunken window', async () => {
    const w = run({ maxConcurrent: 4, maxQueued: 2, maxQueueWaitMs: 4000 });
    const c = await w.finish();
    const wasted = c.gateCapacityRejected + c.fetchAbandoned;
    if (process.env.P1_VERBOSE) console.info('MUTATION', JSON.stringify({ requests: c.requests, successes: c.successes, gateCapacityRejected: c.gateCapacityRejected, fetchAbandoned: c.fetchAbandoned, stage: w.stage.stats(), outcome: w.outcome }));
    expect(wasted).toBeGreaterThan(0.1 * (c.requests + c.gateCapacityRejected)); // >10 % of attempts wasted
  }, 120_000);

  it('sized from the gate config (permits = rps x timeout): ~no attempt is aborted by its own window and the gate stays busy', async () => {
    const opts = quoteStageOptions(CFG);
    expect(opts.maxConcurrent).toBe(2);
    const w = run(opts);
    const c = await w.finish();
    const seconds = MINUTES * 60;
    if (process.env.P1_VERBOSE) console.info('SIZED', JSON.stringify({ requests: c.requests, successes: c.successes, gateCapacityRejected: c.gateCapacityRejected, fetchAbandoned: c.fetchAbandoned, stage: w.stage.stats(), outcome: w.outcome }));
    expect(c.gateCapacityRejected).toBeLessThanOrEqual(Math.ceil(0.01 * c.requests)); // <= 1 %
    expect(c.fetchAbandoned).toBe(0);
    expect(c.timeouts).toBe(0);
    expect(c.successes).toBeGreaterThanOrEqual(c.requests - CFG.maxConcurrent); // every attempt that was started was answered (only those still in flight when the window ends are missing)
    expect(c.requests).toBeGreaterThanOrEqual(Math.floor(0.85 * CFG.maxRequestsPerSecond * seconds)); // gate >= 85 % utilised (never above its 0.5 req/s)
    expect(c.requests).toBeLessThanOrEqual(Math.ceil(CFG.maxRequestsPerSecond * seconds) + 2);
    expect(w.stage.stats().maxPermitsInUse).toBeLessThanOrEqual(2);
  }, 120_000);

  it('completes round trips: a second leg is not refused after its first leg already spent a provider call', async () => {
    const w = run(quoteStageOptions(CFG));
    await w.finish();
    const { roundTripsDone, secondLegRefused } = w.outcome;
    expect(roundTripsDone).toBeGreaterThan(0);
    expect(secondLegRefused).toBeLessThanOrEqual(Math.ceil(0.1 * (roundTripsDone + secondLegRefused))); // continuation priority keeps wasted first legs under 10 %
  }, 120_000);
});
