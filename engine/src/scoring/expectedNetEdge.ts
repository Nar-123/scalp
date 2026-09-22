import type { EdgeInputs, EdgeResult } from '../types/signals.js';
import { bpsToPct } from '../utils/math.js';
import { estimateRoundTrip } from '../execution/fillSimulation.js';

/**
 * Expected net edge for a COMPLETE ROUND TRIP (spec section 5, corrected in Phase 5.6H).
 *
 * It is not a separate cost model: it evaluates the expected gross move through the SAME leg functions the simulator uses
 * (`estimateRoundTrip` = `simulateBuyFill` + `simulateSellFill`), so both legs are priced with the same fee model, the same
 * impact, the same latency slippage and the same fixed network/priority cost, and the estimate can never disagree with a
 * simulated fill again.
 *
 *   netEdgePct = (expected gross move
 *                 - BUY venue fee - BUY price impact - BUY latency slippage - BUY network/priority
 *                 - SELL price impact - SELL venue fee - SELL latency slippage - SELL network/priority) / position
 *                - configured safety margin
 *
 * The configured safety margin (`safetyMarginBps`) is the existing one, applied once; nothing new is added. An entry whose
 * SELL impact is unknown cannot be priced end to end: it is NOT favorable (fail closed), never a default.
 */
export function computeExpectedNetEdge(inputs: EdgeInputs): EdgeResult {
  const safetyMarginPct = bpsToPct(inputs.safetyMarginBps);
  const unavailable = (reason: string): EdgeResult => ({
    netEdgePct: Number.NEGATIVE_INFINITY,
    netEdgeSol: Number.NEGATIVE_INFINITY,
    isFavorable: false,
    breakdown: {},
    unavailableReason: reason,
  });

  if (!(inputs.positionSizeSol > 0)) {
    return { ...unavailable('position_size_invalid') };
  }
  const sell = inputs.sellPriceImpactPct;
  if (sell === null || sell === undefined || !Number.isFinite(sell) || sell < 0) return unavailable('sell_price_impact_unavailable');
  if (!Number.isFinite(inputs.priceImpactPct) || inputs.priceImpactPct < 0) return unavailable('buy_price_impact_unavailable');

  const rt = estimateRoundTrip({
    sizeSol: inputs.positionSizeSol,
    priceRatio: 1 + inputs.expectedGrossMovePct / 100,
    buyImpactPct: inputs.priceImpactPct,
    sellImpactPct: sell,
    latencySlippagePct: inputs.slippagePct,
    edge: inputs,
    venueFeeBps: inputs.venueFeeBps ?? null,
  });
  const pctOf = (sol: number): number => (sol / inputs.positionSizeSol) * 100;
  const netEdgePct = rt.netPnlPct - safetyMarginPct;
  const b = rt.buy.breakdown;
  const s = rt.sell.breakdown;

  return {
    netEdgePct,
    netEdgeSol: (netEdgePct / 100) * inputs.positionSizeSol,
    isFavorable: Number.isFinite(netEdgePct) && netEdgePct > 0,
    // Every entry is a signed % of the position; they sum exactly to netEdgePct.
    breakdown: {
      grossMovePct: pctOf(rt.grossMoveSol),
      buyVenueFeePct: -pctOf(b.venueFeeSol),
      buyPriceImpactPct: -pctOf(b.priceImpactSol),
      buySlippagePct: -pctOf(b.latencySlippageSol),
      buyFixedFeesPct: -pctOf(b.fixedSol),
      sellPriceImpactPct: -pctOf(s.priceImpactSol),
      sellVenueFeePct: -pctOf(s.venueFeeSol),
      sellSlippagePct: -pctOf(s.latencySlippageSol),
      sellFixedFeesPct: -pctOf(s.fixedSol),
      safetyMarginPct: -safetyMarginPct,
    },
    roundTripCostPct: rt.roundTripCostPct,
    feeModel: b.feeModel,
    feeBpsPerLeg: b.feeBps,
  };
}
