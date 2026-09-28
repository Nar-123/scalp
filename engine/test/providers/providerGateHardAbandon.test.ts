import { describe, expect, it, vi } from 'vitest';
import { gate, makeResponse } from './helpers.js';
import { PriorityAdmissionGate } from '../../src/providers/priorityAdmissionGate.js';
import { EvaluationScheduler } from '../../src/orchestrator/evaluationScheduler.js';
import type { FetchLike } from '../../src/providers/providerGate.js';

/**
 * Regression suite for the P3 fix (`fix/hard-abandon-fetch-boundary`, following `investigate/first-hung-evaluation`):
 * `ProviderGate.execute()` must ALWAYS settle, even if `fetchImpl` never observes its `AbortSignal` -- a secondary,
 * independent hard boundary (`HARD_ABANDON_GRACE_MS` past the normal per-attempt timeout) forces the attempt to a
 * conclusion regardless of what the real fetch call ever does. See `providerGate.ts`'s own comments at the
 * `hardAbandon`/`HardAbandonSentinel` definitions for the full design rationale.
 *
 * All tests here use fake timers: the fix's extra grace period is a fixed constant (2000ms), and running every
 * scenario against real timers would make this suite slow without adding any determinism.
 */
describe('ProviderGate: secondary hard-abandon boundary for a non-cooperating fetchImpl', () => {
  function cooperatingHang(): FetchLike {
    // Never resolves on its own, but DOES reject promptly once told to abort -- the well-behaved case.
    return ((_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))) as unknown as FetchLike;
  }

  function nonCooperating(): FetchLike {
    // Never resolves, never rejects, and never even looks at init.signal -- the pathological case this fix exists for.
    return (() => new Promise(() => undefined)) as unknown as FetchLike;
  }

  it('1. normal fetch (200 OK): settles immediately, hard boundary never engages, fetchAbandoned stays 0', async () => {
    vi.useFakeTimers();
    try {
      const f: FetchLike = () => Promise.resolve(makeResponse({ status: 200, body: '{"ok":true}' }));
      const { gate: g, metrics } = gate({ fetchImpl: f, timeoutMs: 200, maxTotalMs: 2000 });
      const res = await g.execute({ method: 'POST' });
      expect(res.status).toBe(200);
      expect(metrics.counters('rpc').fetchAbandoned).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2. abort-cooperating fetch (genuine timeout): settles via the EXISTING timeout path, unaffected by the fix, fetchAbandoned stays 0', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g, metrics } = gate({ fetchImpl: cooperatingHang(), timeoutMs: 200, maxTotalMs: 2000, maxRetries: 0 });
      const p = g.execute({ method: 'POST' }).catch((err) => err);
      await vi.advanceTimersByTimeAsync(300); // past timeoutMs, comfortably before HARD_ABANDON_GRACE_MS would add anything
      const err = await p;
      expect(err.reason).toBe('timeout'); // the EXACT existing classification, unchanged
      const rpc = metrics.counters('rpc');
      expect(rpc.timeouts).toBe(1);
      expect(rpc.fetchAbandoned).toBe(0); // the hard boundary never had to fire -- the fetch cooperated
    } finally {
      vi.useRealTimers();
    }
  });

  it('3. abort-IGNORING fetch: execute() now settles (rejects) via the hard boundary instead of hanging forever, and fetchAbandoned increments', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g, metrics } = gate({ fetchImpl: nonCooperating(), timeoutMs: 200, maxTotalMs: 2000, maxRetries: 0 });
      let settledAs: 'resolved' | 'rejected' | null = null;
      let err: unknown;
      const p = g.execute({ method: 'POST' }).then(
        () => { settledAs = 'resolved'; },
        (e) => { settledAs = 'rejected'; err = e; },
      );
      await vi.advanceTimersByTimeAsync(200 + 2000 + 100); // timeoutMs + HARD_ABANDON_GRACE_MS + margin
      await p;
      expect(settledAs).toBe('rejected'); // THE fix: it settles at all, instead of hanging forever
      expect((err as { reason?: string }).reason).toBe('timeout'); // judged exactly like a fair, non-truncated timeout
      const rpc = metrics.counters('rpc');
      expect(rpc.fetchAbandoned).toBe(1); // the operational signal fired exactly once
      expect(rpc.timeouts).toBe(1);
      expect(rpc.failures).toBe(1);
      expect(rpc.circuitOpened).toBe(0); // a single abandonment must not itself be enough to open the circuit
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. retry behavior preserved: a hard-abandoned attempt still counts toward maxRetries/backoff, and a later attempt that DOES respond still succeeds', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const f: FetchLike = (() => {
        call += 1;
        if (call === 1) return new Promise(() => undefined); // first attempt: never cooperates
        return Promise.resolve(makeResponse({ status: 200, body: '{"ok":true}' })); // second attempt: healthy
      }) as unknown as FetchLike;
      const { gate: g, metrics } = gate({ fetchImpl: f, timeoutMs: 200, maxTotalMs: 5000, maxRetries: 2, baseBackoffMs: 10, maxBackoffMs: 10 });
      const p = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(200 + 2000 + 100); // let attempt 1 hard-abandon
      await vi.advanceTimersByTimeAsync(50); // backoff delay before attempt 2
      const res = await p;
      expect(res.status).toBe(200); // the logical request still succeeded, via retry, exactly as designed
      expect(call).toBe(2);
      const rpc = metrics.counters('rpc');
      expect(rpc.fetchAbandoned).toBe(1);
      expect(rpc.retries).toBe(1);
      expect(rpc.successes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('4b. fetchAbandoned increments exactly once PER abandonment, correctly accumulating across multiple abandonments within one logical request', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const f: FetchLike = (() => {
        call += 1;
        if (call <= 2) return new Promise(() => undefined); // first AND second attempts both never cooperate
        return Promise.resolve(makeResponse({ status: 200, body: '{"ok":true}' })); // third attempt: healthy
      }) as unknown as FetchLike;
      const { gate: g, metrics } = gate({ fetchImpl: f, timeoutMs: 200, maxTotalMs: 20_000, maxRetries: 3, baseBackoffMs: 10, maxBackoffMs: 10 });
      const p = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(200 + 2000 + 100); // attempt 1 hard-abandons
      await vi.advanceTimersByTimeAsync(50); // backoff before attempt 2
      expect(metrics.counters('rpc').fetchAbandoned).toBe(1); // exactly one so far, not zero, not two
      await vi.advanceTimersByTimeAsync(200 + 2000 + 100); // attempt 2 ALSO hard-abandons
      await vi.advanceTimersByTimeAsync(50); // backoff before attempt 3
      const res = await p;
      expect(res.status).toBe(200);
      expect(call).toBe(3);
      const rpc = metrics.counters('rpc');
      expect(rpc.fetchAbandoned).toBe(2); // accumulated correctly: one increment per abandonment, not per logical request
      expect(rpc.retries).toBe(2);
      expect(rpc.successes).toBe(1); // the one eventual success is not double-counted either
    } finally {
      vi.useRealTimers();
    }
  });

  it('5. concurrent requests: one hung request never blocks a healthy concurrent request, and the freed slot is reused once abandoned', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const mixed: FetchLike = (() => {
        call += 1;
        if (call === 1) return new Promise(() => undefined); // first (issued first, below) never cooperates
        return Promise.resolve(makeResponse({ status: 200, body: '{}' }));
      }) as unknown as FetchLike;
      const { gate: g, metrics } = gate({ fetchImpl: mixed, timeoutMs: 200, maxTotalMs: 5000, maxRetries: 0, maxConcurrent: 1 });

      // The hung request (dispatched first) occupies the ONE concurrency slot.
      const hungPromise = g.execute({ method: 'POST' }).catch((e) => e);
      await Promise.resolve();

      // A healthy request queues behind it (maxConcurrent: 1) and must NOT be starved forever.
      const healthyPromise = g.execute({ method: 'POST' });
      await vi.advanceTimersByTimeAsync(200 + 2000 + 100); // the hung one hard-abandons, freeing its slot
      const healthyResult = await healthyPromise;
      expect(healthyResult.status).toBe(200); // it got its turn once the slot was reclaimed
      await hungPromise; // let the hung one settle too, for cleanliness
      expect(metrics.counters('rpc').fetchAbandoned).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('6. PriorityAdmissionGate release: a hard-abandoned execute() still releases its admission ticket, unblocking a queued caller', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g } = gate({ fetchImpl: nonCooperating(), timeoutMs: 200, maxTotalMs: 2000, maxRetries: 0, maxConcurrent: 1 });
      const admission = new PriorityAdmissionGate(1);

      const stuckResult = admission.run('high', () => g.execute({ method: 'POST' })).catch(() => undefined);
      await Promise.resolve();
      expect(admission.activeCount).toBe(1);

      let queuedRan = false;
      const queuedResult = admission.run('low', async () => { queuedRan = true; });
      await Promise.resolve();
      expect(queuedRan).toBe(false); // correctly queued, not yet admitted

      await vi.advanceTimersByTimeAsync(200 + 2000 + 100); // past the hard boundary
      await stuckResult;
      await queuedResult;
      expect(queuedRan).toBe(true); // THE fix, one layer up: the admission ticket was released, not leaked forever
      expect(admission.activeCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('7. EvaluationScheduler recovery: a scheduler slot held by a hard-abandoned dispatch is reclaimed, and a queued healthy dispatch runs', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g } = gate({ fetchImpl: nonCooperating(), timeoutMs: 200, maxTotalMs: 2000, maxRetries: 0 });
      const scheduler = new EvaluationScheduler({ maxConcurrent: 1 });

      scheduler.requestTick('stuck', () => g.execute({ method: 'POST' }).then(() => undefined, () => undefined));
      await Promise.resolve();
      expect(scheduler.activeCount).toBe(1);

      let healthyRan = false;
      scheduler.requestTick('healthy', async () => { healthyRan = true; });
      expect(scheduler.isPending('healthy')).toBe(true);

      await vi.advanceTimersByTimeAsync(200 + 2000 + 100);
      expect(healthyRan).toBe(true); // THE fix, two layers up: the scheduler slot was reclaimed, not leaked forever
      expect(scheduler.activeCount).toBe(0);
      expect(scheduler.pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('8. shutdown: gate.shutdown() while a non-cooperating fetch is in flight still lets execute() settle (via the hard boundary), never hangs', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g } = gate({ fetchImpl: nonCooperating(), timeoutMs: 200, maxTotalMs: 5000, maxRetries: 0 });
      let settled = false;
      const p = g.execute({ method: 'POST' }).then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      g.shutdown();
      // `shutdown()` aborts the signal exactly like a normal timeout would -- it cannot force a non-cooperating
      // fetchImpl to stop any more than the per-attempt timer can. The guarantee shutdown adds is that no OTHER
      // request may start; THIS one still needs the same hard-abandon grace period to conclude.
      await vi.advanceTimersByTimeAsync(200 + 2000 + 100);
      await p;
      expect(settled).toBe(true); // still settles, never hangs, even mid-shutdown
    } finally {
      vi.useRealTimers();
    }
  });

  it('9. no double-release / no unhandled rejection: the abandoned fetch settling LATE (after the attempt already concluded) changes nothing', async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      let resolveLate: (() => void) | undefined;
      const f: FetchLike = (() => {
        call += 1;
        if (call === 1) return new Promise((resolve) => { resolveLate = () => resolve(makeResponse({ status: 200, body: '{}' })); });
        return Promise.resolve(makeResponse({ status: 200, body: '{}' })); // every later call is healthy and immediate
      }) as unknown as FetchLike;
      const { gate: g, metrics } = gate({ fetchImpl: f, timeoutMs: 200, maxTotalMs: 5000, maxRetries: 0, maxConcurrent: 2 });

      const p = g.execute({ method: 'POST' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(200 + 2000 + 100);
      const err = await p;
      expect(err.reason).toBe('timeout');
      const rpcAfterAbandon = metrics.counters('rpc');
      expect(rpcAfterAbandon.fetchAbandoned).toBe(1);
      expect(rpcAfterAbandon.successes).toBe(0); // not yet -- the orphaned fetch hasn't resolved yet

      // A second, independent request must be able to use the concurrency slot the first one released.
      const second = await g.execute({ method: 'POST' });
      expect(second.status).toBe(200);

      // NOW the orphaned first fetch finally resolves, long after its own attempt already concluded.
      resolveLate?.();
      await vi.advanceTimersByTimeAsync(10);
      // It must be silently swallowed: no crash, no unhandled rejection (vitest would fail the run on one), and
      // critically no DOUBLE counting of successes/failures for an attempt that was already classified and released.
      const rpcFinal = metrics.counters('rpc');
      expect(rpcFinal.fetchAbandoned).toBe(1); // unchanged
      expect(rpcFinal.timeouts).toBe(1); // unchanged -- the late resolution must not retroactively "undo" the timeout classification
    } finally {
      vi.useRealTimers();
    }
  });
});
