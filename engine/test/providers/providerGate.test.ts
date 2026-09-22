import { describe, expect, it, vi } from 'vitest';
import { ProviderError, type FetchLike } from '../../src/providers/providerGate.js';
import { fakeFetch, gate, makeResponse } from './helpers.js';

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

// ---------------------------------------------------------------------------------------------------------------------
// Bug fix regression (Phase 5.6J VPS incident): a logical request that never even attempted an HTTP call because the
// LOCAL gate (rate-limit spacing or the concurrency queue) could not get it a slot before its own deadline used to be
// treated exactly like a genuine failed endpoint interaction -- silently opening the provider circuit purely from
// local scheduling pressure, even while every request that actually reached the network was succeeding. See
// `EndpointOutcome` in providerGate.ts: `tryEndpoint` now distinguishes 'not_attempted' (zero HTTP attempts; never
// counts toward `consecutiveFailures`, increments the new `gateCapacityRejected` metric instead) from 'failed' (at
// least one real HTTP attempt happened and none succeeded; this is what may open the circuit).
// ---------------------------------------------------------------------------------------------------------------------
describe('ProviderGate: local gate saturation must never be mistaken for an upstream failure', () => {
  it('acquire() rejects because the rate-limit slot would fall past the deadline: zero HTTP attempts, no consecutiveFailures, gateCapacityRejected increments instead', async () => {
    const f = fakeFetch([ok]);
    const t = 1_000_000;
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRequestsPerSecond: 1, maxRetries: 0, maxTotalMs: 500, circuitFailureThreshold: 1, now: () => t });
    await g.execute({ method: 'POST' }); // consumes the only rate-limit slot for the next 1000ms
    expect(f.calls.length).toBe(1);
    const err = await g.execute({ method: 'POST' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(f.calls.length).toBe(1); // no second HTTP attempt was ever made
    expect(metrics.counters('rpc').failures).toBe(0); // never counted as an HTTP failure
    expect(metrics.counters('rpc').circuitOpened).toBe(0); // threshold=1 would have tripped instantly under the old bug
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(1);
  });

  it('repeated local scheduling rejections never open the circuit, however many accumulate', async () => {
    const f = fakeFetch([ok]);
    const t = 1_000_000;
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRequestsPerSecond: 1, maxRetries: 0, maxTotalMs: 500, circuitFailureThreshold: 3, now: () => t });
    await g.execute({ method: 'POST' }); // consumes the slot
    for (let i = 0; i < 10; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(f.calls.length).toBe(1); // only the very first call ever reached the network
    expect(metrics.counters('rpc').circuitOpened).toBe(0);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(10);
  });

  it('genuine HTTP 5xx failures still open the circuit at the configured threshold (unaffected by the fix)', async () => {
    const f = fakeFetch([{ status: 500 }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 0, circuitFailureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    expect(f.calls.length).toBe(3); // every one of these genuinely reached the network
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
  });

  it('genuine network errors still open the circuit at the configured threshold', async () => {
    const f = fakeFetch([{ throws: true }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 0, circuitFailureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    expect(metrics.counters('rpc').networkErrors).toBe(3);
    expect(f.calls.length).toBe(3);
  });

  it('genuine timeouts across separate logical requests still open the circuit at the configured threshold', async () => {
    const f = fakeFetch([{ hang: true }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, timeoutMs: 5, maxRetries: 0, circuitFailureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    expect(metrics.counters('rpc').timeouts).toBe(3);
  });

  it('a successful response resets consecutiveFailures, so an interleaved success prevents the circuit from opening early', async () => {
    const f = fakeFetch((i) => (i === 1 ? ok : { status: 500 }));
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 0, circuitFailureThreshold: 2 });
    await g.execute({ method: 'POST' }).catch(() => undefined); // #1 (i=0): 500 -> consecutiveFailures=1
    await g.execute({ method: 'POST' }); // #2 (i=1): ok -> resets to 0
    await g.execute({ method: 'POST' }).catch(() => undefined); // #3 (i=2): 500 -> consecutiveFailures=1, NOT 2
    expect(metrics.counters('rpc').circuitOpened).toBe(0);
    await g.execute({ method: 'POST' }).catch(() => undefined); // #4 (i=3): 500 -> consecutiveFailures=2 -> opens
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
  });

  it('a structurally unsupported method never counts toward the outage circuit, however many times it recurs', async () => {
    const f = fakeFetch([{ status: 429, headers: { 'x-ratelimit-method-limit': '0' } }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, circuitFailureThreshold: 2 });
    for (let i = 0; i < 5; i += 1) await g.execute({ method: 'POST', rpcMethod: 'getTokenLargestAccounts' }).catch(() => undefined);
    expect(metrics.counters('rpc').circuitOpened).toBe(0);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
    expect(f.calls.length).toBe(1); // remembered after the first response, never hit again
  });

  it('reproduces the Phase 5.6J VPS pattern -- heavy offered load against a small gate produces mostly local rejections, and the circuit never opens from them', async () => {
    const f = fakeFetch(() => ok); // whenever an attempt DOES reach the network it always succeeds, matching the VPS observation (751/755 successful, 0 failures, 0 timeouts on delivered requests)
    const { gate: g, metrics } = gate({
      fetchImpl: f.fn,
      maxConcurrent: 1,
      maxRequestsPerSecond: 5,
      maxRetries: 0,
      maxTotalMs: 30,
      circuitFailureThreshold: 3,
    });
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => g.execute({ method: 'POST' })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    expect(failed).toBeGreaterThan(0); // most of the 50 could not get a local slot before their own deadline
    expect(metrics.counters('rpc').circuitOpened).toBe(0); // none of that opened the circuit
    expect(metrics.counters('rpc').gateCapacityRejected).toBeGreaterThan(0);
    expect(metrics.counters('rpc').failures).toBe(0); // zero genuine HTTP failures occurred -- every rejection was local
    expect(metrics.counters('rpc').requests).toBe(metrics.counters('rpc').successes); // whatever DID reach the network succeeded
    expect(g.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P2 fix: near-deadline local pressure. Phase 5.6J (above) fixed the case where the local gate never hands out a
// slot at all before the deadline. This fixes the ADJACENT case: the gate DOES hand out a slot, but so close to the
// deadline that the HTTP attempt that follows gets a truncated timeout budget (`Math.min(this.o.timeoutMs, deadline
// - t0)` in tryEndpoint) -- a slow-but-healthy upstream response then looks exactly like a genuine provider
// timeout, wrongly counting toward `consecutiveFailures`/the circuit breaker for what was really just local
// scheduling pressure. `acquire()` now refuses the slot (routed through the SAME 'not_attempted' path as Phase
// 5.6J) whenever less than a full `timeoutMs` remains before the deadline.
// ---------------------------------------------------------------------------------------------------------------------
describe('ProviderGate: a slot must not be granted with less than a full attempt-timeout of budget remaining', () => {
  /**
   * A real (fake-timer-driven) delay: resolves after `ms`, so `acquire()`'s concurrency wait genuinely spends wall-
   * clock time -- unlike `instantSleep`, which resolves immediately and so never lets a "how much budget is left
   * NOW" check see anything but the start of the window. Requires `vi.useFakeTimers()` to be active.
   */
  const timedSleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      }, { once: true });
    });

  /** A slot held by `holdMs` before its fetch resolves -- used to make a SECOND, concurrent request wait exactly that long for a concurrency slot, simulating time consumed by earlier local work in the SAME logical request. */
  function heldFetch(holdMs: number, calls: { n: number }): FetchLike {
    let first = true;
    return ((_url: string, _init: unknown) => {
      calls.n += 1;
      if (first) {
        first = false;
        return new Promise((resolve) => setTimeout(() => resolve(makeResponse(ok)), holdMs));
      }
      return Promise.resolve(makeResponse(ok));
    }) as unknown as FetchLike;
  }

  it('slot available with plenty of remaining budget -> a normal HTTP attempt happens', async () => {
    const f = fakeFetch([ok]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, timeoutMs: 200, maxTotalMs: 2000 });
    const res = await g.execute({ method: 'POST' });
    expect(res.status).toBe(200);
    expect(f.calls.length).toBe(1);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
  });

  it('near-deadline slot (remaining budget < timeoutMs) -> zero HTTP attempts, gateCapacityRejected increments, no failure counted', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      // maxConcurrent: 1 -- the first request holds the only slot for 1950ms of a 2000ms budget; the second must
      // wait for it, so by the time IT could be granted a slot only ~50ms remain -- well under the 200ms
      // configured per-attempt timeout.
      const { gate: g, metrics } = gate({ fetchImpl: heldFetch(1950, calls), maxConcurrent: 1, timeoutMs: 200, maxTotalMs: 2000, maxRetries: 0, sleep: timedSleep, now: () => Date.now() });
      const p1 = g.execute({ method: 'POST' });
      const p2 = g.execute({ method: 'POST' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1950);
      await p1;
      const err = await p2;
      expect(err).toBeInstanceOf(ProviderError);
      expect(calls.n).toBe(1); // only the FIRST request's fetch was ever called
      expect(metrics.counters('rpc').failures).toBe(0);
      expect(metrics.counters('rpc').timeouts).toBe(0);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a near-deadline local rejection never opens the circuit, however many accumulate', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({ fetchImpl: heldFetch(1950, calls), maxConcurrent: 1, timeoutMs: 200, maxTotalMs: 2000, maxRetries: 0, circuitFailureThreshold: 1, sleep: timedSleep, now: () => Date.now() });
      const p1 = g.execute({ method: 'POST' });
      const rejections = Array.from({ length: 5 }, () => g.execute({ method: 'POST' }).catch(() => undefined));
      await vi.advanceTimersByTimeAsync(1950);
      await p1;
      // The first queued waiter is woken by p1's release and rejected immediately by the near-deadline check; it
      // never takes the slot, so it never wakes the next one -- each remaining waiter only resolves at its OWN
      // ~2000ms concurrency-wait deadline (a pre-existing, equally-'not_attempted' path). Advance far enough to
      // cover all of them.
      await vi.advanceTimersByTimeAsync(300);
      await Promise.all(rejections);
      expect(calls.n).toBe(1);
      expect(metrics.counters('rpc').circuitOpened).toBe(0); // threshold=1 would have tripped instantly under the old bug
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a genuine HTTP timeout that DID receive its full configured budget still counts as a real failure and can open the circuit', async () => {
    const f = fakeFetch([{ hang: true }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, timeoutMs: 5, maxTotalMs: 2000, maxRetries: 0, circuitFailureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(f.calls.length).toBe(3); // every attempt genuinely reached fetchImpl with its full 5ms budget
    expect(metrics.counters('rpc').timeouts).toBe(3);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
  });

  it('genuine HTTP 5xx failures are unaffected by this fix and still open the circuit', async () => {
    const f = fakeFetch([{ status: 500 }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 0, circuitFailureThreshold: 2 });
    for (let i = 0; i < 2; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
  });

  it('genuine network errors are unaffected by this fix and still open the circuit', async () => {
    const f = fakeFetch([{ throws: true }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 0, circuitFailureThreshold: 2 });
    for (let i = 0; i < 2; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    expect(metrics.counters('rpc').networkErrors).toBe(2);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
  });

  it('local saturation (near-deadline OR pure gate-capacity rejection) alone never opens the circuit, no matter how it is mixed with real traffic', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({ fetchImpl: heldFetch(1950, calls), maxConcurrent: 1, timeoutMs: 200, maxTotalMs: 2000, maxRetries: 0, circuitFailureThreshold: 2, sleep: timedSleep, now: () => Date.now() });
      const first = g.execute({ method: 'POST' }); // a normal request that will succeed, holding the slot
      const rejections = Array.from({ length: 6 }, () => g.execute({ method: 'POST' }).catch(() => undefined)); // queue behind it, each starved of budget by the time the slot frees
      await vi.advanceTimersByTimeAsync(1950);
      const res = await first;
      await vi.advanceTimersByTimeAsync(300); // let every remaining waiter reach its own concurrency-wait deadline too
      await Promise.all(rejections);
      expect(res.status).toBe(200);
      expect(metrics.counters('rpc').circuitOpened).toBe(0);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(6);
      expect(metrics.counters('rpc').failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
