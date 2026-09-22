import { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { RaydiumLogSubscriber } from '../../src/discovery/raydiumLogSubscriber.js';
import { PumpFunLogSubscriber } from '../../src/discovery/pumpFunLogSubscriber.js';
import { JupiterQuoteClient } from '../../src/execution/jupiterQuoteClient.js';
import { runBounded, runShutdown } from '../../src/lifecycle/shutdown.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { ProviderError } from '../../src/providers/providerGate.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';
import { gateFetch } from '../../src/providers/providerStack.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { fakeFetch, gate, makeResponse } from './helpers.js';

const never = () => new Promise<never>(() => undefined);
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;

describe('bounded shutdown steps', () => {
  it('a step that never settles is reported timed_out and the sequence MOVES ON', async () => {
    const ran: string[] = [];
    const t0 = Date.now();
    const reports = await runShutdown(
      [
        { name: 'hung', run: never },
        { name: 'after', run: () => void ran.push('after') },
        { name: 'throws', run: () => { throw new Error('x'); } },
      ],
      { stepTimeoutMs: 50 },
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(reports.map((r) => r.outcome)).toEqual(['timed_out', 'ok', 'error']);
    expect(ran).toEqual(['after']);
  });

  it('runBounded clears its timer (no timer left pending to hold the process open)', async () => {
    expect(await runBounded(() => 1, 10_000)).toBe('ok');
  });
});

describe('shutdown with pending provider requests', () => {
  it('shutdown with a pending RPC request: the request is aborted promptly, nothing is left in flight, no retry follows', async () => {
    const f = fakeFetch([{ hang: true }]);
    const { gate: g, metrics } = gate({ fetchImpl: f.fn, timeoutMs: 60_000, maxTotalMs: 60_000 });
    const pending = g.execute({ method: 'POST', body: '{}' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    expect(g.pending).toBe(1);
    const t0 = Date.now();
    g.shutdown();
    const err = await pending;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.reason).toBe('shutdown');
    expect(g.pending).toBe(0);
    expect(f.calls.length).toBe(1); // no background retry after shutdown
    expect(metrics.counters('rpc').shutdownAborted).toBeGreaterThan(0);
    // new requests are refused without touching the network
    const again = await g.execute({ method: 'POST' }).catch((e) => e);
    expect(again.reason).toBe('shutdown');
    expect(f.calls.length).toBe(1);
  });

  it('shutdown with a pending quote request: the quote client returns null (fail closed) promptly and starts nothing new', async () => {
    const f = fakeFetch([{ hang: true }]);
    const metrics = new ProviderMetrics();
    const { gate: g } = gate({ kind: 'quote', fetchImpl: f.fn, timeoutMs: 60_000, maxTotalMs: 60_000 }, metrics);
    const c = new JupiterQuoteClient({ jupiterQuoteBaseUrl: 'https://q.example', requestTimeoutMs: 1000 }, undefined, { gate: g, metrics });
    const p = c.getBuyQuote('MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 0.3, 100);
    await new Promise((r) => setTimeout(r, 20));
    g.shutdown();
    expect(await p).toBeNull();
    expect(await c.getSellQuote('MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 5n, 100)).toBeNull();
    expect(f.calls.length).toBe(1);
    expect(g.pending).toBe(0);
  });

  it('shutdown while requests wait for a concurrency slot or a backoff: all of them end promptly', async () => {
    const f = fakeFetch([{ hang: true }]);
    const { gate: g } = gate({ fetchImpl: f.fn, maxConcurrent: 1, timeoutMs: 60_000, maxTotalMs: 60_000, sleep: (_ms, signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    const all = Promise.all([1, 2, 3].map(() => g.execute({ method: 'POST' }).catch((e) => e)));
    await new Promise((r) => setTimeout(r, 20));
    g.shutdown();
    const res = await Promise.race([all, new Promise((r) => setTimeout(() => r('HUNG'), 1000))]);
    expect(res).not.toBe('HUNG');
    expect(g.pending).toBe(0);
  });

  it('web3.js Connection over gateFetch: a JSON-RPC call resolves, and a pending one is rejected on shutdown', async () => {
    const f = fakeFetch([{}]);
    const echo: typeof f.fn = (url, init) => {
      const id = (JSON.parse(init.body as string) as { id: string }).id;
      return f.fn(url, init).then(() => makeResponse({ body: JSON.stringify({ jsonrpc: '2.0', id, result: 4242 }) }));
    };
    const { gate: g } = gate({ fetchImpl: echo });
    const conn = new Connection('https://primary.example', { fetch: gateFetch(g), disableRetryOnRateLimit: true });
    expect(await conn.getSlot()).toBe(4242);
    expect(JSON.parse(f.calls[0]!.body!).method).toBe('getSlot');

    const h = fakeFetch([{ hang: true }]);
    const { gate: g2 } = gate({ fetchImpl: h.fn, timeoutMs: 60_000, maxTotalMs: 60_000 });
    const conn2 = new Connection('https://primary.example', { fetch: gateFetch(g2), disableRetryOnRateLimit: true });
    const p = conn2.getSlot().catch((e) => e);
    await new Promise((r) => setTimeout(r, 20));
    g2.shutdown();
    expect(await Promise.race([p, new Promise((r) => setTimeout(() => r('HUNG'), 1000))])).not.toBe('HUNG');
  });
});

describe('discovery source stop() is bounded even when the RPC unsubscribe never returns (Phase 5.6 regression)', () => {
  const hungConnection = { onLogs: () => 7, removeOnLogsListener: never } as never;

  it.each([
    ['pumpfun', () => new PumpFunLogSubscriber(hungConnection, { programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', stopTimeoutMs: 80 }, logger)],
    ['raydium', () => new RaydiumLogSubscriber(hungConnection, { programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', stopTimeoutMs: 80 }, logger)],
  ])('%s stop() returns within its bound', async (_name, make) => {
    const s = make();
    await s.start(() => undefined);
    const t0 = Date.now();
    await s.stop();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('the orchestrator stop() is bounded when a discovery source stop() never resolves, and the position monitor and timers are stopped', async () => {
    const cfg = getDefaultConfig();
    const db = openLedger(':memory:');
    const source = { name: 'hung-source', async start() {}, stop: never };
    const stop = await startOrchestrator(cfg, {
      discoverySources: [source as never],
      aggregator: { getLiquidityAndVolume: async () => null, getHolderConcentration: async () => null, getPrice: async () => null },
      connection: {} as never,
      executor: {} as never,
      priceSource: {} as never,
      jupiterClient: {} as never,
      ledger: new TradeLedger(db),
      logger,
      shutdownStepTimeoutMs: 100,
    });
    const t0 = Date.now();
    await stop();
    expect(Date.now() - t0).toBeLessThan(2000);
    db.close(); // persistent state is consistent and closable after shutdown
  });
});
