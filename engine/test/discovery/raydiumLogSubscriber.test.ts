import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { RaydiumLogSubscriber } from '../../src/discovery/raydiumLogSubscriber.js';
import { RAYDIUM_AMM_V4_PROGRAM_ID } from '../../src/discovery/creationDetector.js';

type LogsCallback = (logs: { signature: string; err: unknown; logs: string[] }) => void;

function fakeConnection() {
  let callback: LogsCallback | null = null;
  const calls: string[] = [];
  const connection = {
    onLogs: (_pk: unknown, cb: LogsCallback) => {
      callback = cb;
      return 1;
    },
    removeOnLogsListener: vi.fn(async () => undefined),
    getParsedTransaction: (signature: string) => {
      calls.push(signature);
      return Promise.resolve(null);
    },
  } as unknown as Connection;
  const fire = (signature: string): void => callback!({ signature, err: null, logs: [] });
  return { connection, calls, fire };
}

/**
 * Locks in `RaydiumLogSubscriber`'s pre-existing throttle behavior (1/s default) after it was refactored to use
 * the shared `FetchRateLimiter` (extracted for reuse by `PumpFunLogSubscriber` -- the discovery RPC capacity
 * freeze fix). No prior dedicated unit test existed for this class; this file exists specifically to prove the
 * refactor changed nothing observable.
 */
describe('RaydiumLogSubscriber: fetch throttle behavior is unchanged after the FetchRateLimiter extraction', () => {
  it('allows at most 1 getParsedTransaction call per second by default', async () => {
    vi.useFakeTimers();
    try {
      const { connection, calls, fire } = fakeConnection();
      const sub = new RaydiumLogSubscriber(connection, { programId: RAYDIUM_AMM_V4_PROGRAM_ID }, undefined);
      await sub.start(() => undefined);

      fire('sig-1');
      fire('sig-2'); // same window -- throttled, dropped
      expect(calls).toEqual(['sig-1']);

      await vi.advanceTimersByTimeAsync(1000);
      fire('sig-3'); // new window
      expect(calls).toEqual(['sig-1', 'sig-3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a configured maxFetchesPerSecond is honored, exactly as before', async () => {
    const { connection, calls, fire } = fakeConnection();
    const sub = new RaydiumLogSubscriber(connection, { programId: RAYDIUM_AMM_V4_PROGRAM_ID, maxFetchesPerSecond: 2 }, undefined);
    await sub.start(() => undefined);

    fire('a');
    fire('b');
    fire('c');
    expect(calls).toEqual(['a', 'b']);
  });
});
