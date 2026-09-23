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
// P2 starvation fix. An EARLIER version of this fix made `acquire()` itself refuse a slot whenever less than a full
// `timeoutMs` remained after waiting on rate-limit spacing or the concurrency queue -- meant to stop a
// truncated-timeout HTTP attempt from looking like a genuine provider failure. That check was ITSELF a bug: on the
// VPS, under real sustained contention, a request that has to wait ANY amount for a slot will almost always have
// less than a full `timeoutMs` left by the time it is granted one. Once contention began, EVERY subsequent waiter
// self-rejected without ever dispatching a real HTTP attempt, no slot was ever genuinely used or freed for reuse,
// and each self-rejecting call had ALREADY advanced the shared rate-limit clock (`st.nextSlotAt`) before rejecting
// itself -- permanently outracing real wall-clock time. RPC `requests`/`successes` froze for 15+ minutes on the VPS
// while `gateCapacityRejected` absorbed 100% of new demand, with zero recovery.
//
// The fix (see `acquire()`/`tryEndpoint()` in providerGate.ts) moves the "was this a fair test of the endpoint"
// judgment from BEFORE the attempt (refuse the slot) to AFTER it (classify the outcome): `acquire()` grants a slot
// to anyone with any genuine time left, exactly as it did before either P2 patch; `tryEndpoint` then computes
// `budgetTruncated` from the ACTUAL remaining budget at attempt time and, only if the attempt's own abort timer
// fires (`timedOut`) AND that budget was truncated, classifies it as `EndpointOutcome` kind `'local_deadline'` --
// counted in `gateCapacityRejected`, never in `failures`/`timeouts`, never opening the circuit. A genuine timeout
// with a full (non-truncated) budget, a genuine network error, or a genuine 5xx are all unaffected regardless of
// contention, because none of them depend on how much of our own budget was left.
// ---------------------------------------------------------------------------------------------------------------------
describe('ProviderGate: P2 starvation fix -- local deadline pressure must never be mistaken for a provider failure, and must never cause permanent starvation', () => {
  /**
   * A real (fake-timer-driven) delay: resolves after `ms`, so `acquire()`'s concurrency/rate wait genuinely spends
   * wall-clock time -- unlike `instantSleep`, which resolves immediately and so never lets a "how much budget is
   * left NOW" computation see anything but the start of the window. Requires `vi.useFakeTimers()` to be active.
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

  /** A slot held by `holdMs` before its fetch resolves 200 OK -- simulates one request occupying a concurrency slot for real wall-clock time. */
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

  /** Every call takes real (fake-timer) `latencyMs` to resolve 200 OK, and honors the abort signal like a real fetch would. */
  function delayedFetch(latencyMs: number, calls: { n: number }): FetchLike {
    return ((_url: string, init: { signal: AbortSignal }) => {
      calls.n += 1;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(makeResponse(ok)), latencyMs);
        init.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        }, { once: true });
      });
    }) as unknown as FetchLike;
  }

  // 1. uncontended immediate request
  it('1. uncontended immediate request -> a normal HTTP attempt with the full configured timeout, unaffected by anything here', async () => {
    const f = fakeFetch([ok]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, timeoutMs: 200, maxTotalMs: 2000 });
    const res = await g.execute({ method: 'POST' });
    expect(res.status).toBe(200);
    expect(f.calls.length).toBe(1);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
  });

  // 2. rate-spacing wait
  it('2. rate-spacing wait (plenty of budget left afterward) -> waits, then gets a normal full-budget attempt and succeeds', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({ fetchImpl: delayedFetch(10, calls), maxRequestsPerSecond: 2, timeoutMs: 200, maxTotalMs: 5000, sleep: timedSleep, now: () => Date.now() });
      const p1 = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(10);
      await p1;
      const p2 = g.execute({ method: 'POST' }); // must wait ~500ms of rate spacing; 4500ms+ still remains afterward
      await vi.advanceTimersByTimeAsync(510);
      const res2 = await p2;
      expect(res2.status).toBe(200);
      expect(calls.n).toBe(2);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
      expect(metrics.counters('rpc').failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 3. concurrency wait
  it('3. concurrency wait (plenty of budget left afterward) -> waits for the slot to free, then gets a normal attempt and succeeds', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({ fetchImpl: heldFetch(50, calls), maxConcurrent: 1, timeoutMs: 200, maxTotalMs: 5000, maxRetries: 0, sleep: timedSleep, now: () => Date.now() });
      const p1 = g.execute({ method: 'POST' });
      const p2 = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(50);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(calls.n).toBe(2); // the second genuinely got dispatched once the first released its slot
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 4. deadline expires while waiting (queued for a concurrency slot, own budget runs out before one frees)
  it('4. deadline expires while queued for a concurrency slot -> not_attempted, gateCapacityRejected increments, no failure counted', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({ fetchImpl: heldFetch(500, calls), maxConcurrent: 1, timeoutMs: 200, maxTotalMs: 100, maxRetries: 0, sleep: timedSleep, now: () => Date.now() });
      const p1 = g.execute({ method: 'POST' }); // holds the only slot for 500ms
      const p2 = g.execute({ method: 'POST' }).catch((e) => e); // its own 100ms budget runs out long before p1 releases
      await vi.advanceTimersByTimeAsync(500);
      await p1;
      const err = await p2;
      expect(err).toBeInstanceOf(ProviderError);
      expect(calls.n).toBe(1); // the second request's fetchImpl was NEVER called
      expect(metrics.counters('rpc').failures).toBe(0);
      expect(metrics.counters('rpc').timeouts).toBe(0);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // 5. waiter gets slot with limited remaining budget: (a) genuinely doesn't finish in the truncated window -> local_deadline, not a failure
  it('5a. slot granted with a truncated budget, attempt does not finish in time -> local_deadline (gateCapacityRejected), never failures/timeouts', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      // maxTotalMs 300, timeoutMs 200: the first request holds the slot for 250ms, so the second is granted its
      // slot with only ~50ms left of its own 300ms budget (truncated well below the 200ms nominal timeoutMs). Its
      // OWN fetch takes 150ms -- which would have comfortably finished inside a FULL 200ms window -- so it is our
      // own truncation, not the endpoint, that causes this attempt to not finish in time.
      const { gate: g, metrics } = gate({
        fetchImpl: (async (url: string, init: { signal: AbortSignal }) => {
          calls.n += 1;
          if (calls.n === 1) return new Promise((resolve) => setTimeout(() => resolve(makeResponse(ok)), 250));
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(makeResponse(ok)), 150);
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
        }) as unknown as FetchLike,
        maxConcurrent: 1,
        timeoutMs: 200,
        maxTotalMs: 300,
        maxRetries: 0,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      const p1 = g.execute({ method: 'POST' });
      const p2 = g.execute({ method: 'POST' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(250);
      await p1;
      await vi.advanceTimersByTimeAsync(60); // the truncated ~50ms window elapses; p2's attempt was dispatched but cannot finish
      const err = await p2;
      expect(err).toBeInstanceOf(ProviderError);
      expect(calls.n).toBe(2); // the second request's fetchImpl WAS dispatched this time (the key behavior change)
      expect(metrics.counters('rpc').failures).toBe(0); // never counted as a genuine failure
      expect(metrics.counters('rpc').timeouts).toBe(0); // never counted as a genuine timeout
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // 5b. slot granted with a truncated budget but the attempt finishes anyway -> a normal success (truncation alone never dooms a request)
  it('5b. slot granted with a truncated budget, attempt finishes anyway -> counts as a normal success', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({
        fetchImpl: (async (url: string, init: { signal: AbortSignal }) => {
          calls.n += 1;
          if (calls.n === 1) return new Promise((resolve) => setTimeout(() => resolve(makeResponse(ok)), 250));
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(makeResponse(ok)), 20); // fast: fits inside the ~50ms truncated window
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
        }) as unknown as FetchLike,
        maxConcurrent: 1,
        timeoutMs: 200,
        maxTotalMs: 300,
        maxRetries: 0,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      const p1 = g.execute({ method: 'POST' });
      const p2 = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(250);
      await p1;
      await vi.advanceTimersByTimeAsync(25);
      const res2 = await p2;
      expect(res2.status).toBe(200);
      expect(calls.n).toBe(2);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
      expect(metrics.counters('rpc').successes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // 6. genuine HTTP timeout with a FULL (non-truncated) budget -> still a real failure, still can open the circuit
  it('6. genuine HTTP timeout with a full configured budget still counts as a real failure and can open the circuit', async () => {
    const f = fakeFetch([{ hang: true }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, timeoutMs: 5, maxTotalMs: 2000, maxRetries: 0, circuitFailureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await g.execute({ method: 'POST' }).catch(() => undefined);
    expect(f.calls.length).toBe(3); // every attempt genuinely reached fetchImpl with its full 5ms budget
    expect(metrics.counters('rpc').timeouts).toBe(3);
    expect(metrics.counters('rpc').circuitOpened).toBe(1);
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
  });

  // 7. genuine network error, including under truncated-budget conditions -> still a real failure (never excused by truncation)
  it('7. genuine network error still counts as a real failure even when the attempt had a truncated budget', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({
        fetchImpl: (async (_url: string, _init: unknown) => {
          calls.n += 1;
          if (calls.n === 1) return new Promise((resolve) => setTimeout(() => resolve(makeResponse(ok)), 250));
          throw new Error('ECONNRESET'); // a network error does not depend on our timer at all
        }) as unknown as FetchLike,
        maxConcurrent: 1,
        timeoutMs: 200,
        maxTotalMs: 300,
        maxRetries: 0,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      const p1 = g.execute({ method: 'POST' });
      const p2 = g.execute({ method: 'POST' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(250);
      await p1;
      const err = await p2;
      expect(err).toBeInstanceOf(ProviderError);
      expect(calls.n).toBe(2);
      expect(metrics.counters('rpc').networkErrors).toBe(1);
      expect(metrics.counters('rpc').failures).toBe(1);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(0); // NOT excused as local-only -- this is genuine evidence
    } finally {
      vi.useRealTimers();
    }
  });

  // 8. provider 5xx, including under truncated-budget conditions -> still a real failure (the provider DID answer)
  it('8. genuine HTTP 5xx still counts as a real failure even when the attempt had a truncated budget', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({
        fetchImpl: (async (_url: string, _init: unknown) => {
          calls.n += 1;
          if (calls.n === 1) return new Promise((resolve) => setTimeout(() => resolve(makeResponse(ok)), 250));
          return makeResponse({ status: 503 });
        }) as unknown as FetchLike,
        maxConcurrent: 1,
        timeoutMs: 200,
        maxTotalMs: 300,
        maxRetries: 0,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      const p1 = g.execute({ method: 'POST' });
      const p2 = g.execute({ method: 'POST' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(250);
      await p1;
      const err = await p2;
      expect(err).toBeInstanceOf(ProviderError);
      expect(calls.n).toBe(2);
      expect(metrics.counters('rpc').http5xx).toBe(1);
      expect(metrics.counters('rpc').failures).toBe(1);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 9. shutdown while waiting for a slot -> never counted as a provider failure, reported as a shutdown, not opened circuit
  it('9. shutdown while queued for a concurrency slot -> reason "shutdown", no failures/gateCapacityRejected, no circuit effect', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      // heldFetch's mock fetch does not honor the abort signal (it just resolves after `holdMs` regardless, unlike
      // a real fetch) -- kept short here so the test can advance fake time past it and let p1 settle naturally
      // without depending on abort actually cutting it short.
      const { gate: g, metrics } = gate({ fetchImpl: heldFetch(50, calls), maxConcurrent: 1, timeoutMs: 200, maxTotalMs: 8000, maxRetries: 0, circuitFailureThreshold: 1, sleep: timedSleep, now: () => Date.now() });
      const p1 = g.execute({ method: 'POST' });
      const p2 = g.execute({ method: 'POST' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(10);
      g.shutdown();
      await vi.advanceTimersByTimeAsync(10);
      const err2 = await p2;
      expect(err2).toBeInstanceOf(ProviderError);
      expect(err2.reason).toBe('shutdown');
      expect(metrics.counters('rpc').failures).toBe(0);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
      expect(metrics.counters('rpc').circuitOpened).toBe(0);
      await vi.advanceTimersByTimeAsync(50); // let p1's mock fetch (which ignores abort) settle naturally so nothing dangles
      await p1.catch(() => undefined);
      expect(g.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 10. retry after a genuine failure still works normally post-fix (unaffected by the truncation logic)
  it('10. retry after a genuine 5xx failure still succeeds normally', async () => {
    const f = fakeFetch([{ status: 503 }, ok]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, maxRetries: 1 });
    const res = await g.execute({ method: 'POST' });
    expect(res.status).toBe(200);
    expect(f.calls.length).toBe(2);
    expect(metrics.counters('rpc').retries).toBe(1);
    expect(metrics.counters('rpc').http5xx).toBe(1);
  });

  // 11. circuit breaker behavior post-fix: genuine failures interleaved with heavy local truncation still open the circuit correctly
  it('11. circuit breaker still opens from genuine failures even while local_deadline outcomes are also occurring, and local_deadline outcomes never contribute', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      const { gate: g, metrics } = gate({
        // Odd calls (1st, 3rd, 5th...) are the "genuine work" holding the slot and always answering 500. Even calls
        // (2nd, 4th...) are queued waiters that get truncated windows and never finish (local_deadline).
        fetchImpl: (async (url: string, init: { signal: AbortSignal }) => {
          calls.n += 1;
          if (calls.n % 2 === 1) return new Promise((resolve) => setTimeout(() => resolve(makeResponse({ status: 500 })), 250));
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve(makeResponse(ok)), 150);
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
        }) as unknown as FetchLike,
        maxConcurrent: 1,
        timeoutMs: 200,
        maxTotalMs: 300,
        maxRetries: 0,
        circuitFailureThreshold: 3,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      // 3 rounds: each round is one genuine 500 (odd) + one queued truncated waiter (even, local_deadline).
      for (let round = 0; round < 3; round += 1) {
        const pOdd = g.execute({ method: 'POST' }).catch(() => undefined);
        const pEven = g.execute({ method: 'POST' }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(250);
        await pOdd;
        await vi.advanceTimersByTimeAsync(60);
        await pEven;
      }
      expect(metrics.counters('rpc').http5xx).toBe(3); // 3 genuine failures
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(3); // 3 local_deadline outcomes, never counted as failures
      expect(metrics.counters('rpc').circuitOpened).toBe(1); // opened from the 3 GENUINE failures alone
    } finally {
      vi.useRealTimers();
    }
  });

  // 12. fallback endpoint behavior post-fix: a primary locally rejected (not_attempted) still leaves budget for the fallback
  //
  // Note: a TRUNCATED ('local_deadline') attempt, by construction, always consumes exactly its endpoint's remaining
  // share of the shared deadline (`effectiveTimeoutMs = deadline - t0` when truncated) -- so a logical request can
  // never have budget left for a fallback immediately after one. The scenario that legitimately leaves budget for a
  // fallback is the OTHER local-rejection path: the rate-limit slot would fall PAST the deadline, which `acquire()`
  // detects and refuses immediately, at whatever moment `now()` currently is -- not at the deadline itself.
  it('12. fallback endpoint is still tried when the primary is locally rejected (not_attempted) and budget remains', async () => {
    const f = fakeFetch(() => ok); // whichever endpoint is actually reached always succeeds
    const t = 1_000_000;
    const endpoints = [{ baseUrl: 'https://primary.example/' }, { baseUrl: 'https://backup.example/' }];
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, endpoints, maxRequestsPerSecond: 1, maxRetries: 0, maxTotalMs: 500, now: () => t });
    const first = await g.execute({ method: 'POST' }); // consumes primary's only rate-limit slot for the next 1000ms; backup has its own independent state
    expect(first.fromFallback).toBe(false);
    const res = await g.execute({ method: 'POST' }); // primary: not_attempted (its next rate-limit slot would fall past this request's own deadline) -> falls through to backup immediately, which still has its full budget
    expect(res.fromFallback).toBe(true);
    expect(res.host).toBe('https://backup.example');
    expect(metrics.counters('rpc').gateCapacityRejected).toBe(1); // primary's not_attempted outcome
    expect(metrics.counters('rpc').failures).toBe(0);
  });

  // -----------------------------------------------------------------------------------------------------------------
  // MANDATORY: reproduces the VPS smoke-test starvation pattern in two complementary ways.
  //
  // Part A shows a burst of contention degrades gracefully (mixed success/rejection, never a genuine failure, slots
  // demonstrably get reused) and that the gate recovers immediately once the burst subsides.
  //
  // Part B isolates and directly proves the deeper mechanism: a large volume of requests that time out waiting for
  // CONCURRENCY (never dispatching at all) must never poison the shared rate-limit clock (`st.nextSlotAt`) for
  // whoever comes after them. This is the part the near-deadline reclassification ALONE does not cover -- under a
  // bounded burst, "some requests never get a real chance" is unavoidable and not the bug; the bug was that the
  // OLD acquire() reserved a rate-limit slot for every one of them regardless, so the clock kept running even
  // though the network was never touched, which is what turned an ordinary bounded backlog into a one-way,
  // non-recovering freeze (the VPS: RPC frozen for 15+ minutes, zero recovery, long after the triggering demand).
  // Part B is deterministic (a single request holds the only slot indefinitely, so every other arrival is
  // GUARANTEED to fail via a concurrency timeout, never a dispatch) -- no throughput/timing race to get unlucky on.
  // -----------------------------------------------------------------------------------------------------------------
  it('STARVATION REPRODUCTION (A): a burst of contention degrades gracefully -- mixed success/rejection, no genuine failures, circuit never opens, and the gate recovers immediately once the burst subsides', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      // maxConcurrent 2, timeoutMs 100, maxTotalMs 300 (ratio 3x, matching production's 4000ms/8000ms shape). A
      // healthy endpoint answering in 80ms -- comfortably within a full 100ms window. A short (400ms), moderate
      // (~2x true ~25 req/s capacity) burst -- not an indefinite firehose -- so the burst genuinely subsides rather
      // than describing a workload no scheduling policy could ever serve.
      const { gate: g, metrics } = gate({
        fetchImpl: delayedFetch(80, calls),
        maxConcurrent: 2,
        maxRequestsPerSecond: 30,
        timeoutMs: 100,
        maxTotalMs: 300,
        maxRetries: 0,
        circuitFailureThreshold: 3,
        sleep: timedSleep,
        now: () => Date.now(),
      });

      const settled: Array<{ ok: boolean }> = [];
      const pending: Promise<void>[] = [];
      const TICK_MS = 40;
      const TICKS = 10; // 10 * 40ms = 400ms burst
      for (let tick = 0; tick < TICKS; tick += 1) {
        for (let k = 0; k < 2; k += 1) {
          pending.push(
            g
              .execute({ method: 'POST' })
              .then(() => void settled.push({ ok: true }))
              .catch(() => void settled.push({ ok: false })),
          );
        }
        await vi.advanceTimersByTimeAsync(TICK_MS);
      }
      // Burst STOPS here. Drain generously -- every one of the 20 requests resolves one way or another well within this.
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all(pending);

      const succeeded = settled.filter((s) => s.ok).length;
      const rejected = settled.length - succeeded;
      expect(settled.length).toBe(20);
      // Graceful degradation, not collapse: capacity was genuinely reused across more than just the first wave.
      expect(succeeded).toBeGreaterThan(2);
      expect(rejected).toBeGreaterThan(0); // this genuinely was a burst -- not everything could be served

      // Nothing here is genuine provider evidence: the endpoint was healthy (always answered in 80ms) throughout.
      expect(metrics.counters('rpc').failures).toBe(0);
      expect(metrics.counters('rpc').timeouts).toBe(0);
      expect(metrics.counters('rpc').networkErrors).toBe(0);
      expect(metrics.counters('rpc').circuitOpened).toBe(0);
      expect(metrics.counters('rpc').gateCapacityRejected).toBeGreaterThan(0);

      // Recovery: the burst has now been over for 500ms (well past every prior request's own 300ms budget) -- a
      // FRESH request must still be served promptly.
      expect(g.pending).toBe(0);
      const post = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(90);
      const postRes = await post;
      expect(postRes.status).toBe(200);
      expect(metrics.counters('rpc').circuitOpened).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('STARVATION REPRODUCTION (B): a CHAIN of truncated-window waiters -- freed slots keep getting reused cycle after cycle, never just discarded after the first, and a fresh request afterward still succeeds', async () => {
    vi.useFakeTimers();
    try {
      const calls = { n: 0 };
      // Deterministic, repeated version of test 5a: a slot-holder followed by ONE queued waiter that is granted its
      // slot with a truncated (sub-timeoutMs) budget and does not finish in time -- local_deadline, not a failure --
      // repeated 5 TIMES IN A ROW. Under the OLD acquire()-level near-deadline rejection, the waiter in every single
      // cycle would self-reject WITHOUT ever calling fetchImpl -- `calls.n` would stay at exactly the number of
      // holders (5) for the whole chain, i.e. the "next waiter" NEVER actually gets to use the slot the previous
      // one freed. Under the fix, every cycle's waiter genuinely dispatches (`calls.n` grows by 2 every cycle) --
      // proving freed capacity is reused cycle after cycle, not silently lost after the first rejection, and that
      // this holds however many times it repeats (no permanent lockup at any point in the chain).
      let callN = 0;
      const { gate: g, metrics } = gate({
        fetchImpl: (async (_url: string, init: { signal: AbortSignal }) => {
          callN += 1;
          calls.n = callN;
          if (callN % 2 === 1) return new Promise((resolve) => setTimeout(() => resolve(makeResponse(ok)), 250)); // the holder each cycle
          return new Promise((resolve, reject) => {
            // the waiter each cycle: granted ~50ms of truncated budget, needs 150ms -- would have comfortably
            // finished inside a FULL 200ms window, so it is our own truncation, not the endpoint, at fault.
            const t = setTimeout(() => resolve(makeResponse(ok)), 150);
            init.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            }, { once: true });
          });
        }) as unknown as FetchLike,
        maxConcurrent: 1,
        timeoutMs: 200,
        maxTotalMs: 300,
        maxRetries: 0,
        circuitFailureThreshold: 100, // isolate this test from circuit-breaker interaction entirely; nothing here should ever approach it anyway
        sleep: timedSleep,
        now: () => Date.now(),
      });

      const CYCLES = 5;
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        const holder = g.execute({ method: 'POST' });
        const waiter = g.execute({ method: 'POST' }).catch((e) => e);
        await vi.advanceTimersByTimeAsync(250);
        await holder;
        await vi.advanceTimersByTimeAsync(60);
        const err = await waiter;
        expect(err).toBeInstanceOf(ProviderError);
      }

      expect(calls.n).toBe(CYCLES * 2); // EVERY cycle's waiter genuinely dispatched -- capacity was reused every single time, not just the first
      expect(metrics.counters('rpc').failures).toBe(0); // none of the 5 truncated waiters was ever counted as a genuine failure
      expect(metrics.counters('rpc').timeouts).toBe(0);
      expect(metrics.counters('rpc').circuitOpened).toBe(0);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(CYCLES); // exactly the 5 truncated waiters, nothing more
      expect(metrics.counters('rpc').successes).toBe(CYCLES); // exactly the 5 holders

      // No permanent lockup at the end of the chain either: a fresh, unrelated request succeeds normally.
      expect(g.pending).toBe(0);
      const post = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(260);
      const postRes = await post;
      expect(postRes.status).toBe(200);
      expect(metrics.counters('rpc').circuitOpened).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
