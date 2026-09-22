import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { toHistoricalSnapshot } from '../../src/backtest/snapshotAdapter.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { PumpFunLogSubscriber } from '../../src/discovery/pumpFunLogSubscriber.js';
import type { AggregatorClient, TokenDiscoverySource } from '../../src/discovery/types.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import type { ShadowMarketTick } from '../../src/shadow/types.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';
import { PumpfunVolumeService } from '../../src/volume/pumpfunVolumeService.js';
import { replayPumpfunVolume } from '../../src/volume/recordedVolumeReplay.js';
import { LAG_MS, mintId, notification, patchTrade, realTradePayload } from './helpers.js';

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;
const cfg = getDefaultConfig({ shadow: { enabled: true } });
const MINT = mintId(77);

/** A stream that looks "now": event seconds end ~2 s before the wall clock so the loop's real-time query sees it as fresh. */
function liveService() {
  const db = openLedger(':memory:');
  const service = new PumpfunVolumeService({ db, watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0, engine: { silenceMs: 3_600_000 } });
  const end = Math.floor(Date.now() / 1000) - 2;
  service.start((end - 300) * 1000);
  const send = (mint: string, sol: number, ts: number, buy = true): void => {
    service.onLogNotification(notification([patchTrade(realTradePayload(buy ? 'sol_buy' : 'sol_sell'), { mint, solLamports: Math.round(sol * 1e9), timestampSec: ts, isBuy: buy })], { receivedAtMs: Date.now() - LAG_MS }));
  };
  for (let t = end - 200; t <= end; t += 1) send(mintId(9999), 0.001, t);
  return { db, service, end, send };
}

async function evaluateOnce(service: PumpfunVolumeService, db: ReturnType<typeof openLedger>, withProvider = true) {
  const ledger = new TradeLedger(db);
  const aggregator: AggregatorClient = {
    getLiquidityAndVolume: async () => ({ liquiditySol: 25, volume1mSol: null, buySellRatio: 3, txCount1m: 10 }),
    getHolderConcentration: async () => null,
    getPrice: async () => 0.001,
  };
  const priceSource: PriceSource = { getPrice: async () => 0.001, getEstimatedPriceImpactPct: async () => 0.5, getBuyExecutionQuote: async () => ({ priceImpactPct: 0.5, tokenAmountRaw: '1000000' }), getSellPriceImpactPct: async () => 0.5 };
  const activation = createShadowActivation(cfg, db, logger)!;
  const ticks: ShadowMarketTick[] = [];
  const original = activation.runner.onMarketTick.bind(activation.runner);
  vi.spyOn(activation.runner, 'onMarketTick').mockImplementation((t) => {
    ticks.push(t);
    return original(t);
  });
  let emit: (e: DiscoveredTokenEvent) => void = noop;
  const source: TokenDiscoverySource = { name: 'fake', async start(cb) { emit = cb; }, async stop() {} };
  const stop = await startOrchestrator(cfg, {
    discoverySources: [source],
    aggregator,
    connection: { getAccountInfo: async () => null } as never,
    executor: { buy: async () => { throw new Error('no'); }, sell: async () => { throw new Error('no'); } },
    priceSource,
    jupiterClient: { getRoundTripQuote: async () => null } as never,
    ledger,
    logger,
    shadowRunner: activation.runner,
    volumeProvider: withProvider ? service : undefined,
  });
  emit({ mint: MINT, poolAddress: null, source: 'pumpfun', createdAtSlot: 1, createdAtMs: Date.now() - 60_000, initialLiquiditySol: null });
  const t0 = Date.now();
  while (ticks.length === 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await stop();
  const [evaluation] = ledger.getEvaluationsForReplay();
  return { tick: ticks[0]!, evaluation: evaluation! };
}

describe('Y: production, shadow, backtest snapshot and replay all see the same normalized value', () => {
  it('real events for the token: the same volume/acceleration reach production, shadow, the backtest snapshot and the recorded-event replay', async () => {
    const { db, service, end, send } = liveService();
    send(MINT, 1, end - 100); // previous window
    send(MINT, 1.5, end - 70); // previous window
    send(MINT, 4, end - 30); // current window
    send(MINT, 6, end - 5); // current window
    service.recorder!.flush();
    const direct = service.getOneMinuteVolume(MINT);
    expect(direct.volume1mSol).toBeCloseTo(10, 9);
    expect(direct.previousVolume1mSol).toBeCloseTo(2.5, 9);
    expect(direct.volumeAccelerationX).toBeCloseTo(4, 9);

    const { tick, evaluation } = await evaluateOnce(service, db);
    expect(tick.volume1mSol).toBeCloseTo(10, 9); // shadow
    expect(tick.volumeAccelerationX).toBeCloseTo(4, 9);
    expect(evaluation.volume1mSol).toBeCloseTo(10, 9); // production ledger row
    expect(evaluation.volumeAccelerationX).toBeCloseTo(4, 9);
    const snapshot = toHistoricalSnapshot(evaluation); // backtest input
    expect(snapshot.volume1mSol).toBeCloseTo(10, 9);
    expect(snapshot.volumeAccelerationX).toBeCloseTo(4, 9);
    // The volume-related filters (unchanged thresholds 5 SOL / 1.5x) do not fail for this token.
    expect(evaluation.safetyReasons).not.toContain('volume_1m_unavailable');
    expect(evaluation.safetyReasons).not.toContain('volume_below_minimum');
    expect(evaluation.safetyReasons).not.toContain('volume_acceleration_below_minimum');

    const replay = replayPumpfunVolume(db, MINT, evaluation.evaluatedAtMs);
    expect(replay.volume1mSol).toBeCloseTo(evaluation.volume1mSol as number, 9);
    expect(replay.volumeAccelerationX).toBeCloseTo(evaluation.volumeAccelerationX as number, 9);
    service.stop();
  });

  it('a token whose volume is unknown to the stream reaches every consumer as null (filters: unavailable), never 0', async () => {
    const { db, service } = liveService();
    const { tick, evaluation } = await evaluateOnce(service, db);
    expect(tick.volume1mSol).toBeNull();
    expect(tick.volumeAccelerationX).toBeNull();
    expect(evaluation.volume1mSol).toBeNull();
    expect(evaluation.volumeAccelerationX).toBeNull();
    expect(toHistoricalSnapshot(evaluation).volume1mSol).toBeNull();
    expect(evaluation.safetyReasons).toContain('volume_1m_unavailable');
    expect(evaluation.safetyReasons).toContain('volume_acceleration_unavailable');
    service.stop();
  });

  it('without a provider the loop behaves as before (volume unavailable, no exception)', async () => {
    const { db, service } = liveService();
    const { evaluation } = await evaluateOnce(service, db, false);
    expect(evaluation.volume1mSol).toBeNull();
    service.stop();
  });
});

describe('the Pump.fun subscription is shared, not duplicated', () => {
  it('the tap sees EVERY notification of the single onLogs subscription (failed and unknown status included) and cannot break discovery', () => {
    let callback: ((logs: { signature: string; err: unknown; logs: string[] }, ctx: { slot: number }) => void) | null = null;
    const connection = {
      onLogs: vi.fn((_pk: unknown, cb: typeof callback) => {
        callback = cb;
        return 1;
      }),
      removeOnLogsListener: vi.fn(),
    };
    const seen: Array<{ signature: string; err: unknown; slot: number }> = [];
    const sub = new PumpFunLogSubscriber(
      connection as never,
      {
        programId: cfg.discovery.pumpFunProgramId,
        logTap: (e) => {
          seen.push({ signature: e.signature, err: e.err, slot: e.slot });
          if (e.signature === 'boom') throw new Error('tap failure');
        },
      },
      logger,
    );
    void sub.start(noop);
    expect(connection.onLogs).toHaveBeenCalledTimes(1); // ONE subscription
    callback!({ signature: 'ok', err: null, logs: [] }, { slot: 5 });
    callback!({ signature: 'bad', err: { InstructionError: [0, 'x'] }, logs: [] }, { slot: 6 });
    callback!({ signature: 'unknown', err: undefined, logs: [] }, { slot: 7 });
    expect(() => callback!({ signature: 'boom', err: null, logs: [] }, { slot: 8 })).not.toThrow();
    expect(seen.map((s) => s.signature)).toEqual(['ok', 'bad', 'unknown', 'boom']);
    expect(seen[2]!.err).toBeUndefined(); // unknown status is passed through as unknown, never coerced to success
    expect(seen[0]!.slot).toBe(5);
  });

  it('websocket state hooks: close breaks coverage, open does not restore it, error breaks it', () => {
    const ws = new EventEmitter();
    const service = new PumpfunVolumeService({ watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0 });
    expect(service.attachConnectionHooks({ _rpcWebSocket: ws } as never)).toBe(true);
    service.engine.markStreamStarted(1);
    ws.emit('close', 1006);
    expect(service.engine.health(2).connected).toBe(false);
    ws.emit('open');
    expect(service.engine.health(3).connected).toBe(true);
    expect(service.engine.health(3).coverageSinceSec).toBeNull(); // reconnect alone proves nothing
    ws.emit('error', new Error('x'));
    expect(service.engine.health(4).breakReason).toBe('stream_error');
    expect(service.attachConnectionHooks({} as never)).toBe(false); // hooks unavailable: reported, not assumed
  });
});
