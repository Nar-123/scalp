import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { PumpFunLogSubscriber } from '../../src/discovery/pumpFunLogSubscriber.js';

const PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** Own-program log lines that make `mightBeCreation()` true (see programLogs.ts's invoke-stack attribution). */
function creationLogs(): string[] {
  return [`Program ${PROGRAM_ID} invoke [1]`, 'Program log: Instruction: CreateV2', `Program ${PROGRAM_ID} success`];
}

/** Logs that do NOT match any creation marker -- `mightBeCreation()` is false, so no throttle budget is spent. */
function nonCreationLogs(): string[] {
  return [`Program ${PROGRAM_ID} invoke [1]`, 'Program log: Instruction: Buy', `Program ${PROGRAM_ID} success`];
}

type LogsCallback = (logs: { signature: string; err: unknown; logs: string[] }, ctx: { slot: number }) => void;

/** A minimal fake `Connection`: captures the `onLogs` callback and counts/delays `getParsedTransaction` calls. */
function fakeConnection(opts: { latencyMs?: number; result?: unknown } = {}) {
  let callback: LogsCallback | null = null;
  const calls: string[] = [];
  const inFlight: Array<Promise<unknown>> = [];
  const connection = {
    onLogs: (_pk: unknown, cb: LogsCallback) => {
      callback = cb;
      return 1;
    },
    removeOnLogsListener: vi.fn(async () => undefined),
    getParsedTransaction: (signature: string) => {
      calls.push(signature);
      const p = new Promise((resolve) => setTimeout(() => resolve(opts.result ?? null), opts.latencyMs ?? 0));
      inFlight.push(p);
      return p;
    },
  } as unknown as Connection;
  const fire = (signature: string, logs: string[]): void => callback!({ signature, err: null, logs }, { slot: 1 });
  return { connection, calls, inFlight, fire };
}

describe('PumpFunLogSubscriber: caller-side RPC fetch throttle (discovery RPC capacity freeze fix)', () => {
  it('1. sustained creation events: at most 1 getParsedTransaction call per second by default, matching Raydium\'s own default exactly', async () => {
    vi.useFakeTimers();
    try {
      const { connection, calls, fire } = fakeConnection();
      const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID }, undefined);
      await sub.start(() => undefined);

      // 10 creation-shaped events, one per 100ms (sustained, not a single burst), over 1 second.
      for (let i = 0; i < 10; i += 1) {
        fire(`sig${i}`, creationLogs());
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(calls.length).toBeLessThanOrEqual(1); // the fixed 1s window this all fell inside allows at most 1
    } finally {
      vi.useRealTimers();
    }
  });

  it('2. BURST: a large simultaneous burst of Pump.fun creation logs is bounded -- actual RPC calls stay capped, no unbounded pending-promise growth', async () => {
    const { connection, calls, inFlight, fire } = fakeConnection({ latencyMs: 50 });
    const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID }, undefined);
    await sub.start(() => undefined);

    // 500 creation-shaped events fired synchronously, all in the same instant -- the exact fire-and-forget shape of
    // `void this.handleLogs(...)` under a real burst of pump.fun activity.
    for (let i = 0; i < 500; i += 1) fire(`sig${i}`, creationLogs());

    // The throttle is checked SYNCHRONOUSLY before any RPC call is dispatched -- so immediately after firing all
    // 500 (no timers advanced at all yet), at most 1 has actually started, and no more than 1 promise is pending.
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(inFlight.length).toBeLessThanOrEqual(1);
    await Promise.all(inFlight); // let it resolve so nothing dangles
  });

  it('3. a throttle-rejected event is DROPPED, not retried or re-enqueued: it never triggers a later getParsedTransaction call on its own', async () => {
    vi.useFakeTimers();
    try {
      const { connection, calls, fire } = fakeConnection();
      const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID }, undefined);
      await sub.start(() => undefined);

      fire('sig-first', creationLogs()); // consumes the only slot in this window
      fire('sig-dropped', creationLogs()); // rejected by the throttle -- must be dropped, not queued

      expect(calls).toEqual(['sig-first']);
      await vi.advanceTimersByTimeAsync(5000); // even after several more windows elapse, the dropped one never fires on its own
      expect(calls).toEqual(['sig-first']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. events that do not match a creation marker never consume throttle budget (cheap pre-filter still runs first)', async () => {
    vi.useFakeTimers();
    try {
      const { connection, calls, fire } = fakeConnection();
      const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID }, undefined);
      await sub.start(() => undefined);

      for (let i = 0; i < 20; i += 1) fire(`noncreate${i}`, nonCreationLogs()); // none of these should ever reach the RPC call
      fire('real-creation', creationLogs()); // the throttle budget is still fully available for a genuine creation

      expect(calls).toEqual(['real-creation']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('5. the log tap still sees EVERY notification, including ones the throttle later drops (tap fires before handleLogs, unaffected by this change)', async () => {
    vi.useFakeTimers();
    try {
      const { connection, fire } = fakeConnection();
      const seen: string[] = [];
      const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID, logTap: (e) => seen.push(e.signature) }, undefined);
      await sub.start(() => undefined);

      fire('sig-a', creationLogs());
      fire('sig-b', creationLogs()); // throttle-dropped for RPC purposes, but the tap must still see it
      expect(seen).toEqual(['sig-a', 'sig-b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('6. a configured maxFetchesPerSecond other than the default is honored', async () => {
    vi.useFakeTimers();
    try {
      const { connection, calls, fire } = fakeConnection();
      const sub = new PumpFunLogSubscriber(connection, { programId: PROGRAM_ID, maxFetchesPerSecond: 3 }, undefined);
      await sub.start(() => undefined);

      for (let i = 0; i < 10; i += 1) fire(`sig${i}`, creationLogs());
      expect(calls.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
