import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { DryRunExecutor } from '../../src/execution/dryRunExecutor.js';
import { computeTradeFees, estimateRoundTrip, simulateFill } from '../../src/execution/fillSimulation.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { isStaleAtDecision, MAX_MARKET_DATA_AGE_AT_DECISION_MS, MAX_SNAPSHOT_SKEW_MS, snapshotCoherenceIssues } from '../../src/orchestrator/snapshotCoherence.js';
import { collectBaselineFilterFailures } from '../../src/orchestrator/baselineFilters.js';
import { runReplay } from '../../src/backtest/replayEngine.js';
import { computeExpectedNetEdge } from '../../src/scoring/expectedNetEdge.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';
import { buyPriceImpactPct, entryNetLamports, preTradeState, sellNetLamports, sellPriceImpactPct, solOutForTokens, tokensOutForNetSol } from '../../src/volume/bondingCurveMath.js';
import { decodePumpfunNotification } from '../../src/volume/pumpfunTradeEventDecoder.js';
import { BASE_TS, CurveSim, Feed, REAL, at, mintId } from '../volume/helpers.js';
import { DEFAULT_ASSUMPTIONS as BT_ASSUMPTIONS, DEFAULT_CONFIG as BT_CONFIG, entryEligibleSnapshot } from '../backtest/fixtures.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleTick } from '../shadow/fixtures.js';

const SRC = join(__dirname, '..', '..', 'src');
const cfg = getDefaultConfig();
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;

// ---------------------------------------------------------------------------------------------------------------------
describe('1/2. sell-side price impact is its own calculation (Phase 5.6)', () => {
  const fresh = { virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, realSolReserves: 0n, realTokenReserves: 793_100_000_000_000n };

  it('deterministic fixture: a 0.3 SOL entry on the thinnest curve, then the sell of exactly those tokens', () => {
    const net = entryNetLamports(300_000_000n, 95, 30);
    expect(net).toBe(296_296_296n);
    const tokens = tokensOutForNetSol(fresh.virtualSolReserves, fresh.virtualTokenReserves, net);
    expect(tokens).toBe(10_493_887_520_171n);
    const buyImpact = buyPriceImpactPct(fresh, net)!;
    expect(buyImpact).toBeCloseTo(0.98765432, 6); // net / vSol

    // the position is now a holder of `tokens` against the POST-buy state
    const post = { virtualSolReserves: fresh.virtualSolReserves + net, virtualTokenReserves: fresh.virtualTokenReserves - tokens, realSolReserves: net, realTokenReserves: fresh.realTokenReserves - tokens };
    expect(solOutForTokens(post.virtualSolReserves, post.virtualTokenReserves, tokens)).toBe(296_296_295n);
    const sellImpact = sellPriceImpactPct(post, tokens)!;
    expect(sellImpact).toBeCloseTo(0.97799544, 6);
    expect(sellImpact).toBeCloseTo((Number(tokens) / Number(post.virtualTokenReserves + tokens)) * 100, 6); // the exact identity t / (vTok + t)
    expect(sellImpact).not.toBeCloseTo(buyImpact, 3); // NOT the buy figure
  });

  it('the sell impact depends on the TOKEN reserve, the buy impact on the SOL reserve: on other curves they diverge further', () => {
    const vs = 50_000_000_000n;
    const vt = (1_073_000_000_000_000n * 30_000_000_000n) / vs;
    const net = 296_296_296n;
    const out = tokensOutForNetSol(vs, vt, net);
    const post = { virtualSolReserves: vs + net, virtualTokenReserves: vt - out, realSolReserves: 20_000_000_000n + net, realTokenReserves: 600_000_000_000_000n };
    expect(buyPriceImpactPct({ virtualSolReserves: vs, virtualTokenReserves: vt, realTokenReserves: 600_000_000_000_000n }, net)).toBeCloseTo(0.5925926, 5);
    expect(sellPriceImpactPct(post, out)).toBeCloseTo(0.58910195, 5);
  });

  it('is NOT amount / liquidity: selling into a curve with little real SOL is either unpayable (null) or priced by the curve, never by the ratio', () => {
    const post = { virtualSolReserves: 60_000_000_000n, virtualTokenReserves: 500_000_000_000_000n, realSolReserves: 30_000_000_000n, realTokenReserves: 300_000_000_000_000n };
    const tokens = 5_000_000_000_000n;
    const impact = sellPriceImpactPct(post, tokens)!;
    const naive = (Number(solOutForTokens(post.virtualSolReserves, post.virtualTokenReserves, tokens)) / Number(post.realSolReserves)) * 100;
    expect(Math.abs(impact - naive)).toBeGreaterThan(0.1);
    // the curve holds less real SOL than the sale would pay out: the sale is impossible => fail closed
    expect(sellPriceImpactPct({ ...post, realSolReserves: 1_000_000n }, tokens)).toBeNull();
  });

  it('returns null (fail closed) for nothing to sell, empty reserves, or a sale the curve cannot pay', () => {
    expect(sellPriceImpactPct(fresh, 0n)).toBeNull();
    expect(sellPriceImpactPct({ ...fresh, virtualSolReserves: 0n }, 1_000n)).toBeNull();
    expect(sellPriceImpactPct({ ...fresh, virtualTokenReserves: 0n }, 1_000n)).toBeNull();
    expect(sellPriceImpactPct(fresh, 10_000_000_000_000n)).toBeNull(); // fresh curve: 0 real SOL cannot pay anything
  });

  it('the sell formula reproduces REAL on-chain sells exactly (solOut = floor(tok * vSol / (vTok + tok)) on the pre-trade state)', () => {
    let checked = 0;
    for (const n of REAL.sol_sell) {
      const t = decodePumpfunNotification({ signature: n.signature, slot: n.slot, err: null, logs: n.logs, receivedAtMs: 1 }).trades[0]!;
      if (!t.curve || t.curve.mayhemMode) continue;
      const pre = preTradeState(t.curve, false, t.solAmountLamports, BigInt(t.tokenAmount));
      expect(solOutForTokens(pre.virtualSol, pre.virtualToken, BigInt(t.tokenAmount)), n.signature).toBe(BigInt(t.solAmountLamports));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('net proceeds after the curve fee are computed from the sell direction (fee comes out of the SOL received)', () => {
    expect(sellNetLamports(1_000_000_000n, 95, 30)).toBe(987_500_000n);
    expect(sellNetLamports(0n, 95, 30)).toBe(0n);
  });

  it('the native snapshot carries BOTH impacts and they are different quantities', () => {
    const f = new Feed();
    f.pace(BASE_TS, BASE_TS + 200);
    const sim = new CurveSim();
    f.create(mintId(3), BASE_TS + 100);
    f.curveTrade(mintId(3), sim.buy(8_000_000_000n), BASE_TS + 150);
    // A second, small trade close to the query time keeps the curve within the default 5 s per-token freshness
    // bound (see the P1 fix in pumpfunVolumeEngine.ts:resolveCurve).
    f.curveTrade(mintId(3), sim.buy(100_000_000n), BASE_TS + 200);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const s = f.engine.getNativeMarketSnapshot(mintId(3), 0.3, at(BASE_TS + 201));
    expect(s.priceImpactPct).not.toBeNull();
    expect(s.sellPriceImpactPct).not.toBeNull();
    expect(s.sellPriceImpactPct).not.toBe(s.priceImpactPct);
    expect(BigInt(s.buyTokenAmountRaw as string)).toBeGreaterThan(0n);
    // and the provider method used for an ACTUAL held amount agrees with the snapshot for that amount
    const held = f.engine.getNativeSellImpact(mintId(3), BigInt(s.buyTokenAmountRaw as string), at(BASE_TS + 201));
    expect(held.sellPriceImpactPct).toBeCloseTo(s.sellPriceImpactPct as number, 12);
  });

  it('native sell impact is unavailable (null) when the curve is not valid: graduated, unobserved, mayhem', () => {
    const f = new Feed();
    f.pace(BASE_TS, BASE_TS + 200);
    const sim = new CurveSim();
    f.create(mintId(4), BASE_TS + 100);
    f.curveTrade(mintId(4), sim.buy(2_000_000_000n), BASE_TS + 150);
    f.graduate(mintId(4), BASE_TS + 160);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getNativeSellImpact(mintId(4), 1_000_000n, at(BASE_TS + 201))).toMatchObject({ quality: 'GRADUATED', sellPriceImpactPct: null });
    expect(f.engine.getNativeSellImpact(mintId(777), 1_000_000n, at(BASE_TS + 201))).toMatchObject({ quality: 'UNAVAILABLE', sellPriceImpactPct: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
function ps(overrides: Partial<PriceSource> = {}): PriceSource {
  return {
    getPrice: vi.fn().mockResolvedValue(1),
    getEstimatedPriceImpactPct: vi.fn().mockResolvedValue(0.1),
    getBuyExecutionQuote: vi.fn().mockResolvedValue({ priceImpactPct: 0.1, tokenAmountRaw: '5000000' }),
    getSellPriceImpactPct: vi.fn().mockResolvedValue(0.9),
    ...overrides,
  };
}

describe('2/3. execution direction and fees in the dry-run executor', () => {
  it('a SELL is priced with the SELL impact and never with the buy impact (buy 0.1 %, sell 0.9 %)', async () => {
    const source = ps();
    const ex = new DryRunExecutor(source, cfg);
    const buy = await ex.buy({ mint: 'M', amountSol: 0.3, maxSlippageBps: 100 });
    expect(buy.priceImpactPct).toBe(0.1);
    expect(buy.tokenAmountRaw).toBe('5000000');
    expect(source.getSellPriceImpactPct).not.toHaveBeenCalled(); // a buy never asks for the sell figure

    const sell = await ex.sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: 0.29, tokenAmountRaw: buy.tokenAmountRaw ?? null, maxSlippageBps: 100 });
    expect(sell.success).toBe(true);
    expect(sell.priceImpactPct).toBe(0.9); // the sell figure
    expect(source.getSellPriceImpactPct).toHaveBeenCalledWith('M', '5000000'); // for the actual held amount
    const expected = simulateFill(0.29, 0.9, cfg.execution.latencySlippageBufferPct, cfg.edge);
    expect(sell.filledAmountSol).toBeCloseTo(expected.filledAmountSol, 12);
    const withBuyImpact = simulateFill(0.29, 0.1, cfg.execution.latencySlippageBufferPct, cfg.edge);
    expect(sell.filledAmountSol).toBeLessThan(withBuyImpact.filledAmountSol); // proves the buy figure was NOT used
  });

  it('fees are charged on BOTH legs by the shared fee schedule (dex + swap bps of the gross, plus network + priority)', () => {
    const gross = 0.3;
    const fees = computeTradeFees(gross, cfg.edge);
    expect(fees).toBeCloseTo(cfg.edge.networkFeeSol + cfg.edge.priorityFeeSol + (gross * (cfg.edge.dexFeeBps + cfg.edge.swapFeeBps)) / 10_000, 12);
    const fill = simulateFill(gross, 0.5, 0.3, cfg.edge);
    expect(fill.feesSol).toBeCloseTo(fees, 12);
    expect(fill.filledAmountSol).toBeCloseTo(gross - fees - (gross * (0.5 + 0.3)) / 100, 12);
  });

  it('FAIL CLOSED: no token amount, no sell impact, or no price => the sell is not executed and is marked retryable where nothing was executed', async () => {
    const noAmount = await new DryRunExecutor(ps(), cfg).sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: 0.29, tokenAmountRaw: null, maxSlippageBps: 100 });
    expect(noAmount).toMatchObject({ success: false, error: 'sell_token_amount_unknown', filledAmountSol: 0 });
    const noImpact = await new DryRunExecutor(ps({ getSellPriceImpactPct: vi.fn().mockResolvedValue(null) }), cfg).sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: 0.29, tokenAmountRaw: '5', maxSlippageBps: 100 });
    expect(noImpact).toMatchObject({ success: false, error: 'sell_price_impact_unavailable', retryable: true, filledAmountSol: 0 });
    const noPrice = await new DryRunExecutor(ps({ getPrice: vi.fn().mockResolvedValue(null) }), cfg).sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: 0.29, tokenAmountRaw: '5', maxSlippageBps: 100 });
    expect(noPrice).toMatchObject({ success: false, error: 'price_unavailable', retryable: true });
    const badNumber = await new DryRunExecutor(ps({ getSellPriceImpactPct: vi.fn().mockResolvedValue(Number.NaN) }), cfg).sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: 0.29, tokenAmountRaw: '5', maxSlippageBps: 100 });
    expect(badNumber.success).toBe(false);
    const noBuyImpact = await new DryRunExecutor(ps({ getBuyExecutionQuote: vi.fn().mockResolvedValue(null) }), cfg).buy({ mint: 'M', amountSol: 0.3, maxSlippageBps: 100 });
    expect(noBuyImpact).toMatchObject({ success: false, error: 'buy_price_impact_unavailable', filledAmountSol: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Position-monitor sell-failure-state coverage (deferred/retryable sells, non-executed failures, unknown execution
// outcomes, and the "never fabricate a realized exit/PnL for a sell that did not execute" regression) now lives in
// its own file: test/orchestrator/positionMonitor.test.ts.
// ---------------------------------------------------------------------------------------------------------------------
describe('4. expected net edge remains mandatory and fee-aware', () => {
  it('subtracts every configured cost of BOTH legs (fees, network+priority, slippage, price impact) plus the safety margin (Phase 5.6H: complete round trip)', () => {
    const r = computeExpectedNetEdge({
      expectedGrossMovePct: cfg.exits.quickTpMinPct,
      dexFeeBps: cfg.edge.dexFeeBps,
      swapFeeBps: cfg.edge.swapFeeBps,
      networkFeeSol: cfg.edge.networkFeeSol,
      priorityFeeSol: cfg.edge.priorityFeeSol,
      slippagePct: cfg.execution.latencySlippageBufferPct,
      priceImpactPct: 0.5,
      sellPriceImpactPct: 0.5,
      safetyMarginBps: cfg.edge.safetyMarginBps,
      positionSizeSol: HARD_RISK_PARAMETERS.positionSizeSol,
    });
    const rt = estimateRoundTrip({
      sizeSol: HARD_RISK_PARAMETERS.positionSizeSol,
      priceRatio: 1 + cfg.exits.quickTpMinPct / 100,
      buyImpactPct: 0.5,
      sellImpactPct: 0.5,
      latencySlippagePct: cfg.execution.latencySlippageBufferPct,
      edge: cfg.edge,
    });
    expect(r.netEdgePct).toBeCloseTo(rt.netPnlPct - cfg.edge.safetyMarginBps / 100, 10);
    // both legs' fixed cost, not one: 2 x (network + priority) as a % of the position
    const fixedBothLegs = ((2 * (cfg.edge.networkFeeSol + cfg.edge.priorityFeeSol)) / HARD_RISK_PARAMETERS.positionSizeSol) * 100;
    expect(-(r.breakdown.buyFixedFeesPct! + r.breakdown.sellFixedFeesPct!)).toBeCloseTo(fixedBothLegs, 6);
    expect(Object.keys(r.breakdown).sort()).toEqual(
      ['buyFixedFeesPct', 'buyPriceImpactPct', 'buySlippagePct', 'buyVenueFeePct', 'grossMovePct', 'safetyMarginPct', 'sellFixedFeesPct', 'sellPriceImpactPct', 'sellSlippagePct', 'sellVenueFeePct'].sort(),
    );
  });

  it('no entry without it: an entry that passes every baseline filter but has an unfavorable net edge is never opened (shadow)', () => {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: DEFAULT_CONFIG.strategyVersion, config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });
    // impact 0.95 % <= the unchanged 1 % limit, so every V1 filter passes, but the fee-aware edge is negative
    const tick = entryEligibleTick({ estimatedPriceImpactPct: 0.95, estimatedSellPriceImpactPct: 0.95 });
    const [outcome] = runner.onMarketTick(tick);
    expect(outcome!.kind).toBe('rejected_score_or_edge');
    expect(ledger.getOpenPositions(DEFAULT_CONFIG.strategyVersion)).toHaveLength(0);
  });

  it('structural: in both entry paths the edge calculation is evaluated before any entry can be recorded or executed', () => {
    const loop = readFileSync(join(SRC, 'orchestrator', 'loop.ts'), 'utf8');
    expect(loop.indexOf('computeExpectedNetEdge(')).toBeGreaterThan(-1);
    expect(loop.indexOf('computeExpectedNetEdge(')).toBeLessThan(loop.indexOf('deps.executor.buy('));
    expect(loop).toMatch(/unfavorable_net_edge/);
    const shadow = readFileSync(join(SRC, 'shadow', 'shadowRunner.ts'), 'utf8');
    expect(shadow.indexOf('computeExpectedNetEdge(')).toBeLessThan(shadow.indexOf('ledger.recordEntry('));
    const replay = readFileSync(join(SRC, 'backtest', 'replayEngine.ts'), 'utf8');
    expect(replay.indexOf('computeExpectedNetEdge(')).toBeLessThan(replay.indexOf('openPositions.set('));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('5/6/7/8. timestamp consistency, stale data, missing data: fail closed, never zero', () => {
  it('snapshot coherence: parts of one observation must be one moment', () => {
    expect(snapshotCoherenceIssues({ observedAtMs: 1000, marketDataTimeMs: 1500, quoteTimeMs: 1800 })).toEqual([]);
    expect(snapshotCoherenceIssues({ observedAtMs: 1000, marketDataTimeMs: null, quoteTimeMs: null })).toEqual(['market_data_timestamp_missing']);
    expect(snapshotCoherenceIssues({ observedAtMs: 100_000, marketDataTimeMs: 90_000, quoteTimeMs: null })).toContain('market_data_before_tick_start');
    expect(snapshotCoherenceIssues({ observedAtMs: 1000, marketDataTimeMs: 1000 + MAX_SNAPSHOT_SKEW_MS + 1, quoteTimeMs: null })).toContain('market_data_too_slow_for_tick');
    expect(snapshotCoherenceIssues({ observedAtMs: 1000, marketDataTimeMs: 2000, quoteTimeMs: 2000 + MAX_SNAPSHOT_SKEW_MS + 1 })).toContain('quote_and_market_data_skewed');
  });

  it('staleness at decision time: an observation older than the bound must not be acted on; unknown age counts as stale', () => {
    expect(isStaleAtDecision(1000, 1000 + MAX_MARKET_DATA_AGE_AT_DECISION_MS)).toBe(false);
    expect(isStaleAtDecision(1000, 1000 + MAX_MARKET_DATA_AGE_AT_DECISION_MS + 1)).toBe(true);
    expect(isStaleAtDecision(null, 5000)).toBe(true);
  });

  function shadow() {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: DEFAULT_CONFIG.strategyVersion, config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });
    return { runner, ledger, db };
  }

  it('a tick whose market data is stamped materially away from the tick (or the quote from the market data) opens nothing', () => {
    const { runner, ledger } = shadow();
    const skewed = entryEligibleTick({ mint: 'MINT_A', timings: { discoveryTimeMs: 0, signalTimeMs: 40_000, marketDataTimeMs: 40_000 + MAX_SNAPSHOT_SKEW_MS + 5_000, quoteTimeMs: null, simulationTimeMs: 40_010, exitSignalTimeMs: null } });
    expect(runner.onMarketTick(skewed)[0]).toMatchObject({ kind: 'missed_signal' });
    const missingStamp = entryEligibleTick({ mint: 'MINT_B', timings: { discoveryTimeMs: 0, signalTimeMs: 40_000, quoteTimeMs: null, simulationTimeMs: 40_010, exitSignalTimeMs: null } });
    expect(runner.onMarketTick(missingStamp)[0]).toMatchObject({ kind: 'missed_signal' });
    expect(ledger.getOpenPositions(DEFAULT_CONFIG.strategyVersion)).toHaveLength(0);
    expect(runner.health.snapshot().counters.snapshot_timestamps_inconsistent).toBe(2);
  });

  it('missing / unavailable values never become a passing zero: baseline filters report them as UNAVAILABLE', () => {
    const f = collectBaselineFilterFailures({ liquiditySol: 40, volume1mSol: null, buySellRatio: null }, 5, null, null, cfg);
    expect(f).toEqual(expect.arrayContaining(['volume_1m_unavailable', 'buy_sell_ratio_unavailable', 'volume_acceleration_unavailable', 'price_impact_unavailable']));
    expect(f).not.toContain('volume_below_minimum'); // unavailable is a different verdict from "too low", and never "enough"
    for (const bad of [Number.NaN, -1]) {
      const g = collectBaselineFilterFailures({ liquiditySol: 40, volume1mSol: 10, buySellRatio: 2 }, 5, 2, bad, cfg);
      expect(g.length === 0 || g.some((x) => x.startsWith('price_impact'))).toBe(true);
    }
  });

  it('missing price / liquidity / ratio in a tick: no entry, recorded as a missed signal (not zero)', () => {
    for (const patch of [{ priceSol: null }, { liquiditySol: null }, { buySellRatio: null }]) {
      const { runner, ledger } = shadow();
      const [o] = runner.onMarketTick(entryEligibleTick(patch));
      expect(o!.kind, JSON.stringify(patch)).toBe('missed_signal');
      expect(ledger.getOpenPositions(DEFAULT_CONFIG.strategyVersion)).toHaveLength(0);
    }
  });

  it('invalid price (0, negative, NaN, absurd jump) never opens a position', () => {
    for (const price of [0, -1, Number.NaN]) {
      const { runner, ledger } = shadow();
      const outcomes = runner.onMarketTick(entryEligibleTick({ priceSol: price }));
      expect(outcomes[0]!.kind, String(price)).not.toBe('entered');
      expect(ledger.getOpenPositions(DEFAULT_CONFIG.strategyVersion)).toHaveLength(0);
    }
  });

  it('safety not confirmed / failed => no entry', () => {
    const { runner } = shadow();
    expect(runner.onMarketTick(entryEligibleTick({ safetyPassedAtObservationTime: false, safetyReasonsAtObservationTime: ['mint_authority_not_renounced'] }))[0]!.kind).toBe('rejected_safety');
    expect(runner.onMarketTick(entryEligibleTick({ mint: 'MINT_B', safetyPassedAtObservationTime: null }))[0]!.kind).toBe('rejected_safety');
  });

  it('an upstream fetch failure (RPC/API) tick is recorded as a data-quality event, drives nothing', () => {
    const { runner, ledger } = shadow();
    runner.onMarketTick(entryEligibleTick({ priceSol: null, liquiditySol: null, buySellRatio: null, fetchError: { source: 'aggregator', message: 'timeout' } }));
    expect(ledger.getOpenPositions(DEFAULT_CONFIG.strategyVersion)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('9. complete shadow trade lifecycle (discovery -> market data -> filters -> safety -> edge -> entry -> position -> exit -> PnL -> ledger)', () => {
  it('opens, holds, exits via quick_tp with the SELL impact, and records a reproducible decision + exit context', () => {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: DEFAULT_CONFIG.strategyVersion, config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });
    const sv = DEFAULT_CONFIG.strategyVersion;

    const entry = entryEligibleTick({
      observedAtMs: 40_000,
      priceSol: 1,
      estimatedPriceImpactPct: 0.2,
      estimatedSellPriceImpactPct: 0.35,
      buyTokenAmountRaw: '5000000',
      buyVolume1mSol: 7,
      sellVolume1mSol: 3,
      marketSource: 'pumpfun_native',
      marketDataAsOfSec: 41,
      volumeWindowEndSec: 40,
      stateEventSec: 39,
    });
    expect(runner.onMarketTick(entry)[0]!.kind).toBe('entered');
    const open = ledger.getOpenPosition(sv, 'MINT_A')!;
    expect(open.status).toBe('open');
    expect(open.entryTokenAmountRaw).toBe('5000000');
    const ctx = open.entryContext as Record<string, unknown>;
    // every field needed to reproduce the decision
    for (const key of ['mint', 'discoveredAtMs', 'marketSource', 'marketDataAsOfSec', 'volumeWindowEndSec', 'priceSol', 'liquiditySol', 'volume1mSol', 'buyVolume1mSol', 'sellVolume1mSol', 'buySellRatio', 'priceVelocity5sPct', 'volumeAccelerationX', 'buyPriceImpactPct', 'sellPriceImpactPct', 'expectedNetEdgePct', 'safetyPassed', 'entryDecision', 'strategyVersion']) {
      expect(ctx, key).toHaveProperty(key);
    }
    expect(ctx).toMatchObject({ marketSource: 'pumpfun_native', buyPriceImpactPct: 0.2, sellPriceImpactPct: 0.35, buyVolume1mSol: 7, sellVolume1mSol: 3, entryDecision: 'enter', strategyVersion: sv });
    expect(typeof ctx.expectedNetEdgePct).toBe('number');

    // a later tick: price +3 % (quick take-profit range), sell impact quoted at THAT tick
    const exitTick = entryEligibleTick({ observedAtMs: 46_000, priceSol: 1.03, estimatedPriceImpactPct: 0.2, estimatedSellPriceImpactPct: 0.6 });
    expect(runner.onMarketTick(exitTick)[0]).toMatchObject({ kind: 'exited' });
    const closed = ledger.getOpenPosition(sv, 'MINT_A');
    expect(closed).toBeNull();
    const row = db.prepare('SELECT * FROM shadow_trades WHERE trade_id = ?').get(open.tradeId) as Record<string, unknown>;
    expect(row.status).toBe('closed');
    const ex = JSON.parse(row.exit_context_json as string);
    expect(ex.sellPriceImpactPct).toBe(0.6); // the exit tick's own SELL quote, not the entry's 0.2 buy figure
    expect(ex.exitReason).toBeTruthy();
    expect(ex.grossPnlSol).toBeCloseTo(open.entryFilledAmountSol * 0.03, 10);
    expect(ex.netPnlSol).toBeCloseTo((row.pnl_sol as number), 10);
    expect(ex.netPnlSol).toBeLessThan(ex.grossPnlSol); // fees + impact + slippage cost something
    expect(row.exit_time_ms).toBe(46_000);
    expect(row.hold_duration_ms).toBe(6_000);
  });

  it('a triggered exit WITHOUT a sell impact is deferred (position stays open), then filled when the sell impact is available', () => {
    const db = openLedger(':memory:');
    const ledger = new ShadowLedger(db);
    const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: DEFAULT_CONFIG.strategyVersion, config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });
    const sv = DEFAULT_CONFIG.strategyVersion;
    runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
    const noSell = entryEligibleTick({ observedAtMs: 46_000, priceSol: 1.03, estimatedSellPriceImpactPct: null });
    expect(runner.onMarketTick(noSell)[0]).toMatchObject({ kind: 'held', detail: 'exit_deferred_sell_impact_unavailable' });
    expect(ledger.getOpenPosition(sv, 'MINT_A')).not.toBeNull();
    // the buy impact on that tick (0.2) must NOT have been used as a stand-in
    expect(runner.health.snapshot().counters.exit_deferred_sell_impact_unavailable).toBe(1);
    expect(runner.onMarketTick(entryEligibleTick({ observedAtMs: 47_000, priceSol: 1.03, estimatedSellPriceImpactPct: 0.4 }))[0]).toMatchObject({ kind: 'exited' });
  });

  it('replay: an exit signal at a snapshot with no recorded sell impact is deferred, never filled with the buy impact', () => {
    const snaps = new Map([
      ['MINT_A', [entryEligibleSnapshot({ observedAtMs: 40_000 }), entryEligibleSnapshot({ observedAtMs: 46_000, priceSol: 1.03, estimatedSellPriceImpactPct: null })]],
    ]);
    const r = runReplay(snaps, BT_CONFIG, BT_ASSUMPTIONS, 'x');
    expect(r.trades[0]!.status).toBe('still_open_at_end_of_data');
    expect(r.exitsDeferredSellImpactUnavailable).toBe(1);
    const withSell = new Map([['MINT_A', [entryEligibleSnapshot({ observedAtMs: 40_000 }), entryEligibleSnapshot({ observedAtMs: 46_000, priceSol: 1.03, estimatedSellPriceImpactPct: 0.4 })]]]);
    expect(runReplay(withSell, BT_CONFIG, BT_ASSUMPTIONS, 'x').trades[0]!.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('10. no look-ahead', () => {
  it('shadow: the entry decision on a tick is invariant to any FUTURE tick (only that tick is consulted)', () => {
    const run = (future: boolean) => {
      const db = openLedger(':memory:');
      const ledger = new ShadowLedger(db);
      const runner = new ShadowRunner({ ledger, strategies: [{ strategyVersion: DEFAULT_CONFIG.strategyVersion, config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });
      const first = runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000, liquiditySol: 5 }))[0]!.kind; // liquidity below the unchanged minimum: no entry
      if (future) runner.onMarketTick(entryEligibleTick({ observedAtMs: 46_000, liquiditySol: 500, priceSol: 2 })); // a great FUTURE tick must not change the past
      return { first, entries: ledger.getOpenPositions(DEFAULT_CONFIG.strategyVersion).length, entryTime: (db.prepare('SELECT entry_time_ms FROM shadow_trades').get() as { entry_time_ms: number } | undefined)?.entry_time_ms ?? null };
    };
    const a = run(false);
    const b = run(true);
    expect(a.first).toBe('rejected_baseline');
    expect(b.first).toBe(a.first);
    expect(b.entryTime).toBe(46_000); // the entry happens AT the good tick, never retroactively at 40_000
  });

  it('replay: a snapshot prefix produces exactly the same trades as the full series up to that point (later data cannot change earlier decisions)', () => {
    const series = [
      entryEligibleSnapshot({ observedAtMs: 40_000 }),
      entryEligibleSnapshot({ observedAtMs: 46_000, priceSol: 1.03, estimatedSellPriceImpactPct: 0.3 }),
      entryEligibleSnapshot({ observedAtMs: 200_000, priceSol: 5, liquiditySol: 900 }),
    ];
    const full = runReplay(new Map([['MINT_A', series]]), BT_CONFIG, BT_ASSUMPTIONS, 'x');
    const prefix = runReplay(new Map([['MINT_A', series.slice(0, 2)]]), BT_CONFIG, BT_ASSUMPTIONS, 'x');
    expect(full.trades[0]).toEqual(prefix.trades[0]);
    const scrambledFuture = [...series.slice(0, 2), entryEligibleSnapshot({ observedAtMs: 200_000, priceSol: 0.01 })];
    expect(runReplay(new Map([['MINT_A', scrambledFuture]]), BT_CONFIG, BT_ASSUMPTIONS, 'x').trades[0]).toEqual(prefix.trades[0]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('11. security isolation and no realtime AI', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('shadow, backtest, volume and decision-context code import no signer / keypair / secret provider / live executor', () => {
    const scoped = [...files(join(SRC, 'shadow')), ...files(join(SRC, 'backtest')), ...files(join(SRC, 'volume')), join(SRC, 'orchestrator', 'decisionContext.ts'), join(SRC, 'orchestrator', 'snapshotCoherence.ts'), join(SRC, 'orchestrator', 'marketSourcePolicy.ts')];
    for (const f of scoped) {
      const code = strip(readFileSync(f, 'utf8'));
      for (const m of code.matchAll(/from\s+'([^']+)'/g)) expect(m[1], `${f} imports ${m[1]}`).not.toMatch(/signer|keypair|secretProvider|liveExecutor|walletCredential/i);
      expect(code, f).not.toMatch(/(signTransaction|sendTransaction|sendRawTransaction|sendAndConfirm|Keypair\.|secretKey)/);
    }
  });

  it('the shadow runner is constructed from ledger + assumptions only: no executor, no signer, no connection', () => {
    const db = openLedger(':memory:');
    const activation = createShadowActivation(getDefaultConfig({ shadow: { enabled: true } }), db, logger)!;
    expect(activation.runner).toBeInstanceOf(ShadowRunner);
    const src = strip(readFileSync(join(SRC, 'shadow', 'shadowRunner.ts'), 'utf8'));
    expect(src).not.toMatch(/executor|Signer|Connection|getAccountInfo|fetch\(|undici/i);
  });

  it('no LLM / AI client is imported anywhere in the realtime engine (src/), and the engine never asks an LLM to approve a trade', () => {
    for (const f of files(SRC)) {
      const code = strip(readFileSync(f, 'utf8'));
      for (const m of code.matchAll(/from\s+'([^']+)'/g)) expect(m[1], `${f} imports ${m[1]}`).not.toMatch(/anthropic|openai|langchain|llm|@ai-sdk/i);
    }
  });

  it('strategy parameters and hard risk are unchanged by Phase 5.6', () => {
    expect(cfg.filters).toEqual({ minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 });
    expect(cfg.discovery.minTokenAgeSec).toBe(30);
    expect(cfg.discovery.maxTokenAgeSec).toBe(15 * 60);
    expect(cfg.exits).toMatchObject({ quickTpMinPct: 2, quickTpMaxPct: 3, momentumTpMinPct: 4, momentumTpMaxPct: 6, dynamicSlMinPct: 2, dynamicSlMaxPct: 3, maxHoldTimeSec: 30 });
    expect(cfg.execution.latencySlippageBufferPct).toBe(0.3);
    expect(cfg.edge).toMatchObject({ dexFeeBps: 25, swapFeeBps: 5, networkFeeSol: 0.000005, priorityFeeSol: 0.0005, safetyMarginBps: 50 });
    expect(HARD_RISK_PARAMETERS).toMatchObject({ positionSizeSol: 0.3, dailyLossLimitPct: 10, maxReentriesPerToken: 5, maxConcurrentPositions: 3, maxTotalExposureSol: 0.9, maxSlippageBps: 100, maxPriceImpactBps: 100 });
    expect(cfg.dryRun).toBe(true);
    expect(cfg.execution.liveTradingExplicitlyEnabled).toBe(false);
  });
});
