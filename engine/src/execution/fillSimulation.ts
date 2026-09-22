import type { AppConfig } from '../config/schema.js';

/**
 * The single, shared deterministic fee/slippage/price-impact math used by
 * `DryRunExecutor` (live DRY_RUN simulation), the shadow runner, the Phase
 * 3-alt historical replay engine AND the expected-net-edge formula
 * (`scoring/expectedNetEdge.ts`). There is exactly one formula for "what
 * would this leg have cost": the edge estimate is built from the SAME leg
 * functions as the simulated fills, so the two can no longer drift apart
 * (Phase 5.6H: they used to disagree by 1.3 to 2.2 percentage points).
 *
 * VENUE FEE MODEL. A leg is priced with one of two fee models:
 *
 *  - `pumpfun_curve` -- used whenever the venue's own fee rate is known for
 *    the token (`venueFeeBps` = the protocol + creator fee carried by the
 *    Pump.fun bonding-curve TradeEvents). Charged the way the curve charges it:
 *      BUY : the fee is charged ON TOP of the SOL spend  (net to the curve = spend / (1 + rate))
 *      SELL: the fee is DEDUCTED from the SOL proceeds   (paid = proceeds x (1 - rate))
 *  - `configured_flat` -- the configured generic `dexFeeBps + swapFeeBps` taken
 *    as a flat percentage of the leg's gross value. Used only when no venue fee
 *    is known (non-curve tokens, offline replay of snapshots that carry no fee).
 *
 * The fee rate is never invented here: it is passed in by the caller from the
 * measured source, or absent (=> the configured generic model).
 */
export interface SimulatedFill {
  feesSol: number;
  filledAmountSol: number;
  /** Where every SOL of this leg's cost went (venue fee, fixed network/priority, price impact, latency slippage). */
  breakdown: LegBreakdown;
}

export type FeeModel = 'pumpfun_curve' | 'configured_flat';

export interface LegBreakdown {
  feeModel: FeeModel;
  /** Fee rate applied to this leg, in basis points. */
  feeBps: number;
  venueFeeSol: number;
  /** network + priority for this leg. */
  fixedSol: number;
  priceImpactSol: number;
  latencySlippageSol: number;
}

type FixedAndFlat = Pick<AppConfig['edge'], 'dexFeeBps' | 'swapFeeBps' | 'networkFeeSol' | 'priorityFeeSol'>;

const finiteFee = (bps: number | null | undefined): bps is number => typeof bps === 'number' && Number.isFinite(bps) && bps >= 0;

export function resolveFeeModel(edge: Pick<AppConfig['edge'], 'dexFeeBps' | 'swapFeeBps'>, venueFeeBps?: number | null): { model: FeeModel; bps: number } {
  return finiteFee(venueFeeBps) ? { model: 'pumpfun_curve', bps: venueFeeBps } : { model: 'configured_flat', bps: edge.dexFeeBps + edge.swapFeeBps };
}

/** Network + priority cost of ONE leg. */
export const fixedCostPerLegSol = (edge: Pick<AppConfig['edge'], 'networkFeeSol' | 'priorityFeeSol'>): number => edge.networkFeeSol + edge.priorityFeeSol;

/** Legacy helper (flat model): fixed costs plus the configured generic bps of a gross amount. */
export function computeTradeFees(grossSol: number, edge: FixedAndFlat): number {
  const bpsFees = (grossSol * (edge.dexFeeBps + edge.swapFeeBps)) / 10_000;
  return edge.networkFeeSol + edge.priorityFeeSol + bpsFees;
}

/**
 * BUY leg. `spendSol` is the SOL the trader pays in. `filledAmountSol` is the SOL VALUE, at the pre-trade spot price, of
 * the tokens actually received, after the venue fee, price impact and latency slippage, and net of the fixed
 * network/priority cost (the position's cost basis convention used by every consumer). Never negative.
 */
export function simulateBuyFill(
  spendSol: number,
  priceImpactPct: number,
  latencySlippagePct: number,
  edge: FixedAndFlat,
  venueFeeBps?: number | null,
): SimulatedFill {
  const fee = resolveFeeModel(edge, venueFeeBps);
  const fixedSol = fixedCostPerLegSol(edge);
  const latencySlippageSol = (spendSol * latencySlippagePct) / 100;
  if (fee.model === 'pumpfun_curve') {
    const rate = fee.bps / 10_000;
    const venueFeeSol = (spendSol * rate) / (1 + rate); // charged on top of the amount that reaches the curve
    const netToCurveSol = spendSol - venueFeeSol;
    const valueAtSpotSol = netToCurveSol / (1 + priceImpactPct / 100);
    const priceImpactSol = netToCurveSol - valueAtSpotSol;
    return {
      feesSol: venueFeeSol + fixedSol,
      filledAmountSol: Math.max(valueAtSpotSol - latencySlippageSol - fixedSol, 0),
      breakdown: { feeModel: fee.model, feeBps: fee.bps, venueFeeSol, fixedSol, priceImpactSol, latencySlippageSol },
    };
  }
  const venueFeeSol = (spendSol * fee.bps) / 10_000;
  const priceImpactSol = (spendSol * priceImpactPct) / 100;
  return {
    feesSol: venueFeeSol + fixedSol,
    filledAmountSol: Math.max(spendSol - venueFeeSol - fixedSol - priceImpactSol - latencySlippageSol, 0),
    breakdown: { feeModel: fee.model, feeBps: fee.bps, venueFeeSol, fixedSol, priceImpactSol, latencySlippageSol },
  };
}

/**
 * SELL leg. `grossValueSol` is the SOL VALUE of the tokens actually held at the CURRENT spot price. The sell impact is the
 * impact of selling exactly those held tokens (a sell-direction figure, never the buy impact). `filledAmountSol` is the SOL
 * received after impact, the venue fee (deducted from the proceeds), latency slippage and the fixed cost. Never negative.
 */
export function simulateSellFill(
  grossValueSol: number,
  sellPriceImpactPct: number,
  latencySlippagePct: number,
  edge: FixedAndFlat,
  venueFeeBps?: number | null,
): SimulatedFill {
  const fee = resolveFeeModel(edge, venueFeeBps);
  const fixedSol = fixedCostPerLegSol(edge);
  const latencySlippageSol = (grossValueSol * latencySlippagePct) / 100;
  const priceImpactSol = (grossValueSol * sellPriceImpactPct) / 100;
  const proceedsSol = grossValueSol - priceImpactSol;
  const venueFeeSol = fee.model === 'pumpfun_curve' ? (proceedsSol * fee.bps) / 10_000 : (grossValueSol * fee.bps) / 10_000;
  return {
    feesSol: venueFeeSol + fixedSol,
    filledAmountSol: Math.max(proceedsSol - venueFeeSol - fixedSol - latencySlippageSol, 0),
    breakdown: { feeModel: fee.model, feeBps: fee.bps, venueFeeSol, fixedSol, priceImpactSol, latencySlippageSol },
  };
}

/**
 * Legacy single-formula fill (flat configured model, identical for either direction). Kept for callers that have no
 * direction or venue fee; production code paths use `simulateBuyFill` / `simulateSellFill`.
 */
export function simulateFill(
  grossSol: number,
  priceImpactPct: number,
  latencySlippagePct: number,
  edge: FixedAndFlat,
): { feesSol: number; filledAmountSol: number } {
  const feesSol = computeTradeFees(grossSol, edge);
  const netSol = grossSol - feesSol - (grossSol * (priceImpactPct + latencySlippagePct)) / 100;
  return { feesSol, filledAmountSol: Math.max(netSol, 0) };
}

export interface RoundTripEstimate {
  buy: SimulatedFill;
  sell: SimulatedFill;
  /** SOL value of the held tokens after the buy (the position's cost basis). */
  entryFilledAmountSol: number;
  /** SOL value of those tokens at the exit spot, before any sell cost. */
  exitGrossValueSol: number;
  /** grossMove - buyCost - sellCost, exactly. */
  netPnlSol: number;
  netPnlPct: number;
  /** exitGrossValue - entryFilled: the price move on the position's cost basis. */
  grossMoveSol: number;
  /** spend - entryFilled: every SOL the buy leg cost. */
  buyCostSol: number;
  /** exitGrossValue - sellFilled: every SOL the sell leg cost. */
  sellCostSol: number;
  roundTripCostSol: number;
  roundTripCostPct: number;
  sellImpactSol: number;
}

/**
 * A complete round trip built from the two leg functions above: buy `sizeSol`, let the SPOT price move to
 * `priceRatio` x the entry spot, sell the tokens actually held. This is what the simulator does for a real position and
 * what the expected-net-edge formula evaluates for its expected gross move.
 *
 *   netPnl = grossMove - buyCost - sellCost        (an identity, asserted in tests)
 */
export function estimateRoundTrip(i: {
  sizeSol: number;
  /** exit spot / entry spot (1.02 = +2%). */
  priceRatio: number;
  buyImpactPct: number;
  sellImpactPct: number;
  latencySlippagePct: number;
  edge: FixedAndFlat;
  venueFeeBps?: number | null;
}): RoundTripEstimate {
  const buy = simulateBuyFill(i.sizeSol, i.buyImpactPct, i.latencySlippagePct, i.edge, i.venueFeeBps);
  const exitGrossValueSol = buy.filledAmountSol * i.priceRatio;
  const sell = simulateSellFill(exitGrossValueSol, i.sellImpactPct, i.latencySlippagePct, i.edge, i.venueFeeBps);
  const buyCostSol = i.sizeSol - buy.filledAmountSol;
  const sellCostSol = exitGrossValueSol - sell.filledAmountSol;
  const grossMoveSol = exitGrossValueSol - buy.filledAmountSol;
  const netPnlSol = sell.filledAmountSol - i.sizeSol;
  const roundTripCostSol = buyCostSol + sellCostSol;
  return {
    buy,
    sell,
    entryFilledAmountSol: buy.filledAmountSol,
    exitGrossValueSol,
    netPnlSol,
    netPnlPct: (netPnlSol / i.sizeSol) * 100,
    grossMoveSol,
    buyCostSol,
    sellCostSol,
    roundTripCostSol,
    roundTripCostPct: (roundTripCostSol / i.sizeSol) * 100,
    sellImpactSol: sell.breakdown.priceImpactSol,
  };
}
