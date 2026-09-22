import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toHistoricalSnapshot } from '../../src/backtest/snapshotAdapter.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { TokenDiscoverySource } from '../../src/discovery/types.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import type { ShadowMarketTick } from '../../src/shadow/types.js';
import { DEFAULT_ASSUMPTIONS } from '../shadow/fixtures.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';

// The REAL aggregator runs against a mocked transport that serves the captured DexScreener payload.
const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => requestMock(...args) }));
const { DexscreenerBirdeyeAggregator } = await import('../../src/discovery/aggregatorFallbackClient.js');

const IKUN_MINT = 'DC5XoBN2qE2DXzkLANSUzE2bBiFzVj9jDkcRXSuvpump';
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;
const cfg = getDefaultConfig({ shadow: { enabled: true } });

function payload(pairOverrides: Record<string, unknown> = {}) {
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'dexscreener_token_sol_pumpswap.json'), 'utf8'));
  return { pairs: [{ ...raw.pairs[0], ...pairOverrides }] };
}

async function runOneTick(body: unknown) {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ statusCode: 200, body: { json: async () => body } });

  const db = openLedger(':memory:');
  const ledger = new TradeLedger(db);
  const aggregator = new DexscreenerBirdeyeAggregator(cfg.aggregators);
  const priceSource: PriceSource = { getPrice: (m) => aggregator.getPrice(m), getEstimatedPriceImpactPct: async () => null, getBuyExecutionQuote: async () => null, getSellPriceImpactPct: async () => null };
  const activation = createShadowActivation(cfg, db, logger)!;
  const ticks: ShadowMarketTick[] = [];
  const outcomes: Array<ReturnType<typeof activation.runner.onMarketTick>> = [];
  const original = activation.runner.onMarketTick.bind(activation.runner);
  vi.spyOn(activation.runner, 'onMarketTick').mockImplementation((t) => {
    ticks.push(t);
    const o = original(t);
    outcomes.push(o);
    return o;
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
  });
  emit({ mint: IKUN_MINT, poolAddress: null, source: 'pumpfun', createdAtSlot: 1, createdAtMs: Date.now() - 60_000, initialLiquiditySol: null });
  const t0 = Date.now();
  while (ticks.length === 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await stop();
  const [evaluation] = ledger.getEvaluationsForReplay();
  // Production skips the safety gate when its own baseline filters fail, so the live tick carries
  // safety=null and shadow (correctly) stops at safety. To compare the BASELINE verdict itself, feed the
  // same tick with safety passed to a fresh runner.
  const baselineRunner = new ShadowRunner({
    ledger: new ShadowLedger(openLedger(':memory:')),
    strategies: [{ strategyVersion: cfg.strategyVersion, config: cfg }],
    assumptions: DEFAULT_ASSUMPTIONS,
  });
  const baselineOutcome = baselineRunner.onMarketTick({ ...ticks[0]!, safetyPassedAtObservationTime: true })[0]!;
  return { tick: ticks[0]!, liveOutcome: outcomes[0]![0]!, outcome: baselineOutcome, evaluation: evaluation! };
}

afterEach(() => vi.restoreAllMocks());

describe('production == shadow == backtest for the market-data unit contract (real aggregator, real fixture)', () => {
  it('a 0.3054 SOL pool is 0.3054 SOL everywhere (not 991,688,175), and is rejected by the unchanged 20 SOL filter', async () => {
    const { tick, outcome, liveOutcome, evaluation } = await runOneTick(payload());
    expect(liveOutcome.kind).toBe('rejected_safety'); // live tick: safety unknown because production rejected on baseline first
    const snapshot = toHistoricalSnapshot(evaluation); // what the backtest replays

    expect(tick.liquiditySol).toBe(0.3054); // shadow
    expect(evaluation.liquiditySol).toBe(0.3054); // production's persisted evaluation
    expect(snapshot.liquiditySol).toBe(0.3054); // backtest input
    expect(tick.priceSol).toBe(evaluation.priceSol);
    expect(snapshot.priceSol).toBe(evaluation.priceSol);
    expect(tick.priceSol).toBe(0.000000006247);

    // same verdict from production and shadow, from the same unchanged threshold
    expect(evaluation.safetyReasons).toContain('liquidity_below_minimum');
    expect(outcome.kind).toBe('rejected_baseline');
    expect(outcome.detail!.split(',').sort()).toEqual([...evaluation.safetyReasons].sort());
  });

  it('with sufficient SOL liquidity the remaining rejection is the unavailable 1-minute volume, identically in production and shadow', async () => {
    const { tick, outcome, evaluation } = await runOneTick(
      payload({ liquidity: { base: 5_000_000, quote: 120, usd: 13_000 }, txns: { m5: { buys: 300, sells: 100 } } }),
    );
    expect(tick.liquiditySol).toBe(120);
    expect(evaluation.liquiditySol).toBe(120);
    expect(tick.buySellRatio).toBe(3);
    expect(tick.volume1mSol).toBeNull(); // never the USD m5 figure, never m5/5, never a converted m5
    expect(tick.volumeAccelerationX).toBeNull();
    expect(evaluation.volume1mSol).toBeNull();

    expect(evaluation.safetyReasons).toContain('volume_1m_unavailable');
    expect(evaluation.safetyReasons).toContain('volume_acceleration_unavailable');
    expect(evaluation.safetyReasons).not.toContain('liquidity_below_minimum');
    expect(evaluation.safetyReasons).not.toContain('volume_below_minimum'); // unavailable != "below minimum"
    expect(outcome.kind).toBe('rejected_baseline');
    expect(outcome.detail!.split(',').sort()).toEqual([...evaluation.safetyReasons].sort());
  });
});
