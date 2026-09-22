import { describe, expect, it, vi } from 'vitest';
import { toHistoricalSnapshot } from '../../src/backtest/snapshotAdapter.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { AggregatorClient, TokenDiscoverySource } from '../../src/discovery/types.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import type { ShadowMarketTick } from '../../src/shadow/types.js';
import type { DiscoveredTokenEvent, DiscoverySource } from '../../src/types/token.js';
import { PumpfunVolumeService } from '../../src/volume/pumpfunVolumeService.js';
import { replayNativeMarketSnapshot } from '../../src/volume/recordedVolumeReplay.js';
import { CurveSim, LAG_MS, createPayload, graduatePayload, mintId, notification, patchTrade, realTradePayload } from './helpers.js';

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;
const cfg = getDefaultConfig({ shadow: { enabled: true } });
const MINT = mintId(88);

/** A stream that looks "now" (event seconds end ~2 s before the wall clock). The token has NO DexScreener pair by construction. */
function liveCurveService(opts: { graduate?: boolean; neverSeen?: boolean } = {}) {
  const db = openLedger(':memory:');
  const service = new PumpfunVolumeService({ db, watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0, engine: { silenceMs: 3_600_000 } });
  const end = Math.floor(Date.now() / 1000) - 2;
  service.start((end - 300) * 1000);
  const send = (payload: Buffer): void => {
    service.onLogNotification(notification([payload], { receivedAtMs: Date.now() - LAG_MS }));
  };
  for (let t = end - 200; t <= end - 60; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  if (!opts.neverSeen) {
    const sim = new CurveSim();
    send(createPayload(MINT, end - 58));
    const trades: Array<[number, () => ReturnType<CurveSim['buy']> | ReturnType<CurveSim['sell']>]> = [
      [end - 57, () => sim.buy(3_000_000_000n)],
      [end - 50, () => sim.buy(6_000_000_000n)],
      [end - 40, () => sim.buy(5_000_000_000n)],
      [end - 35, () => sim.sell(30_000_000_000_000n)],
      [end - 25, () => sim.buy(6_000_000_000n)],
      [end - 10, () => sim.buy(5_000_000_000n)],
      [end - 3, () => sim.buy(1_000_000_000n)], // keeps MINT within the default 5 s per-token freshness bound of `end`
    ];
    for (const [ts, step] of trades) {
      const s = step();
      send(patchTrade(realTradePayload(s.isBuy ? 'sol_buy' : 'sol_sell'), { mint: MINT, solLamports: s.solLamports, tokenAmount: s.tokenAmount, isBuy: s.isBuy, timestampSec: ts, curve: s.curve }));
    }
    if (opts.graduate) send(graduatePayload(MINT, end - 5));
  }
  for (let t = end - 59; t <= end; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  return { db, service, end };
}

async function runLoop(service: PumpfunVolumeService, db: ReturnType<typeof openLedger>, o: { source?: DiscoverySource; allowFallback?: boolean; withNative?: boolean } = {}) {
  const ledger = new TradeLedger(db);
  const calls = { aggregator: 0, price: 0, impact: 0 };
  const aggregator: AggregatorClient = {
    getLiquidityAndVolume: async () => (calls.aggregator++, null), // no DexScreener pair
    getHolderConcentration: async () => null,
    getPrice: async () => (calls.price++, null),
  };
  const priceSource: PriceSource = {
    getPrice: async () => (calls.price++, null),
    getEstimatedPriceImpactPct: async () => (calls.impact++, null),
    getBuyExecutionQuote: async () => (calls.impact++, null),
    getSellPriceImpactPct: async () => (calls.impact++, null),
  };
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
    volumeProvider: service,
    nativeMarket: o.withNative === false ? undefined : service,
    allowDexscreenerFallback: o.allowFallback,
  });
  emit({ mint: MINT, poolAddress: null, source: o.source ?? 'pumpfun', createdAtSlot: 1, createdAtMs: Date.now() - 60_000, initialLiquiditySol: null });
  const t0 = Date.now();
  while (ticks.length === 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await stop();
  const [evaluation] = ledger.getEvaluationsForReplay();
  return { tick: ticks[0]!, evaluation: evaluation!, calls };
}

describe('the loop on the native route (no DexScreener pair)', () => {
  it('Q/R: a Pump.fun token with NO DexScreener pair reaches the V1 baseline filters on native price, liquidity, volume and impact', async () => {
    const { db, service } = liveCurveService();
    const direct = service.getNativeMarketSnapshot(MINT, 0.3);
    expect(direct.quality).toBe('VALID');
    const { tick, evaluation, calls } = await runLoop(service, db);

    expect(evaluation.safetyReasons).not.toContain('market_data_unavailable'); // the bottleneck this phase removes
    expect(calls).toEqual({ aggregator: 0, price: 0, impact: 0 }); // DexScreener/Jupiter were never consulted
    expect(evaluation.priceSol).toBeCloseTo(direct.priceSol as number, 18);
    expect(evaluation.liquiditySol).toBeCloseTo(direct.liquiditySol as number, 9);
    expect(evaluation.volume1mSol).toBeCloseTo(direct.volume1mSol as number, 9);
    expect(evaluation.volumeAccelerationX).toBe(direct.volumeAccelerationX);
    expect(evaluation.estimatedPriceImpactPct).toBeCloseTo(direct.priceImpactPct as number, 9);
    expect(evaluation.marketData).toMatchObject({ source: 'pumpfun_native', asOfSec: direct.marketDataAsOfSec, volumeWindowEndSec: direct.volumeWindowEndSec, stateEventSec: direct.stateEventSec });
    // the volume-stage filters were EVALUATED (they may pass or fail on the real numbers; they are unchanged)
    for (const unavailable of ['volume_1m_unavailable', 'volume_acceleration_unavailable', 'price_impact_unavailable', 'buy_sell_ratio_unavailable']) {
      expect(evaluation.safetyReasons).not.toContain(unavailable);
    }
    expect(tick.priceSol).toBeCloseTo(direct.priceSol as number, 18);
    expect(tick.liquiditySol).toBeCloseTo(direct.liquiditySol as number, 9);
  });

  it('V/W: production, shadow, backtest snapshot and replay-from-recorded-events all carry the same normalized values', async () => {
    const { db, service } = liveCurveService();
    service.recorder!.flush();
    const { tick, evaluation } = await runLoop(service, db);
    service.recorder!.flush();

    const snapshot = toHistoricalSnapshot(evaluation);
    const replay = replayNativeMarketSnapshot(db, MINT, 0.3, evaluation.evaluatedAtMs);
    expect(replay.quality).toBe('VALID');
    for (const [name, values] of Object.entries({ production: evaluation, shadow: tick, backtest: snapshot })) {
      expect(values.priceSol, name).toBeCloseTo(replay.priceSol as number, 18);
      expect(values.liquiditySol, name).toBeCloseTo(replay.liquiditySol as number, 9);
      expect(values.volume1mSol, name).toBeCloseTo(replay.volume1mSol as number, 9);
      expect(values.volumeAccelerationX, name).toBe(replay.volumeAccelerationX);
    }
    expect(evaluation.estimatedPriceImpactPct).toBeCloseTo(replay.priceImpactPct as number, 9);
    expect(replay.marketDataAsOfSec).toBe(evaluation.marketData?.asOfSec);
    expect(replay.volumeWindowEndSec).toBe(evaluation.marketData?.volumeWindowEndSec);
    expect(Math.abs((replay.marketDataAsOfSec as number) - (replay.volumeWindowEndSec as number))).toBeLessThanOrEqual(5);
  });

  it('W: with no recorded events replay is UNAVAILABLE (no price, no liquidity), never fabricated', () => {
    const db = openLedger(':memory:');
    const r = replayNativeMarketSnapshot(db, MINT, 0.3, Date.now());
    expect(r).toMatchObject({ quality: 'UNAVAILABLE', reason: 'no_historical_events', priceSol: null, liquiditySol: null, priceImpactPct: null, volume1mSol: null });
  });

  it('S: a Pump.fun token the native stream cannot prove is market_data_unavailable and DexScreener is NOT consulted', async () => {
    const { db, service } = liveCurveService({ neverSeen: true });
    const { evaluation, tick, calls } = await runLoop(service, db);
    expect(evaluation.safetyReasons).toEqual(expect.arrayContaining(['market_data_unavailable', 'native_mint_not_observed']));
    expect(evaluation.priceSol).toBeNull();
    expect(evaluation.liquiditySol).toBeNull();
    expect(calls.aggregator).toBe(0);
    expect(calls.price).toBe(0);
    expect(tick.priceSol).toBeNull();
  });

  it('M/T: a graduated token leaves the native source: no stale curve price, DexScreener is consulted (and has no pair here)', async () => {
    const { db, service } = liveCurveService({ graduate: true });
    expect(service.getNativeMarketSnapshot(MINT, 0.3)).toMatchObject({ quality: 'GRADUATED', priceSol: null, liquiditySol: null });
    const { evaluation, calls } = await runLoop(service, db);
    expect(calls.aggregator).toBeGreaterThan(0);
    expect(evaluation.safetyReasons).toContain('market_data_unavailable');
    expect(evaluation.priceSol).toBeNull(); // never the last curve price
    expect(evaluation.volume1mSol).toBeNull();
  });

  it('T: DexScreener fallback for an unprovable curve token only when explicitly enabled', async () => {
    const { db, service } = liveCurveService({ neverSeen: true });
    const { calls } = await runLoop(service, db, { allowFallback: true });
    expect(calls.aggregator).toBeGreaterThan(0);
  });

  it('a Raydium-discovered token ignores the native source entirely', async () => {
    const { db, service } = liveCurveService();
    const { evaluation, calls } = await runLoop(service, db, { source: 'raydium' });
    expect(calls.aggregator).toBeGreaterThan(0);
    expect(evaluation.marketData?.source ?? null).not.toBe('pumpfun_native');
  });

  it('without a native provider the loop behaves as in Phase 5.4B (DexScreener path)', async () => {
    const { db, service } = liveCurveService();
    const { calls } = await runLoop(service, db, { withNative: false });
    expect(calls.aggregator).toBeGreaterThan(0);
  });
});
