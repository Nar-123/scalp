import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JupiterQuoteClient } from '../../src/execution/jupiterQuoteClient.js';
import { EvaluationScheduler } from '../../src/orchestrator/evaluationScheduler.js';
import type { FetchLike } from '../../src/providers/providerGate.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';
import { QuoteStage, StagedProviderGate, quoteStageOptions } from '../../src/providers/quoteStage.js';
import { makeResponse } from '../providers/helpers.js';

/**
 * The stage sits BELOW the quote client's cache and ABOVE the unmodified gate. These tests use the real
 * JupiterQuoteClient to pin the two properties the design relies on.
 */
const CFG = { maxConcurrent: 4, maxRequestsPerSecond: 0.5, timeoutMs: 4000 };
const BODY = JSON.stringify({ inAmount: '1000', outAmount: '900', priceImpactPct: '0.001', routePlan: [] });
const SOL = 'So11111111111111111111111111111111111111112';

function stack(fetchImpl: FetchLike, stageOpts = quoteStageOptions(CFG)) {
  const metrics = new ProviderMetrics();
  const stage = new QuoteStage(stageOpts);
  const gate = new StagedProviderGate(
    { kind: 'quote', endpoints: [{ baseUrl: 'https://quote.example' }], timeoutMs: CFG.timeoutMs, maxConcurrent: CFG.maxConcurrent, maxRequestsPerSecond: CFG.maxRequestsPerSecond, maxRetries: 0, baseBackoffMs: 300, maxBackoffMs: 2500, maxTotalMs: 8000, circuitFailureThreshold: 5, circuitCooldownMs: 15_000, unsupportedCooldownMs: 600_000, fetchImpl },
    metrics,
    undefined,
    stage,
  );
  const client = new JupiterQuoteClient({ jupiterQuoteBaseUrl: 'https://quote.example', requestTimeoutMs: CFG.timeoutMs }, undefined, { gate, metrics, cacheTtlMs: 2000 });
  const scheduler = new EvaluationScheduler({ maxConcurrent: 4 });
  return { stage, gate, client, scheduler };
}

describe('QuoteStage through the real JupiterQuoteClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a cache HIT never touches the stage: no permit, no slot given back; only a real provider call does', async () => {
    let fetches = 0;
    const { stage, client, scheduler } = stack(() => {
      fetches += 1;
      return Promise.resolve(makeResponse({ status: 200, body: BODY }));
    });
    const results: Array<boolean | undefined> = [];
    scheduler.requestTick('tokA', async () => {
      results.push((await client.getQuoteDetailed(SOL, 'mintA', 1000n, 100)).ok); // miss -> provider
      const afterMiss = scheduler.stats().suspends;
      results.push((await client.getQuoteDetailed(SOL, 'mintA', 1000n, 100)).ok); // identical key within the TTL -> cache
      expect(scheduler.stats().suspends).toBe(afterMiss); // the hit did not give the slot back
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(results).toEqual([true, true]);
    expect(fetches).toBe(1);
    expect(stage.stats().admitted).toBe(1); // exactly one stage entry, for the one real provider call
    expect(scheduler.stats().suspends).toBe(1);
    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.suspendedCount).toBe(0);
  });

  it('a REFUSED request comes out as the same fail-closed "unavailable" the client always returned, never a throw', async () => {
    // 1 permit, no line: the second concurrent request for a different quote is refused by the stage.
    const hold: Array<() => void> = [];
    const { stage, client, scheduler } = stack(
      () => new Promise((resolve) => hold.push(() => resolve(makeResponse({ status: 200, body: BODY })))),
      { maxConcurrent: 1, maxQueued: 0, maxQueueWaitMs: 4000 },
    );
    const outcomes: Record<string, unknown> = {};
    scheduler.requestTick('tokA', async () => void (outcomes.A = await client.getQuoteDetailed(SOL, 'mintA', 1000n, 100)));
    scheduler.requestTick('tokB', async () => void (outcomes.B = await client.getQuoteDetailed(SOL, 'mintB', 1000n, 100)));
    scheduler.requestTick('tokC', async () => void (outcomes.C = (await client.getBuyQuote('mintC', 0.05, 100)) ?? 'null'));
    await vi.advanceTimersByTimeAsync(10);
    expect(outcomes.B).toEqual({ ok: false, kind: 'unavailable', reason: 'rate_limited' });
    expect(outcomes.C).toBe('null'); // the null-returning wrapper callers (safety gate, price source) already treat as "quote unavailable"
    expect(stage.stats().rejectedQueueFull).toBe(2);
    expect(scheduler.suspendedCount).toBe(1); // only A is waiting on the provider; B and C already finished (fail closed)
    expect(scheduler.activeCount).toBe(0); // and nobody is holding a slot while waiting
    hold.forEach((h) => h());
    await vi.advanceTimersByTimeAsync(50);
    expect((outcomes.A as { ok: boolean }).ok).toBe(true);
    expect(scheduler.suspendedCount).toBe(0);
  });

  it('a caller that is NOT an evaluation (e.g. position monitoring) is unaffected by the stage, even when it is full', async () => {
    const { stage, client } = stack(() => Promise.resolve(makeResponse({ status: 200, body: BODY })), { maxConcurrent: 1, maxQueued: 0, maxQueueWaitMs: 4000 });
    const pending = Promise.all(Array.from({ length: 5 }, (_, i) => client.getQuoteDetailed(SOL, `m${i}`, 1000n, 100)));
    await vi.advanceTimersByTimeAsync(60_000); // the unmodified gate still spaces them at 0.5 req/s
    const many = await pending;
    expect(stage.stats().passedThrough).toBe(5);
    expect(stage.stats().rejectedQueueFull).toBe(0);
    expect(many).toHaveLength(5);
  });
});
