import type { Connection } from '@solana/web3.js';
import type { Logger } from '../logging/logger.js';

const WS_CLOSING = 2;
const WS_CLOSED = 3;

/**
 * The websocket's readyState as seen through web3.js' (private) rpc-websockets client, or null when the shape is not
 * the one we know (then callers behave exactly as before).
 */
export function logsSocketReadyState(connection: Connection): number | null {
  const sock = (connection as unknown as { _rpcWebSocket?: { socket?: { readyState?: unknown } } })._rpcWebSocket?.socket;
  return typeof sock?.readyState === 'number' ? sock.readyState : null;
}

/**
 * `connection.removeOnLogsListener(id)` -- unless the websocket is already CLOSING/CLOSED.
 *
 * Why: @solana/web3.js 1.99's subscription state machine, when the unsubscribe RPC fails, logs the error, puts the
 * subscription back to "subscribed" and immediately calls `_updateSubscriptions()` again (its own source carries a
 * "TODO: Maybe add an 'errored' state or a retry limit?"). Against a socket that is not OPEN every attempt rejects at
 * once, so this is a loop of microtasks only: no timer, I/O callback or signal handler ever runs again (so the
 * `runBounded` timeout meant to protect shutdown cannot fire either) and the heap grows until V8 aborts. Observed in
 * production: 631,981 identical "logsUnsubscribe error ... readyState was 2" lines, heap 36 MB -> 1.85 GB, SIGABRT.
 * An unsubscribe on a dead socket cannot succeed anyway and the process is about to exit, so skipping it loses nothing.
 */
export function removeLogsListenerIfSafe(connection: Connection, id: number, logger?: Logger, source?: string): Promise<void> | void {
  const state = logsSocketReadyState(connection);
  if (state === WS_CLOSING || state === WS_CLOSED) {
    logger?.warn({ source, subscriptionId: id, readyState: state }, 'skipping logs unsubscribe: websocket is closing/closed');
    return;
  }
  return connection.removeOnLogsListener(id);
}
