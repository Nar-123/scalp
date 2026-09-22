import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { DryRunExecutor } from '../../src/execution/dryRunExecutor.js';
import { estimateRoundTrip, fixedCostPerLegSol, resolveFeeModel, simulateBuyFill, simulateFill, simulateSellFill } from '../../src/execution/fillSimulation.js';
import type { PriceSource } from '../../src/execution/types.js';
import { computeExpectedNetEdge } from '../../src/scoring/expectedNetEdge.js';
import { buyPriceImpactPct, entryNetLamports, sellNetLamports, sellPriceImpactPct, solOutForTokens, tokensOutForNetSol } from '../../src/volume/bondingCurveMath.js';
import { RECORDED_TRADES } from './fixtures/recordedTrades.js';

/**
 * Phase 5.6H: one accounting model for the simulator AND the expected-net-edge formula. These tests are the guard that the two can never
 * silently drift apart again (before 5.6H the simulator charged a generic 30 bps/leg, the edge formula counted ONE leg, and neither
 * contained the Pump.fun fee of 125 bps/leg).
 */
const cfg = getDefaultConfig();
const NO_FIXED = { dexFeeBps: 25, swapFeeBps: 5, networkFeeSol: 0, priorityFeeSol: 0 };
const PRODUCTION = cfg.edge;
const SIZE = 0.3;

describe('Pump.fun fee model per leg (measured tier: 95 protocol + 30 creator = 125 bps)', () => {
  it('BUY: the 125 bps fee is charged ON TOP of the spend (the curve receives spend / (1 + rate))', () => {
    const buy = simulateBuyFill(SIZE, 0, 0, NO_FIXED, 125);
    expect(buy.breakdown.feeModel).toBe('pumpfun_curve');
    expect(buy.breakdown.feeBps).toBe(125);
    expect(buy.breakdown.venueFeeSol).toBeCloseTo((SIZE * 0.0125) / 1.0125, 12);
    expect(SIZE - buy.breakdown.venueFeeSol).toBeCloseTo(SIZE / 1.0125, 12); // what reaches the curve
    // identical to the curve program's own arithmetic (repo math, verified against on-chain events in Phase 5.5)
    expect(Number(entryNetLamports(300_000_000n, 95, 30)) / 1e9).toBeCloseTo(SIZE - buy.breakdown.venueFeeSol, 8);
    expect(buy.filledAmountSol).toBeCloseTo(SIZE / 1.0125, 12); // zero impact, zero slippage, zero fixed cost
  });

  it('SELL: the 125 bps fee is DEDUCTED from the proceeds', () => {
    const sell = simulateSellFill(SIZE, 0, 0, NO_FIXED, 125);
    expect(sell.breakdown.feeModel).toBe('pumpfun_curve');
    expect(sell.breakdown.venueFeeSol).toBeCloseTo(SIZE * 0.0125, 12);
    expect(sell.filledAmountSol).toBeCloseTo(SIZE * (1 - 0.0125), 12);
    expect(Number(sellNetLamports(300_000_000n, 95, 30)) / 1e9).toBeCloseTo(sell.filledAmountSol, 8); // the curve's own arithmetic
  });

  it('SELL fee is charged on the proceeds AFTER price impact (not on the pre-impact value)', () => {
    const sell = simulateSellFill(0.3, 2, 0, NO_FIXED, 125); // 2 % impact
    const proceeds = 0.3 * 0.98;
    expect(sell.breakdown.venueFeeSol).toBeCloseTo(proceeds * 0.0125, 12);
    expect(sell.filledAmountSol).toBeCloseTo(proceeds * (1 - 0.0125), 12);
  });

  it('both fees in one round trip: an immediate buy-then-sell at an unchanged price costs 2 x the fee (the 2.47 % fee floor)', () => {
    const rt = estimateRoundTrip({ sizeSol: SIZE, priceRatio: 1, buyImpactPct: 0, sellImpactPct: 0, latencySlippagePct: 0, edge: NO_FIXED, venueFeeBps: 125 });
    const feeBuy = (SIZE * 0.0125) / 1.0125;
    const feeSell = (SIZE / 1.0125) * 0.0125;
    expect(rt.buy.breakdown.venueFeeSol).toBeCloseTo(feeBuy, 12);
    expect(rt.sell.breakdown.venueFeeSol).toBeCloseTo(feeSell, 12);
    expect(rt.roundTripCostSol).toBeCloseTo(feeBuy + feeSell, 12);
    expect(rt.roundTripCostPct).toBeCloseTo(2.469, 2);
    expect(rt.netPnlSol).toBeCloseTo(-(feeBuy + feeSell), 12);
  });

  it('network + priority cost is included exactly once per leg (two legs = 2 x)', () => {
    const edge = { dexFeeBps: 0, swapFeeBps: 0, networkFeeSol: 0.000005, priorityFeeSol: 0.0005 };
    const one = fixedCostPerLegSol(edge);
    expect(one).toBeCloseTo(0.000505, 12);
    const buy = simulateBuyFill(SIZE, 0, 0, edge, 0);
    const sell = simulateSellFill(SIZE, 0, 0, edge, 0);
    expect(buy.breakdown.fixedSol).toBeCloseTo(one, 12);
    expect(sell.breakdown.fixedSol).toBeCloseTo(one, 12);
    const rt = estimateRoundTrip({ sizeSol: SIZE, priceRatio: 1, buyImpactPct: 0, sellImpactPct: 0, latencySlippagePct: 0, edge, venueFeeBps: 0 });
    expect(rt.roundTripCostSol).toBeCloseTo(2 * one, 12); // no fee, no impact: only the two fixed costs remain
    expect(rt.netPnlSol).toBeCloseTo(-2 * one, 12);
  });

  it('fee-tier behavior is intact and nothing is hard-coded: 95 / 125 / 395 bps each price the legs at their own rate', () => {
    for (const bps of [95, 125, 395]) {
      const rate = bps / 10_000;
      const rt = estimateRoundTrip({ sizeSol: SIZE, priceRatio: 1, buyImpactPct: 0, sellImpactPct: 0, latencySlippagePct: 0, edge: NO_FIXED, venueFeeBps: bps });
      expect(rt.buy.breakdown.feeBps).toBe(bps);
      expect(rt.sell.breakdown.feeBps).toBe(bps);
      expect(rt.buy.breakdown.venueFeeSol).toBeCloseTo((SIZE * rate) / (1 + rate), 12);
      expect(rt.sell.breakdown.venueFeeSol).toBeCloseTo((SIZE / (1 + rate)) * rate, 12);
    }
    // a higher tier costs strictly more
    const cost = (bps: number) => estimateRoundTrip({ sizeSol: SIZE, priceRatio: 1, buyImpactPct: 0, sellImpactPct: 0, latencySlippagePct: 0, edge: NO_FIXED, venueFeeBps: bps }).roundTripCostSol;
    expect(cost(95)).toBeLessThan(cost(125));
    expect(cost(125)).toBeLessThan(cost(395));
  });

  it('a venue fee of 0 bps is a real (known) fee, not "missing"; an absent/invalid venue fee falls back to the configured generic model', () => {
    expect(resolveFeeModel(PRODUCTION, 0)).toEqual({ model: 'pumpfun_curve', bps: 0 });
    for (const missing of [undefined, null, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(resolveFeeModel(PRODUCTION, missing as number | null | undefined)).toEqual({ model: 'configured_flat', bps: PRODUCTION.dexFeeBps + PRODUCTION.swapFeeBps });
    }
  });

  it('no mixed fee assumptions: with a venue fee, the generic dex/swap bps are NOT charged on top', () => {
    const a = estimateRoundTrip({ sizeSol: SIZE, priceRatio: 1.03, buyImpactPct: 0.5, sellImpactPct: 0.5, latencySlippagePct: 0.3, edge: { ...PRODUCTION, dexFeeBps: 25, swapFeeBps: 5 }, venueFeeBps: 125 });
    const b = estimateRoundTrip({ sizeSol: SIZE, priceRatio: 1.03, buyImpactPct: 0.5, sellImpactPct: 0.5, latencySlippagePct: 0.3, edge: { ...PRODUCTION, dexFeeBps: 9_999, swapFeeBps: 9_999 }, venueFeeBps: 125 });
    expect(a.netPnlSol).toBeCloseTo(b.netPnlSol, 12);
  });

  it('the configured flat model (no venue fee known) reproduces the legacy single-formula fill exactly', () => {
    const legacy = simulateFill(SIZE, 0.5, 0.3, PRODUCTION);
    const buy = simulateBuyFill(SIZE, 0.5, 0.3, PRODUCTION);
    const sell = simulateSellFill(SIZE, 0.5, 0.3, PRODUCTION);
    expect(buy.filledAmountSol).toBeCloseTo(legacy.filledAmountSol, 12);
    expect(sell.filledAmountSol).toBeCloseTo(legacy.filledAmountSol, 12);
    expect(buy.feesSol).toBeCloseTo(legacy.feesSol, 12);
  });
});

describe('round-trip identity: net PnL = gross result - BUY cost - SELL cost, exactly', () => {
  it('holds over a grid of tiers, moves, impacts, slippage and fixed costs', () => {
    for (const venueFeeBps of [null, 0, 95, 125, 395]) {
      for (const ratio of [0.9, 1, 1.0222, 1.0906, 1.2]) {
        for (const impact of [0, 0.3, 1]) {
          for (const slip of [0, 0.3]) {
            const rt = estimateRoundTrip({ sizeSol: SIZE, priceRatio: ratio, buyImpactPct: impact, sellImpactPct: impact, latencySlippagePct: slip, edge: PRODUCTION, venueFeeBps });
            expect(rt.netPnlSol).toBeCloseTo(rt.grossMoveSol - rt.buyCostSol - rt.sellCostSol, 12);
            expect(rt.roundTripCostSol).toBeCloseTo(rt.buyCostSol + rt.sellCostSol, 12);
            // every SOL of each leg is accounted for by its components
            const legCost = (l: typeof rt.buy) => l.breakdown.venueFeeSol + l.breakdown.fixedSol + l.breakdown.priceImpactSol + l.breakdown.latencySlippageSol;
            if (rt.buy.filledAmountSol > 0) expect(rt.buyCostSol).toBeCloseTo(legCost(rt.buy), 12);
            if (rt.sell.filledAmountSol > 0) expect(rt.sellCostSol).toBeCloseTo(legCost(rt.sell), 12);
          }
        }
      }
    }
  });
});

function edgeInputs(over: Partial<Parameters<typeof computeExpectedNetEdge>[0]> = {}) {
  return {
    expectedGrossMovePct: 2,
    dexFeeBps: PRODUCTION.dexFeeBps,
    swapFeeBps: PRODUCTION.swapFeeBps,
    networkFeeSol: PRODUCTION.networkFeeSol,
    priorityFeeSol: PRODUCTION.priorityFeeSol,
    slippagePct: cfg.execution.latencySlippageBufferPct,
    priceImpactPct: 0.49,
    sellPriceImpactPct: 0.49,
    venueFeeBps: 125 as number | null,
    safetyMarginBps: PRODUCTION.safetyMarginBps,
    positionSizeSol: SIZE,
    ...over,
  };
}

describe('expected net edge is a COMPLETE round trip built from the simulator primitives', () => {
  it('includes both legs: a 125 bps venue on a zero-move round trip costs the full 2 x fee + 2 x fixed + slippage + impacts + margin', () => {
    const r = computeExpectedNetEdge(edgeInputs({ expectedGrossMovePct: 0 }));
    expect(r.feeModel).toBe('pumpfun_curve');
    expect(r.feeBpsPerLeg).toBe(125);
    expect(r.breakdown.buyVenueFeePct).toBeLessThan(-1.2);
    expect(r.breakdown.sellVenueFeePct).toBeLessThan(-1.2);
    expect(r.breakdown.buyFixedFeesPct).toBeCloseTo(-(fixedCostPerLegSol(PRODUCTION) / SIZE) * 100, 6);
    expect(r.breakdown.sellFixedFeesPct).toBeCloseTo(-(fixedCostPerLegSol(PRODUCTION) / SIZE) * 100, 6);
    expect(r.breakdown.safetyMarginPct).toBeCloseTo(-0.5, 12);
    expect(r.roundTripCostPct).toBeGreaterThan(2.47 + 0.33); // fee floor + fixed costs, before impact/slippage
    expect(r.isFavorable).toBe(false);
  });

  it('is exactly the simulator round trip minus the configured safety margin, and the breakdown sums to it', () => {
    for (const move of [0, 2, 3, 4, 6, 10]) {
      const r = computeExpectedNetEdge(edgeInputs({ expectedGrossMovePct: move }));
      const rt = estimateRoundTrip({ sizeSol: SIZE, priceRatio: 1 + move / 100, buyImpactPct: 0.49, sellImpactPct: 0.49, latencySlippagePct: cfg.execution.latencySlippageBufferPct, edge: PRODUCTION, venueFeeBps: 125 });
      expect(r.netEdgePct).toBeCloseTo(rt.netPnlPct - PRODUCTION.safetyMarginBps / 100, 10);
      expect(Object.values(r.breakdown).reduce((a, b) => a + b, 0)).toBeCloseTo(r.netEdgePct, 8);
    }
  });

  it('the edge and the simulator agree on the same assumptions: DryRunExecutor buy + sell == edge (before the safety margin)', async () => {
    for (const move of [0, 2.5, 4, 9.06]) {
      const priceNow = { v: 1 };
      const ps: PriceSource = {
        getPrice: vi.fn(async () => priceNow.v),
        getEstimatedPriceImpactPct: vi.fn(async () => 0.49),
        getBuyExecutionQuote: vi.fn(async () => ({ priceImpactPct: 0.49, tokenAmountRaw: '10000000000', venueFeeBps: 125 })),
        getSellPriceImpactPct: vi.fn(async () => 0.49),
        getVenueFeeBps: vi.fn(async () => 125),
      };
      const executor = new DryRunExecutor(ps, cfg);
      const buy = await executor.buy({ mint: 'M', amountSol: SIZE, maxSlippageBps: 100 });
      expect(buy.venueFeeBps).toBe(125);
      expect(buy.feeModel).toBe('pumpfun_curve');
      priceNow.v = 1 + move / 100;
      const sell = await executor.sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: buy.filledAmountSol, tokenAmountRaw: '10000000000', maxSlippageBps: 100 });
      expect(sell.feeModel).toBe('pumpfun_curve');
      const simulatedPnlPct = ((sell.filledAmountSol - SIZE) / SIZE) * 100;
      const edge = computeExpectedNetEdge(edgeInputs({ expectedGrossMovePct: move }));
      expect(edge.netEdgePct + PRODUCTION.safetyMarginBps / 100).toBeCloseTo(simulatedPnlPct, 9);
    }
  });

  it('uses the ACTUAL held token amount for the SELL impact (the amount is passed through, never re-derived)', async () => {
    const getSell = vi.fn(async (_mint: string, _tokens: string) => 0.5);
    const ps: PriceSource = {
      getPrice: vi.fn(async () => 1.02),
      getEstimatedPriceImpactPct: vi.fn(async () => 0.5),
      getBuyExecutionQuote: vi.fn(async () => null),
      getSellPriceImpactPct: getSell,
      getVenueFeeBps: vi.fn(async () => 125),
    };
    const executor = new DryRunExecutor(ps, cfg);
    await executor.sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: 0.29, tokenAmountRaw: '12345678901', maxSlippageBps: 100 });
    expect(getSell).toHaveBeenCalledWith('M', '12345678901');
  });

  it('a source without a venue fee prices BOTH legs with the configured generic model (no mixed assumptions)', async () => {
    const ps: PriceSource = {
      getPrice: vi.fn(async () => 1),
      getEstimatedPriceImpactPct: vi.fn(async () => 0.5),
      getBuyExecutionQuote: vi.fn(async () => ({ priceImpactPct: 0.5, tokenAmountRaw: '1000000' })),
      getSellPriceImpactPct: vi.fn(async () => 0.5),
    };
    const executor = new DryRunExecutor(ps, cfg);
    const buy = await executor.buy({ mint: 'M', amountSol: SIZE, maxSlippageBps: 100 });
    const sell = await executor.sell({ mint: 'M', entryPriceSol: 1, entryFilledAmountSol: buy.filledAmountSol, tokenAmountRaw: '1000000', maxSlippageBps: 100 });
    expect(buy.feeModel).toBe('configured_flat');
    expect(sell.feeModel).toBe('configured_flat');
    expect(buy.venueFeeBps).toBe(PRODUCTION.dexFeeBps + PRODUCTION.swapFeeBps);
    expect(sell.venueFeeBps).toBe(PRODUCTION.dexFeeBps + PRODUCTION.swapFeeBps);
  });

  it('fails CLOSED when the sell impact (or position size) is unavailable: never favorable, never a guessed leg', () => {
    const noSell = computeExpectedNetEdge(edgeInputs({ sellPriceImpactPct: null }));
    expect(noSell.isFavorable).toBe(false);
    expect(noSell.netEdgePct).toBe(Number.NEGATIVE_INFINITY);
    expect(noSell.unavailableReason).toBe('sell_price_impact_unavailable');
    const noBuy = computeExpectedNetEdge(edgeInputs({ priceImpactPct: Number.NaN }));
    expect(noBuy.isFavorable).toBe(false);
    expect(noBuy.unavailableReason).toBe('buy_price_impact_unavailable');
    const noSize = computeExpectedNetEdge(edgeInputs({ positionSizeSol: 0 }));
    expect(noSize.isFavorable).toBe(false);
    expect(noSize.unavailableReason).toBe('position_size_invalid');
  });

  it('the corrected edge no longer overstates profitability: at the quick-TP minimum the old formula was favorable, the complete round trip is not', () => {
    const oldFormulaNetPct = 2 - (0.25 + 0.05) - ((PRODUCTION.networkFeeSol + PRODUCTION.priorityFeeSol) / SIZE) * 100 - 0.3 - 0.49 - 0.5; // the one-leg formula removed in 5.6H
    expect(oldFormulaNetPct).toBeGreaterThan(0);
    const corrected = computeExpectedNetEdge(edgeInputs({ expectedGrossMovePct: 2 }));
    expect(corrected.isFavorable).toBe(false);
    expect(corrected.netEdgePct).toBeLessThan(oldFormulaNetPct - 2); // by more than the second leg's fee alone
  });
});

describe('the 2.5 % round-trip rule and the other policy values are untouched', () => {
  it('the gate still compares against safetyMarginBps/100 + 2 x maxPriceImpactPct (= 2.5) and the inputs are unchanged', () => {
    const gate = readFileSync(join(__dirname, '..', '..', 'src', 'safety', 'safetyGate.ts'), 'utf8');
    expect(gate).toContain('cfg.edge.safetyMarginBps / 100 + cfg.filters.maxPriceImpactPct * 2');
    expect(cfg.edge.safetyMarginBps / 100 + cfg.filters.maxPriceImpactPct * 2).toBe(2.5);
    expect(cfg.edge.safetyMarginBps).toBe(50);
    expect(cfg.filters.maxPriceImpactPct).toBe(1);
  });

  it('TP/SL, hold time, cost schedule and slippage buffer keep their configured values', () => {
    expect([cfg.exits.quickTpMinPct, cfg.exits.quickTpMaxPct, cfg.exits.momentumTpMinPct, cfg.exits.momentumTpMaxPct, cfg.exits.maxHoldTimeSec]).toEqual([2, 3, 4, 6, 30]);
    expect([cfg.edge.dexFeeBps, cfg.edge.swapFeeBps, cfg.edge.networkFeeSol, cfg.edge.priorityFeeSol]).toEqual([25, 5, 0.000005, 0.0005]);
    expect(cfg.execution.latencySlippageBufferPct).toBe(0.3);
  });
});

describe('the five previously recorded simulated trades, re-accounted (regression: the discrepancy cannot silently return)', () => {
  const big = (s: string) => BigInt(s);
  const stateOf = (s: { vs: string; vt: string; rs: string; rt: string }) => ({ virtualSolReserves: big(s.vs), virtualTokenReserves: big(s.vt), realSolReserves: big(s.rs), realTokenReserves: big(s.rt) });
  const fixed = fixedCostPerLegSol(PRODUCTION);

  for (const t of RECORDED_TRADES) {
    it(`${t.mint}: the new simulator matches the exact on-chain curve accounting; the old simulator did not`, () => {
      const size = t.entrySizeSol;
      const S0 = BigInt(Math.round(size * 1e9));
      const entry = stateOf(t.entryState);
      const exit = stateOf(t.exitState);
      const net = entryNetLamports(S0, t.feeBps, t.creatorFeeBps);
      const tokens = BigInt(t.tokensRaw);
      expect(tokensOutForNetSol(entry.virtualSolReserves, entry.virtualTokenReserves, net)).toBe(tokens); // token accounting was always exact

      // exact accounting: SOL paid in, SOL received after the curve's own sell fee, plus the configured fixed cost of both legs
      const outNet = sellNetLamports(solOutForTokens(exit.virtualSolReserves, exit.virtualTokenReserves, tokens), t.exitFeeBps, t.exitCreatorFeeBps);
      const exactPnl = Number(outNet - S0) / 1e9 - 2 * fixed;

      // the simulator with the same inputs the loop/executor feed it (latency slippage off: it is not part of the on-chain arithmetic)
      const buyImpact = buyPriceImpactPct(entry, net) as number;
      const sellImpact = sellPriceImpactPct(exit, tokens) as number;
      const buy = simulateBuyFill(size, buyImpact, 0, PRODUCTION, t.feeBps + t.creatorFeeBps);
      const sell = simulateSellFill(buy.filledAmountSol * (t.exitPriceSol / t.entryPriceSol), sellImpact, 0, PRODUCTION, t.exitFeeBps + t.exitCreatorFeeBps);
      const newPnl = sell.filledAmountSol - size;
      expect(Math.abs(newPnl - exactPnl)).toBeLessThan(0.00015); // < 0.05 % of the position (entry fixed-cost convention only)

      // BUY and SELL fee both present, at the measured tier, and about the real ~0.0085 SOL total (fees + fixed) the chain charged
      expect(buy.breakdown.venueFeeSol).toBeGreaterThan(0.0036);
      expect(sell.breakdown.venueFeeSol).toBeGreaterThan(0.0036);
      expect(buy.feesSol + sell.feesSol).toBeGreaterThan(0.0083);
      expect(buy.feesSol + sell.feesSol).toBeLessThan(0.0092);

      // the pre-5.6H simulator overstated this trade by 1.28-1.37 points; the new one is within 0.05 of exact
      expect(t.recordedOldSimPnlSol - exactPnl).toBeGreaterThan(0.0035);
    });
  }

  it('across the five trades the exact PnL is positive for 2 (not the 4 the old simulator reported), and quick-TP exits at +2.2 % to +2.8 % lost money', () => {
    const signs = RECORDED_TRADES.map((t) => {
      const S0 = BigInt(Math.round(t.entrySizeSol * 1e9));
      const exit = stateOf(t.exitState);
      const outNet = sellNetLamports(solOutForTokens(exit.virtualSolReserves, exit.virtualTokenReserves, BigInt(t.tokensRaw)), t.exitFeeBps, t.exitCreatorFeeBps);
      return Number(outNet - S0) / 1e9 - 2 * fixed > 0;
    });
    expect(signs.filter(Boolean)).toHaveLength(2);
    expect(RECORDED_TRADES.filter((t) => t.recordedOldSimPnlSol > 0)).toHaveLength(4);
  });
});
