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
import { QUOTE_NOT_REQUESTED_REASON } from '../../src/orchestrator/quoteOrdering.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import type { ShadowMarketTick } from '../../src/shadow/types.js';
import { DEFAULT_ASSUMPTIONS } from '../shadow/fixtures.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';

/**
 * Stage 2 companion to unitContractConsistency.test.ts (which stays UNCHANGED and keeps covering the default, flag OFF).
 *
 * That file asserts `shadow baseline reasons == production reasons`. With SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE on, production
 * additionally records the explicit marker `quote_not_requested_volume_unavailable` (an audit tag appended AFTER the
 * baseline filters; the shadow runner, re-fed the same tick, never sees it). This file runs the same two real-fixture
 * scenarios with the flag OFF and ON and pins exactly what may and may not differ:
 *   - the baseline verdict and every non-marker reason are equal between production, shadow and OFF/ON;
 *   - the only production-only reason is the marker, present exactly once and only when the flag is ON;
 *   - the numbers the backtest replays (price, liquidity, volume, impact) are identical between OFF and ON.
 */

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => requestMock(...args) }));
const { DexscreenerBirdeyeAggregator } = await import('../../src/discovery/aggregatorFallbackClient.js');

const IKUN_MINT = 'DC5XoBN2qE2DXzkLANSUzE2bBiFzVj9jDkcRXSuvpump';
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;

function payload(pairOverrides: Record<string, unknown> = {}) {
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'dexscreener_token_sol_pumpswap.json'), 'utf8'));
  return { pairs: [{ ...raw.pairs[0], ...pairOverrides }] };
}

async function runOneTick(body: unknown, skipFlag: boolean) {
  const cfg = getDefaultConfig({ shadow: { enabled: true }, providers: { skipQuoteWhenVolumeUnavailable: skipFlag } });
  requestMock.mockReset();
  requestMock.mockResolvedValue({ statusCode: 200, body: { json: async () => body } });

  const db = openLedger(':memory:');
  const ledger = new TradeLedger(db);
  const aggregator = new DexscreenerBirdeyeAggregator(cfg.aggregators);
  const quoteRequests = { buy: 0 };
  const priceSource: PriceSource = {
    getPrice: (m) => aggregator.getPrice(m),
    getEstimatedPriceImpactPct: async () => null,
    getBuyExecutionQuote: async () => (quoteRequests.buy++, null),
    getSellPriceImpactPct: async () => null,
  };
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
  // same device as the original test: feed the SAME tick, safety passed, to a fresh runner to obtain the baseline verdict
  const baselineRunner = new ShadowRunner({
    ledger: new ShadowLedger(openLedger(':memory:')),
    strategies: [{ strategyVersion: cfg.strategyVersion, config: cfg }],
    assumptions: DEFAULT_ASSUMPTIONS,
  });
  const baselineOutcome = baselineRunner.onMarketTick({ ...ticks[0]!, safetyPassedAtObservationTime: true })[0]!;
  return { tick: ticks[0]!, liveOutcome: outcomes[0]![0]!, outcome: baselineOutcome, evaluation: evaluation!, quoteRequests };
}

afterEach(() => vi.restoreAllMocks());

const scenarios: Array<[string, () => unknown, string]> = [
  ['a 0.3054 SOL pool (rejected by the unchanged 20 SOL liquidity filter)', () => payload(), 'liquidity_below_minimum'],
  ['sufficient liquidity: the remaining rejection is the unavailable 1-minute volume', () => payload({ liquidity: { base: 5_000_000, quote: 120, usd: 13_000 }, txns: { m5: { buys: 300, sells: 100 } } }), 'volume_1m_unavailable'],
];

describe('production == shadow == backtest with SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE off vs on (real aggregator, real fixture)', () => {
  it.each(scenarios)('%s', async (_name, body, expectedReason) => {
    const off = await runOneTick(body(), false);
    const on = await runOneTick(body(), true);

    // --- the ORIGINAL baseline assertions, flag OFF: production reasons == shadow baseline reasons, exactly
    expect(off.liveOutcome.kind).toBe('rejected_safety');
    expect(off.outcome.kind).toBe('rejected_baseline');
    expect(off.outcome.detail!.split(',').sort()).toEqual([...off.evaluation.safetyReasons].sort());
    expect(off.evaluation.safetyReasons).toContain(expectedReason);
    expect(off.evaluation.safetyReasons).not.toContain(QUOTE_NOT_REQUESTED_REASON);
    expect(off.quoteRequests.buy).toBe(1); // control: the quote is requested today

    // --- flag ON: same verdict, same baseline reasons; the ONLY production-only reason is the marker
    expect(on.liveOutcome.kind).toBe('rejected_safety');
    expect(on.outcome.kind).toBe('rejected_baseline');
    expect(on.evaluation.safetyReasons).toContain(expectedReason);
    expect(on.evaluation.safetyReasons.filter((r) => r === QUOTE_NOT_REQUESTED_REASON)).toHaveLength(1);
    const productionWithoutMarker = on.evaluation.safetyReasons.filter((r) => r !== QUOTE_NOT_REQUESTED_REASON).sort();
    expect(on.outcome.detail!.split(',').sort()).toEqual(productionWithoutMarker); // shadow == production minus the audit marker
    expect(on.quoteRequests.buy).toBe(0); // the optimisation: not requested

    // --- decision equality OFF == ON
    expect(on.evaluation.safetyPassed).toBe(off.evaluation.safetyPassed);
    expect(on.evaluation.riskAllowed).toBe(off.evaluation.riskAllowed);
    expect(on.evaluation.ledToTradeId).toBe(off.evaluation.ledToTradeId);
    expect(on.outcome.kind).toBe(off.outcome.kind);
    expect(productionWithoutMarker).toEqual([...off.evaluation.safetyReasons].sort()); // here the quote source returns null in both, so even impact reasons coincide

    // --- the numbers every consumer (shadow tick, persisted row, backtest snapshot) sees are identical
    const a = toHistoricalSnapshot(off.evaluation);
    const b = toHistoricalSnapshot(on.evaluation);
    for (const k of ['priceSol', 'liquiditySol', 'volume1mSol', 'buySellRatio', 'volumeAccelerationX', 'txCount1m', 'estimatedPriceImpactPct', 'estimatedSellPriceImpactPct', 'safetyPassedAtObservationTime'] as const) {
      expect(b[k], k).toEqual(a[k]);
    }
    expect(on.tick.priceSol).toBe(off.tick.priceSol);
    expect(on.tick.liquiditySol).toBe(off.tick.liquiditySol);
    expect(on.tick.volume1mSol).toBe(off.tick.volume1mSol);
    expect(on.tick.estimatedPriceImpactPct).toBe(off.tick.estimatedPriceImpactPct);
  });
});
