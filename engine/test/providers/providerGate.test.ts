import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/providers/providerGate.js';
import { fakeFetch, gate } from './helpers.js';

const ok = { status: 200, body: '{"result":1}' };

describe('ProviderGate: timeouts, 429, Retry-After, bounded retry', () => {
  it('provider timeout: the attempt is aborted, retried a bounded number of times, then fails as timeout', async () => {
    const f = fakeFetch([{ hang: true }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, timeoutMs: 20, maxRetries: 2 });
    const err = await g.execute({ method: 'POST', body: '{}' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.reason).toBe('timeout');
    expect(f.calls.length).toBe(3); // 1 + maxRetries, never more
    expect(metrics.counters('rpc').timeouts).toBe(3);
    expect(metrics.counters('rpc').logicalFailures).toBe(1);
    expect(g.pending).toBe(0);
  });

  it('RPC 429: retried with backoff and succeeds when the provider recovers', async () => {
    const f = fakeFetch([{ status: 429 }, { status: 429 }, ok]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn });
    const res = await g.execute({ method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    expect(metrics.counters('rpc').http429).toBe(2);
    expect(metrics.counters('rpc').retries).toBe(2);
  });

  it('quote 429: a persistent 429 fails as rate_limited within the retry bound', async () => {
    const f = fakeFetch([{ status: 429 }]);
    const { gate: g, metrics } = gate({ kind: 'quote', fetchImpl: f.fn, maxRetries: 2 });
    const err = await g.execute({ method: 'GET', path: '/quote?x=1' }).catch((e) => e);
    expect(err.reason).toBe('rate_limited');
    expect(f.calls.length).toBe(3);
    expect(metrics.counters('quote').http429).toBe(3);
  });

  it('Retry-After is honored, and a wait beyond the time budget is not taken', async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, headers: { 'retry-after': '1' } }, ok]);
    const { gate: g } = gate({ fetchImpl: f.fn, sleep: async (ms) => void waits.push(ms) });
    await g.execute({ method: 'POST', body: '{}' });
    expect(waits.some((w) => w >= 1000)).toBe(true);

    const f2 = fakeFetch([{ status: 429, headers: { 'retry-after': '60' } }, ok]);
    const { gate: g2 } = gate({ fetchImpl: f2.fn, maxTotalMs: 2000 });
    const err = await g2.execute({ method: 'POST', body: '{}' }).catch((e) => e);
    expect(err.reason).toBe('rate_limited');
    expect(f2.calls.length).toBe(1); // it did not sit out a 60 s wait
  });

  it('retries are bounded by maxRetries', async () => {
    const f = fakeFetch([{ status: 503 }]);
    const { gate: g } = gate({ fetchImpl: f.fn, maxRetries: 1 });
    await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(f.calls.length).toBe(2);
  });

  it('a method the endpoint will never serve (method limit 0) is not retried and is remembered', async () => {
    const f = fakeFetch([{ status: 429, headers: { 'x-ratelimit-method-limit': '0' } }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn });
    const e1 = await g.execute({ method: 'POST', rpcMethod: 'getTokenLargestAccounts' }).catch((e) => e);
    expect(e1.reason).toBe('unsupported');
    expect(f.calls.length).toBe(1);
    const e2 = await g.execute({ method: 'POST', rpcMethod: 'getTokenLargestAccounts' }).catch((e) => e);
    expect(e2.reason).toBe('unsupported');
    expect(f.calls.length).toBe(1); // the second request never hit the endpoint
    expect(metrics.counters('rpc').unsupported).toBe(1);
  });

  it('circuit breaker opens after repeated failures, fails fast, and re-tries after the cooldown', async () => {
    const f = fakeFetch([{ status: 500 }]);
    let t = 1_000_000;
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 0, circuitFailureThreshold: 3, now: () => t });
    for (let i = 0; i < 3; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    const before = f.calls.length;
    const err = await g.execute({ method: 'POST' }).catch((e) => e);
    expect(err.reason).toBe('circuit_open');
    expect(f.calls.length).toBe(before);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    t += 61_000;
    await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(f.calls.length).toBe(before + 1);
  });

  it('bounded concurrency: never more than maxConcurrent requests in flight', async () => {
    let active = 0;
    let peak = 0;
    const fn = (() => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) =>
        setTimeout(() => {
          active -= 1;
          resolve({ status: 200, headers: { get: () => null }, text: async () => '{}' });
        }, 15),
      );
    }) as never;
    const { gate: g } = gate({ fetchImpl: fn, maxConcurrent: 2, maxTotalMs: 5000, timeoutMs: 1000 });
    await Promise.all(Array.from({ length: 8 }, () => g.execute({ method: 'POST' })));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('ProviderGate: explicit fallback', () => {
  const two = [{ baseUrl: 'https://primary.example/' }, { baseUrl: 'https://backup.example/' }];

  it('falls back to the configured secondary, observably, and timestamps the answer with the answering host', async () => {
    const f = fakeFetch((_i, url) => (url.includes('primary') ? { status: 500 } : ok));
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, endpoints: two, maxRetries: 0 });
    const res = await g.execute({ method: 'POST' });
    expect(res.fromFallback).toBe(true);
    expect(res.host).toBe('https://backup.example');
    expect(res.asOfMs).toBeGreaterThan(0);
    expect(metrics.counters('rpc').fallbackUsed).toBe(1);
    expect(metrics.snapshot().lastProvider.rpc?.host).toBe('https://backup.example');
  });

  it('is bounded: each endpoint is tried at most once per logical request, and when all fail the result is a failure', async () => {
    const f = fakeFetch([{ status: 500 }]);
    const { gate: g } = gate({ fetchImpl: f.fn, endpoints: two, maxRetries: 0 });
    const err = await g.execute({ method: 'POST' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(f.calls.length).toBe(2);
  });

  it('with no fallback configured there is no fallback (no silent provider switching)', async () => {
    const f = fakeFetch([{ status: 500 }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 0 });
    await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(new Set(f.calls.map((c) => new URL(c.url).host)).size).toBe(1);
    expect(metrics.counters('rpc').fallbackUsed).toBe(0);
  });
});
