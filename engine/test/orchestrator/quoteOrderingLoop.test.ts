import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { AggregatorClient, TokenDiscoverySource } from '../../src/discovery/types.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { NativeFirstPriceSource } from '../../src/orchestrator/nativeFirst.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { QUOTE_NOT_REQUESTED_REASON } from '../../src/orchestrator/quoteOrdering.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import type { ShadowMarketTick } from '../../src/shadow/types.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';
import { PumpfunVolumeService } from '../../src/volume/pumpfunVolumeService.js';
import { CurveSim, LAG_MS, createPayload, graduatePayload, mintId, notification, patchTrade, realTradePayload } from '../volume/helpers.js';

/**
 * Stage 2, loop level: SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE OFF vs ON on IDENTICAL inputs.
 *
 * The harness is production-shaped: a real `PumpfunVolumeService` is the native market and volume provider, and the loop's
 * price source is the real `NativeFirstPriceSource` around a counting inner source (the part that would reach Jupiter).
 */

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;
const MINT = mintId(88);
const SELL_IMPACT = 0.35;

type Route = 'graduated' | 'native';
type Position = 'none' | 'shadow' | 'real';
interface Opts {
  flag: boolean;
  route?: Route;
  /** What the aggregator reports as 1-minute volume on the graduated route; null = the real DexScreener behaviour. */
  volume?: number | null;
  /** Buy price impact the (inner) quote source answers with; null = quote unavailable. */
  impact?: number | null;
  position?: Position;
}

/** A live-looking stream: MINT is a curve token (VALID) or graduated. */
function liveService(route: Route) {
  const db = openLedger(':memory:');
  const service = new PumpfunVolumeService({ db, watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0, engine: { silenceMs: 3_600_000 } });
  const end = Math.floor(Date.now() / 1000) - 2;
  service.start((end - 300) * 1000);
  const send = (payload: Buffer): void => service.onLogNotification(notification([payload], { receivedAtMs: Date.now() - LAG_MS }));
  for (let t = end - 200; t <= end - 60; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  const sim = new CurveSim();
  send(createPayload(MINT, end - 58));
  const steps: Array<[number, () => ReturnType<CurveSim['buy']> | ReturnType<CurveSim['sell']>]> = [
    [end - 57, () => sim.buy(3_000_000_000n)],
    [end - 50, () => sim.buy(6_000_000_000n)],
    [end - 40, () => sim.buy(5_000_000_000n)],
    [end - 35, () => sim.sell(30_000_000_000_000n)],
    [end - 25, () => sim.buy(6_000_000_000n)],
    [end - 10, () => sim.buy(5_000_000_000n)],
    [end - 3, () => sim.buy(1_000_000_000n)],
  ];
  for (const [ts, step] of steps) {
    const s = step();
    send(patchTrade(realTradePayload(s.isBuy ? 'sol_buy' : 'sol_sell'), { mint: MINT, solLamports: s.solLamports, tokenAmount: s.tokenAmount, isBuy: s.isBuy, timestampSec: ts, curve: s.curve }));
  }
  if (route === 'graduated') send(graduatePayload(MINT, end - 5));
  for (let t = end - 59; t <= end; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  return { db, service };
}

async function run(o: Opts) {
  const route: Route = o.route ?? 'graduated';
  const volume = o.volume === undefined ? null : o.volume;
  const impact = o.impact === undefined ? 0.4 : o.impact;
  const position: Position = o.position ?? 'none';
  const cfg = getDefaultConfig({ shadow: { enabled: true }, providers: { skipQuoteWhenVolumeUnavailable: o.flag } });
  const { db, service } = liveService(route);
  const ledger = new TradeLedger(db);
  const calls = { buyQuote: 0, sellImpact: 0, getPrice: 0, aggregator: 0, buys: 0 };
  const aggregator: AggregatorClient = {
    getLiquidityAndVolume: async () => (calls.aggregator++, { liquiditySol: 120, volume1mSol: volume, buySellRatio: 3, txCount1m: 10 }),
    getHolderConcentration: async () => null,
    getPrice: async () => 0.001,
  };
  // the part of the price source that reaches Jupiter; wrapped in the REAL native-first decorator, as in production
  const inner: PriceSource = {
    getPrice: async () => (calls.getPrice++, 0.001),
    getEstimatedPriceImpactPct: async () => (calls.buyQuote++, impact),
    getBuyExecutionQuote: async () => (calls.buyQuote++, impact === null ? null : { priceImpactPct: impact, tokenAmountRaw: '5000000' }),
    getSellPriceImpactPct: async () => (calls.sellImpact++, SELL_IMPACT),
    takeLastQuoteFetch: () =>
      impact === null
        ? { ok: false, startedAtMs: Date.now(), completedAtMs: Date.now(), requestLatencyMs: 1, inAmountLamports: null, outAmountRaw: null, priceImpactPct: null, route: null, slippageToleranceBps: 100 }
        : { ok: true, startedAtMs: Date.now(), completedAtMs: Date.now(), requestLatencyMs: 1, inAmountLamports: '300000000', outAmountRaw: '5000000', priceImpactPct: impact, route: 'x', slippageToleranceBps: 100 },
  };
  const priceSource = new NativeFirstPriceSource(inner, service);

  const activation = createShadowActivation(cfg, db, logger)!;
  activation.ledger.start();
  const ticks: ShadowMarketTick[] = [];
  const original = activation.runner.onMarketTick.bind(activation.runner);
  vi.spyOn(activation.runner, 'onMarketTick').mockImplementation((t) => {
    ticks.push(t);
    return original(t);
  });

  if (position === 'shadow') {
    activation.ledger.recordEntry({
      tradeId: 'shadow_open_1', strategyVersion: cfg.strategyVersion, executionMode: 'shadow', simulatorVersion: 'test', mint: MINT, reentryIndex: 0,
      entryTimeMs: Date.now() - 20_000, entryPriceSol: 0.001, entrySizeSol: 0.3, entryFilledAmountSol: 0.29, entryFeesSol: 0.001, entryScore: 5,
      expectedNetEdgePct: 1, entryLiquiditySol: 50, entryQuote: null, entryTokenAmountRaw: '5000000', exitTimeMs: null, exitPriceSol: null, exitReason: null,
      exitFeesSol: null, status: 'open', pnlSol: null, pnlPct: null, holdDurationMs: null, maxFavorableExcursionPct: null, maxAdverseExcursionPct: null,
    });
  }
  if (position === 'real') {
    ledger.recordEntry({
      id: 'real_open_1', mint: MINT, poolAddress: null, strategyVersion: cfg.strategyVersion, dryRun: true, reentryIndex: 0, entryTimeMs: Date.now() - 20_000,
      entryPriceSol: 0.001, entrySizeSol: 0.3, entryTokenAgeSec: 50, entryLiquiditySol: 50, entryVolume1mSol: null, entryBuySellRatio: 2, entryPriceVelocity5sPct: 1,
      entryVolumeAccelerationX: 2, entryScore: 5, entryScoreComponents: null, expectedNetEdgePct: 1, expectedNetEdgeBreakdown: null, entrySlippagePct: 0.3,
      entryPriceImpactPct: 0.4, entryFeesSol: 0.001, entryTxSignature: null, entrySafetyCheckId: null, dailyRealizedPnlSolAtEntry: 0,
      entryTokenAmountRaw: '5000000', entryFilledAmountSol: 0.29,
    });
  }

  let emit: (e: DiscoveredTokenEvent) => void = noop;
  const source: TokenDiscoverySource = { name: 'fake', async start(cb) { emit = cb; }, async stop() {} };
  const stop = await startOrchestrator(cfg, {
    discoverySources: [source],
    aggregator,
    connection: { getAccountInfo: async () => null } as never,
    executor: { buy: async () => { calls.buys += 1; throw new Error('production buy must not run'); }, sell: async () => { throw new Error('no'); } },
    priceSource,
    jupiterClient: { getRoundTripQuote: async () => null } as never,
    ledger,
    logger,
    shadowRunner: activation.runner,
    // production wiring: the native service is the volume provider and the native market. For the "volume known" scenario
    // the provider is left out so that the aggregator's number is the one judged on.
    ...(volume === null || route === 'native' ? { volumeProvider: service } : {}),
    nativeMarket: service,
  });
  emit({ mint: MINT, poolAddress: null, source: 'pumpfun', createdAtSlot: 1, createdAtMs: Date.now() - 60_000, initialLiquiditySol: null });
  const t0 = Date.now();
  while (ticks.length === 0 && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 20));
  await stop();
  activation.ledger.stop(); // flush buffered observability writes before reading them
  const evaluation = ledger.getEvaluationsForReplay()[0]!;
  const counters = activation.ledger.getCounters();
  const dq = activation.ledger.getRecentDataQualityEvents(0);
  const shadowTrades = (db.prepare('SELECT COUNT(*) n FROM shadow_trades').get() as { n: number }).n;
  const realTrades = (db.prepare('SELECT COUNT(*) n FROM trades').get() as { n: number }).n;
  service.stop();
  return { evaluation, ticks, calls, counters, dq, shadowTrades, realTrades, tick: ticks[0]! };
}

const isImpactReason = (r: string): boolean => r.startsWith('price_impact_') || r === 'hard_max_price_impact_exceeded';
/** Everything about the verdict that must be identical between OFF and ON. */
function verdict(r: Awaited<ReturnType<typeof run>>) {
  return {
    safetyPassed: r.evaluation.safetyPassed,
    riskAllowed: r.evaluation.riskAllowed,
    ledToTradeId: r.evaluation.ledToTradeId,
    productionBuys: r.calls.buys,
    shadowTrades: r.shadowTrades,
    realTrades: r.realTrades,
    nonImpactReasons: [...r.evaluation.safetyReasons].filter((x) => !isImpactReason(x) && x !== QUOTE_NOT_REQUESTED_REASON).sort(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('graduated token, 1-minute volume unavailable, no position (the optimisation target)', () => {
  it.each([
    ['impact 0.4 (acceptable)', 0.4],
    ['impact 5 (above the maximum)', 5],
    ['quote unavailable', null],
  ])('OFF requests the quote, ON does not; the verdict is identical (%s)', async (_label, impact) => {
    const off = await run({ flag: false, impact });
    const on = await run({ flag: true, impact });

    expect(off.evaluation.marketData?.source).toBe('dexscreener'); // really the graduated route
    expect(off.evaluation.volume1mSol).toBeNull();
    expect(off.evaluation.safetyReasons).toContain('volume_1m_unavailable');

    expect(off.calls.buyQuote).toBe(1); // control: the quote IS requested today
    expect(on.calls.buyQuote).toBe(0); // optimisation: not requested
    expect(on.calls.sellImpact).toBe(0);

    expect(verdict(on)).toEqual(verdict(off));
    expect(on.evaluation.safetyPassed).toBe(false);
    expect(on.evaluation.riskAllowed).toBeNull();
    expect(on.evaluation.ledToTradeId).toBeNull();
    expect(on.calls.buys).toBe(0);
  });

  it('records the marker (ON only) and fails the price-impact filter closed, without inventing an impact', async () => {
    const off = await run({ flag: false });
    const on = await run({ flag: true });
    expect(off.evaluation.safetyReasons).not.toContain(QUOTE_NOT_REQUESTED_REASON);
    expect(on.evaluation.safetyReasons).toContain(QUOTE_NOT_REQUESTED_REASON);
    expect(on.evaluation.safetyReasons).toContain('price_impact_unavailable');
    expect(on.evaluation.estimatedPriceImpactPct).toBeNull();
    // exactly one marker, and it is last (appended after the unchanged baseline filters)
    expect(on.evaluation.safetyReasons.filter((r) => r === QUOTE_NOT_REQUESTED_REASON)).toHaveLength(1);
    expect(on.evaluation.safetyReasons.at(-1)).toBe(QUOTE_NOT_REQUESTED_REASON);
  });

  it('shadow still receives exactly one tick, with no quote observation and no price impact', async () => {
    const on = await run({ flag: true });
    expect(on.ticks).toHaveLength(1);
    expect(on.tick.estimatedPriceImpactPct).toBeNull();
    expect(on.tick.quote).toBeNull();
    expect(on.tick.fetchError).toBeNull();
    expect(on.counters.shadow_ticks_received).toBe(1);
    expect(on.counters.market_data_success).toBe(1);
  });

  it('data quality: with the quote requested and failing a missing_quote event is recorded (control); skipped, there is none', async () => {
    const off = await run({ flag: false, impact: null });
    const on = await run({ flag: true, impact: null });
    expect(off.dq.some((e) => e.kind === 'missing_quote')).toBe(true);
    expect(off.counters.quote_error).toBe(1);
    expect(on.dq.some((e) => e.kind === 'missing_quote')).toBe(false);
    expect(on.counters.quote_error ?? 0).toBe(0);
    expect(on.counters.quote_success ?? 0).toBe(0);
    // every other data-quality kind is unchanged
    const kinds = (r: typeof on): string[] => r.dq.map((e) => e.kind).filter((k) => k !== 'missing_quote').sort();
    expect(kinds(on)).toEqual(kinds(off));
  });
});

describe('cases that must keep the quote', () => {
  it('volume known (not null): the quote is requested with the flag ON and there is no marker', async () => {
    const off = await run({ flag: false, volume: 10 });
    const on = await run({ flag: true, volume: 10 });
    expect(on.evaluation.volume1mSol).toBe(10);
    expect(on.calls.buyQuote).toBe(1);
    expect(off.calls.buyQuote).toBe(1);
    expect(on.evaluation.safetyReasons).not.toContain(QUOTE_NOT_REQUESTED_REASON);
    expect(on.evaluation.safetyReasons).toEqual(off.evaluation.safetyReasons); // identical, impact reasons included
    expect(on.evaluation.estimatedPriceImpactPct).toBe(off.evaluation.estimatedPriceImpactPct);
  });

  it.each<Position>(['shadow', 'real'])('an open %s position: the quote and the sell impact are still obtained for its exit; no marker', async (position) => {
    const off = await run({ flag: false, position });
    const on = await run({ flag: true, position });
    expect(on.calls.buyQuote).toBe(1);
    expect(on.calls.sellImpact).toBe(1); // ensureSellImpact(): the exit is priced with it
    expect(on.calls.buyQuote).toBe(off.calls.buyQuote);
    expect(on.calls.sellImpact).toBe(off.calls.sellImpact);
    expect(on.evaluation.safetyReasons).not.toContain(QUOTE_NOT_REQUESTED_REASON);
    expect(on.tick.estimatedSellPriceImpactPct).toBe(SELL_IMPACT);
    expect(on.tick.estimatedSellPriceImpactPct).toBe(off.tick.estimatedSellPriceImpactPct);
    expect(on.tick.estimatedPriceImpactPct).toBe(off.tick.estimatedPriceImpactPct);
    expect(on.tick.quote).toEqual(expect.objectContaining({ estimatedPriceImpactPct: 0.4 }));
    expect(verdict(on)).toEqual(verdict(off));
  });

  it('the shadow exit is evaluated exactly as without the flag when a shadow position is open (same outcome kind)', async () => {
    const outcomes = async (flag: boolean): Promise<string[]> => {
      const r = await run({ flag, position: 'shadow' });
      const rows = (r.counters as Record<string, number>) ?? {};
      return [String(r.tick.estimatedSellPriceImpactPct), String(rows.exit_deferred_sell_impact_unavailable ?? 0)];
    };
    expect(await outcomes(true)).toEqual(await outcomes(false));
  });

  it('native (curve) route: no Jupiter request with either value of the flag, identical evaluation, no marker', async () => {
    const off = await run({ flag: false, route: 'native' });
    const on = await run({ flag: true, route: 'native' });
    expect(off.evaluation.marketData?.source).toBe('pumpfun_native');
    expect(off.calls).toMatchObject({ buyQuote: 0, sellImpact: 0, getPrice: 0, aggregator: 0 });
    expect(on.calls).toMatchObject({ buyQuote: 0, sellImpact: 0, getPrice: 0, aggregator: 0 });
    expect(on.evaluation.safetyReasons).not.toContain(QUOTE_NOT_REQUESTED_REASON);
    expect(on.evaluation.safetyReasons).toEqual(off.evaluation.safetyReasons);
    expect(on.evaluation.estimatedPriceImpactPct).toBe(off.evaluation.estimatedPriceImpactPct);
    expect(verdict(on)).toEqual(verdict(off));
  });
});

describe('differential grid: OFF vs ON on identical input', () => {
  const grid: Array<Required<Pick<Opts, 'route' | 'volume' | 'impact' | 'position'>>> = [];
  for (const route of ['graduated', 'native'] as const) {
    for (const volume of [null, 10]) {
      for (const impact of [0.4, 5, null]) {
        for (const position of ['none', 'shadow', 'real'] as const) {
          if (route === 'native' && (volume !== null || impact !== 0.4)) continue; // native ignores both: one representative per position
          grid.push({ route, volume, impact, position });
        }
      }
    }
  }

  it(`verdict, safety_passed, risk_allowed and trades are identical in all ${grid.length} combinations; the marker appears exactly when it should`, async () => {
    let markers = 0;
    let saved = 0;
    for (const g of grid) {
      const off = await run({ flag: false, ...g });
      const on = await run({ flag: true, ...g });
      const label = JSON.stringify(g);
      expect(verdict(on), label).toEqual(verdict(off));
      expect(on.evaluation.safetyPassed, label).toBe(off.evaluation.safetyPassed);
      expect(on.evaluation.riskAllowed, label).toBe(off.evaluation.riskAllowed);
      expect(off.evaluation.safetyReasons, label).not.toContain(QUOTE_NOT_REQUESTED_REASON); // never when the flag is off
      const shouldSkip = g.route === 'graduated' && g.volume === null && g.position === 'none';
      expect(on.evaluation.safetyReasons.includes(QUOTE_NOT_REQUESTED_REASON), label).toBe(shouldSkip);
      expect(on.calls.buyQuote, label).toBe(shouldSkip ? 0 : off.calls.buyQuote);
      expect(on.calls.sellImpact, label).toBe(off.calls.sellImpact);
      if (shouldSkip) {
        markers += 1;
        saved += off.calls.buyQuote - on.calls.buyQuote;
      }
    }
    expect(markers).toBe(3); // graduated x volume null x 3 impacts x no position
    expect(saved).toBe(3); // exactly the three control quote requests are gone
  }, 120_000);
});
