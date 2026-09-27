import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { gate, makeResponse } from './helpers.js';
import { PumpFunLogSubscriber } from '../../src/discovery/pumpFunLogSubscriber.js';
import type { FetchLike } from '../../src/providers/providerGate.js';

/**
 * FRESH REPRODUCTION, post-fix: exercises a REAL `PumpFunLogSubscriber` (not a conceptual model of one) whose
 * `getParsedTransaction` calls are wired through the SAME shared `ProviderGate` as simulated "evaluation" calls --
 * isolating PR #6's Pump.fun throttle specifically, deliberately WITHOUT the later `PriorityAdmissionGate` fix
 * (`fix/priority-admission-rpc`) in the way: discovery and evaluation both call `gate.execute()` directly here,
 * exactly as production wired it BEFORE that later fix (`providerStack.ts`'s single `connection`/`gateFetch
 * (rpcGate)`, shared by `DirectSafetyDataSource` and both discovery subscribers). Production no longer wires it
 * this way -- see `priorityAdmissionRpc.test.ts` for a reproduction against the CURRENT wiring (two `Connection`s,
 * `priorityGateFetch`, admission-layer priority). This file still isolates PR #6's own throttle correctly because
 * that throttle's job (bounding discovery's OWN offered rate) is unaffected by which layer sits above the gate.
 */
describe('FRESH REPRODUCTION (post-fix): a real PumpFunLogSubscriber, throttled vs. unthrottled, sharing the evaluation RPC gate', () => {
  const PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

  function creationLogs(): string[] {
    return [`Program ${PROGRAM_ID} invoke [1]`, 'Program log: Instruction: CreateV2', `Program ${PROGRAM_ID} success`];
  }

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

  /** A fake `Connection` whose `getParsedTransaction` is routed through the SAME shared gate -- exactly what `gateFetch(rpcGate)` did for the real `Connection` in `providerStack.ts` before the priority-admission fix (see the file-level comment above). */
  function connectionRoutedThroughGate(g: { execute: (req: { method: 'POST' }) => Promise<unknown> }) {
    let onLogsCb: ((logs: { signature: string; err: unknown; logs: string[] }, ctx: { slot: number }) => void) | null = null;
    const discoveryFetchCount = { n: 0 };
    const connection = {
      onLogs: (_pk: unknown, cb: typeof onLogsCb) => {
        onLogsCb = cb;
        return 1;
      },
      removeOnLogsListener: async () => undefined,
      getParsedTransaction: async (_signature: string) => {
        discoveryFetchCount.n += 1;
        await g.execute({ method: 'POST' }).catch(() => undefined);
        return null; // detectPumpFunCreation would reject a null tx anyway -- irrelevant to this test's metrics
      },
    } as unknown as Connection;
    const fire = (signature: string): void => onLogsCb!({ signature, err: null, logs: creationLogs() }, { slot: 1 });
    return { connection, fire, discoveryFetchCount };
  }

  const EVAL_ROUND_MS = 600; // 4 slots / 600ms ~= 6.67/sec combined, safely under maxRequestsPerSecond=8
  function makeEvalSlots(g: { execute: (req: { method: 'POST' }) => Promise<unknown> }) {
    let evalAttempts = 0;
    let evalSuccesses = 0;
    const STAGGER_MS = 150;
    const nextFireAt = [0, STAGGER_MS, STAGGER_MS * 2, STAGGER_MS * 3];
    const fireDueSlots = (simTimeMs: number): void => {
      for (let i = 0; i < 4; i += 1) {
        if (simTimeMs >= nextFireAt[i]!) {
          nextFireAt[i] = simTimeMs + EVAL_ROUND_MS;
          evalAttempts += 1;
          void g.execute({ method: 'POST' }).then(() => { evalSuccesses += 1; }).catch(() => undefined);
        }
      }
    };
    return { fireDueSlots, get evalAttempts() { return evalAttempts; }, get evalSuccesses() { return evalSuccesses; } };
  }

  const TICK_MS = 20;
  const TICKS = 100; // 2000ms simulated window

  it('CONTROL: evaluation only, no discovery at all', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g, metrics } = gate({
        fetchImpl: healthyFetch(50),
        maxConcurrent: 4,
        maxRequestsPerSecond: 8,
        timeoutMs: 100,
        maxTotalMs: 300,
        maxRetries: 2,
        circuitFailureThreshold: 5,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      const evalSlots = makeEvalSlots(g);
      let simTime = 0;
      for (let tick = 0; tick < TICKS; tick += 1) {
        evalSlots.fireDueSlots(simTime);
        await vi.advanceTimersByTimeAsync(TICK_MS);
        simTime += TICK_MS;
      }
      await vi.advanceTimersByTimeAsync(500);

      expect(evalSlots.evalSuccesses).toBe(evalSlots.evalAttempts);
      expect(metrics.counters('rpc').gateCapacityRejected).toBe(0);
      expect(metrics.counters('rpc').failures).toBe(0);
      expect(metrics.counters('rpc').circuitOpened).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('PUMPFUN UNTHROTTLED (maxFetchesPerSecond set absurdly high, simulating "no effective throttle"): reproduces the old collapse', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g, metrics } = gate({
        fetchImpl: healthyFetch(50),
        maxConcurrent: 4,
        maxRequestsPerSecond: 8,
        timeoutMs: 100,
        maxTotalMs: 300,
        maxRetries: 2,
        circuitFailureThreshold: 5,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      const evalSlots = makeEvalSlots(g);
      const { connection, fire, discoveryFetchCount } = connectionRoutedThroughGate(g);
      const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID, maxFetchesPerSecond: 1_000_000 }, undefined);
      await sub.start(() => undefined);

      let simTime = 0;
      for (let tick = 0; tick < TICKS; tick += 1) {
        evalSlots.fireDueSlots(simTime);
        fire(`sig-${tick}`); // matches pump.fun's real, un-throttled fire-and-forget shape
        fire(`sig-${tick}-b`);
        await vi.advanceTimersByTimeAsync(TICK_MS);
        simTime += TICK_MS;
      }
      await vi.advanceTimersByTimeAsync(500);

      const rpc = metrics.counters('rpc');

      console.log('UNTHROTTLED RESULT', { evalAttempts: evalSlots.evalAttempts, evalSuccesses: evalSlots.evalSuccesses, discoveryFetches: discoveryFetchCount.n, gateCapacityRejected: rpc.gateCapacityRejected, failures: rpc.failures, circuitOpened: rpc.circuitOpened });

      expect(evalSlots.evalSuccesses).toBeLessThan(evalSlots.evalAttempts / 2); // evaluation collapses, matching the old bug
      expect(rpc.failures).toBe(0); // still never a genuine failure -- PR #5 holds
      expect(rpc.circuitOpened).toBe(0);
      expect(rpc.gateCapacityRejected).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('PUMPFUN THROTTLED (default, 1/s): evaluation remains healthy, discovery fetches are visibly capped', async () => {
    vi.useFakeTimers();
    try {
      const { gate: g, metrics } = gate({
        fetchImpl: healthyFetch(50),
        maxConcurrent: 4,
        maxRequestsPerSecond: 8,
        timeoutMs: 100,
        maxTotalMs: 300,
        maxRetries: 2,
        circuitFailureThreshold: 5,
        sleep: timedSleep,
        now: () => Date.now(),
      });
      const evalSlots = makeEvalSlots(g);
      const { connection, fire, discoveryFetchCount } = connectionRoutedThroughGate(g);
      const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID }, undefined); // default: 1/s
      await sub.start(() => undefined);

      let simTime = 0;
      for (let tick = 0; tick < TICKS; tick += 1) {
        evalSlots.fireDueSlots(simTime);
        fire(`sig-${tick}`);
        fire(`sig-${tick}-b`);
        await vi.advanceTimersByTimeAsync(TICK_MS);
        simTime += TICK_MS;
      }
      await vi.advanceTimersByTimeAsync(500);

      const rpc = metrics.counters('rpc');

      console.log('THROTTLED RESULT', { evalAttempts: evalSlots.evalAttempts, evalSuccesses: evalSlots.evalSuccesses, discoveryFetches: discoveryFetchCount.n, gateCapacityRejected: rpc.gateCapacityRejected, failures: rpc.failures, circuitOpened: rpc.circuitOpened });

      // Evaluation throughput is essentially unaffected -- the core fix proof.
      expect(evalSlots.evalSuccesses).toBeGreaterThanOrEqual(evalSlots.evalAttempts - 2);
      // Discovery fetches are visibly capped: 2000ms window at 1/s allows at most ~3 windows' worth (2-3), NOT the
      // ~200 fire-and-forget events offered.
      expect(discoveryFetchCount.n).toBeLessThanOrEqual(4);
      expect(rpc.failures).toBe(0);
      expect(rpc.circuitOpened).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
