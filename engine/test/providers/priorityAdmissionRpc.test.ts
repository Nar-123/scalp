import { describe, expect, it, vi } from 'vitest';
import { gate, makeResponse } from './helpers.js';
import { gateFetch, priorityGateFetch } from '../../src/providers/providerStack.js';
import { PriorityAdmissionGate } from '../../src/providers/priorityAdmissionGate.js';
import { FetchRateLimiter } from '../../src/discovery/fetchRateLimiter.js';
import type { FetchLike } from '../../src/providers/providerGate.js';

/**
 * Production integration test for the shared-RPC-capacity fix (Option A, `investigate/shared-rpc-capacity`).
 * Exercises the ACTUAL exported functions `providerStack.ts` wires into the two `Connection` instances
 * (`gateFetch` for the pre-fix shape, `priorityGateFetch` for the fix) end to end -- request body parsing,
 * `PriorityAdmissionGate` admission, `ProviderGate.execute()`, and the `Response` produced back -- not just the
 * admission class in isolation (see `priorityAdmissionGate.test.ts` for that).
 *
 * BASELINE reproduces the problem this fix addresses: with plain `gateFetch` (no admission layer), evaluation and
 * discovery share one `ProviderGate` with a priority-blind FIFO queue, so under sustained modest overload
 * discovery's contention measurably degrades evaluation's own success rate. The FIX test proves `priorityGateFetch`
 * eliminates that at the exact same offered load, against the exact same unmodified `ProviderGate` configuration
 * (same `maxConcurrent`/`maxRequestsPerSecond`/`timeoutMs`/`maxTotalMs` in both) -- this is the same calibration
 * used during the investigation phase (see that phase's report for why: a short window or extreme overload cannot
 * show the real mechanism at realistic capacity numbers).
 */
describe('priorityGateFetch (production fix): evaluation vs. discovery contention on the shared RPC gate', () => {
  function healthyFetch(latencyMs: number): FetchLike {
    return ((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(makeResponse({ status: 200 })), latencyMs);
        init.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        }, { once: true });
      });
    }) as unknown as FetchLike;
  }

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

  const TICK_MS = 100;
  const TICKS = 900; // 90000ms (90s) simulated -- long enough for sustained (not a brief burst) overload to matter; see investigation notes
  const GATE_OPTS = { maxConcurrent: 4, maxRequestsPerSecond: 8, timeoutMs: 4000, maxTotalMs: 8000, maxRetries: 2, circuitFailureThreshold: 5 } as const;
  const FETCH_LATENCY_MS = 200;
  const DRAIN_MS = GATE_OPTS.maxTotalMs + 500;
  const EVAL_SLOTS = 7; // evaluation offered 7 req/s
  const EVAL_ROUND_MS = 1000;

  function makeEvalSlots(count: number, roundMs: number, fetchFn: typeof fetch) {
    let attempts = 0;
    let successes = 0;
    const staggerMs = Math.max(1, Math.floor(roundMs / count));
    const nextFireAt = Array.from({ length: count }, (_, i) => i * staggerMs);
    const fireDueSlots = (simTimeMs: number): void => {
      for (let i = 0; i < count; i += 1) {
        if (simTimeMs >= nextFireAt[i]!) {
          nextFireAt[i] = simTimeMs + roundMs;
          attempts += 1;
          void fetchFn('https://primary.example', { method: 'POST', body: '{"method":"getTokenLargestAccounts"}' })
            .then(() => { successes += 1; })
            .catch(() => undefined);
        }
      }
    };
    return { fireDueSlots, get attempts() { return attempts; }, get successes() { return successes; } };
  }

  /** Raydium + Pump.fun, each capped at 1/s via the REAL, unmodified production FetchRateLimiter, firing every simulated second. */
  function makeDiscoverySources(fetchFn: typeof fetch) {
    const raydiumLimiter = new FetchRateLimiter(1);
    const pumpfunLimiter = new FetchRateLimiter(1);
    let offered = 0;
    let dispatched = 0;
    const fireTick = (): void => {
      for (const limiter of [raydiumLimiter, pumpfunLimiter]) {
        offered += 1;
        if (limiter.allow()) {
          dispatched += 1;
          void fetchFn('https://primary.example', { method: 'POST', body: '{"method":"getParsedTransaction"}' }).catch(() => undefined);
        }
      }
    };
    return { fireTick, get offered() { return offered; }, get dispatched() { return dispatched; } };
  }

  async function runScenario(fetchForEval: typeof fetch, fetchForDiscovery: typeof fetch) {
    const evalSlots = makeEvalSlots(EVAL_SLOTS, EVAL_ROUND_MS, fetchForEval);
    const discovery = makeDiscoverySources(fetchForDiscovery);
    let simTime = 0;
    for (let tick = 0; tick < TICKS; tick += 1) {
      evalSlots.fireDueSlots(simTime);
      if (simTime % 1000 < TICK_MS) discovery.fireTick();
      await vi.advanceTimersByTimeAsync(TICK_MS);
      simTime += TICK_MS;
    }
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    return { evalSlots, discovery };
  }

  it('BASELINE (plain gateFetch, no admission layer): evaluation is measurably degraded by discovery contention', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g, metrics } = gate({ fetchImpl: healthyFetch(FETCH_LATENCY_MS), ...GATE_OPTS, sleep: timedSleep, now: () => Date.now() });
      const sharedFetch = gateFetch(g); // the SAME fetch instance for both callers -- exactly the pre-fix wiring (one Connection, no priority)
      const { evalSlots } = await runScenario(sharedFetch, sharedFetch);
      const rpc = metrics.counters('rpc');
      console.log('BASELINE (production gateFetch) RESULT', { evalAttempts: evalSlots.attempts, evalSuccesses: evalSlots.successes, evalSuccessRate: evalSlots.successes / evalSlots.attempts, gateCapacityRejected: rpc.gateCapacityRejected, failures: rpc.failures, circuitOpened: rpc.circuitOpened });

      expect(rpc.failures).toBe(0); // PR #5's guarantee holds regardless
      expect(rpc.circuitOpened).toBe(0);
      expect(rpc.gateCapacityRejected).toBeGreaterThan(0); // contention genuinely happened
      expect(evalSlots.successes / evalSlots.attempts).toBeLessThan(0.95); // evaluation is NOT protected pre-fix
    } finally {
      vi.useRealTimers();
    }
  });

  it('FIX (priorityGateFetch, evaluation=high / discovery=low): evaluation is fully protected at the identical offered load', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g, metrics } = gate({ fetchImpl: healthyFetch(FETCH_LATENCY_MS), ...GATE_OPTS, sleep: timedSleep, now: () => Date.now() });
      const admission = new PriorityAdmissionGate(GATE_OPTS.maxConcurrent); // sized to the gate's own maxConcurrent, exactly as providerStack.ts does
      const evalFetch = priorityGateFetch(g, admission, 'high');
      const discoveryFetch = priorityGateFetch(g, admission, 'low');
      const { evalSlots, discovery } = await runScenario(evalFetch, discoveryFetch);
      const rpc = metrics.counters('rpc');
      console.log('FIX (production priorityGateFetch) RESULT', { evalAttempts: evalSlots.attempts, evalSuccesses: evalSlots.successes, evalSuccessRate: evalSlots.successes / evalSlots.attempts, discoveryOffered: discovery.offered, discoveryDispatched: discovery.dispatched, gateCapacityRejected: rpc.gateCapacityRejected, failures: rpc.failures, circuitOpened: rpc.circuitOpened });

      expect(rpc.failures).toBe(0);
      expect(rpc.circuitOpened).toBe(0);
      expect(rpc.gateCapacityRejected).toBe(0);
      expect(evalSlots.successes / evalSlots.attempts).toBeGreaterThan(0.99); // fully protected
      expect(discovery.dispatched).toBeGreaterThan(0); // discovery is still served, not starved to zero
    } finally {
      vi.useRealTimers();
    }
  });
});
