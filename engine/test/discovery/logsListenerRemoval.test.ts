import { describe, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { logsSocketReadyState, removeLogsListenerIfSafe } from '../../src/discovery/logsListenerRemoval.js';
import { PumpFunLogSubscriber } from '../../src/discovery/pumpFunLogSubscriber.js';
import { RaydiumLogSubscriber } from '../../src/discovery/raydiumLogSubscriber.js';

/**
 * Guards the second link of the 2026-10-06 failure: a shutdown that called removeOnLogsListener() on a websocket
 * already CLOSING made web3.js 1.99 retry the unsubscribe in an unbounded microtask loop (631,981 error lines, heap
 * 36 MB -> 1.85 GB, SIGABRT). The standalone reproduction against the real library is ops/tests/web3-unsub-loop-repro.mjs.
 */
function fakeConn(readyState?: number) {
  const removeOnLogsListener = vi.fn(async () => undefined);
  const base = { onLogs: () => 7, removeOnLogsListener } as Record<string, unknown>;
  if (readyState !== undefined) base._rpcWebSocket = { socket: { readyState } };
  return { connection: base as unknown as Connection, removeOnLogsListener };
}
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe('removeLogsListenerIfSafe', () => {
  it.each([2, 3])('skips the unsubscribe (and says so) when the websocket is CLOSING/CLOSED (readyState %i)', async (state) => {
    const { connection, removeOnLogsListener } = fakeConn(state);
    const log = logger();
    await removeLogsListenerIfSafe(connection, 7, log as never, 'pumpfun');
    expect(removeOnLogsListener).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).toContain('closing/closed');
  });

  it.each([0, 1])('still unsubscribes when the socket is CONNECTING/OPEN (readyState %i): normal shutdown is unchanged', async (state) => {
    const { connection, removeOnLogsListener } = fakeConn(state);
    await removeLogsListenerIfSafe(connection, 7);
    expect(removeOnLogsListener).toHaveBeenCalledWith(7);
  });

  it('behaves exactly as before when the connection has no recognisable websocket (fakes, other library versions)', async () => {
    const { connection, removeOnLogsListener } = fakeConn(undefined);
    expect(logsSocketReadyState(connection)).toBeNull();
    await removeLogsListenerIfSafe(connection, 7);
    expect(removeOnLogsListener).toHaveBeenCalledWith(7);
  });

  it('both discovery sources use it in stop(): a dead socket never reaches removeOnLogsListener, shutdown still completes', async () => {
    for (const make of [
      (c: Connection) => new PumpFunLogSubscriber(c, { programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' }, undefined),
      (c: Connection) => new RaydiumLogSubscriber(c, { programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' }, undefined),
    ]) {
      const { connection, removeOnLogsListener } = fakeConn(2);
      const sub = make(connection);
      await sub.start(() => undefined);
      await expect(sub.stop()).resolves.toBeUndefined();
      expect(removeOnLogsListener).not.toHaveBeenCalled();
    }
  });
});
