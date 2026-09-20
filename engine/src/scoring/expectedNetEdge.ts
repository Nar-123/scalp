import type { EdgeInputs, EdgeResult } from '../types/signals.js';
import { bpsToPct } from '../utils/math.js';

/**
 * Expected net edge, per spec section 5: subtract every known cost from the
 * expected gross move before allowing a BUY.
 *
 *   netEdgePct = grossMovePct
 *              - dexFeePct - swapFeePct
 *              - fixedFeesAsPctOfPosition
 *              - slippagePct - priceImpactPct
 *              - safetyMarginPct
 */
export function computeExpectedNetEdge(inputs: EdgeInputs): EdgeResult {
  const dexFeePct = bpsToPct(inputs.dexFeeBps);
  const swapFeePct = bpsToPct(inputs.swapFeeBps);
  const safetyMarginPct = bpsToPct(inputs.safetyMarginBps);
  const fixedFeesAsPctOfPosition =
    inputs.positionSizeSol > 0 ? ((inputs.networkFeeSol + inputs.priorityFeeSol) / inputs.positionSizeSol) * 100 : Infinity;

  const netEdgePct =
    inputs.expectedGrossMovePct -
    dexFeePct -
    swapFeePct -
    fixedFeesAsPctOfPosition -
    inputs.slippagePct -
    inputs.priceImpactPct -
    safetyMarginPct;

  const netEdgeSol = (netEdgePct / 100) * inputs.positionSizeSol;

  return {
    netEdgePct,
    netEdgeSol,
    isFavorable: Number.isFinite(netEdgePct) && netEdgePct > 0,
    breakdown: {
      grossMovePct: inputs.expectedGrossMovePct,
      dexFeePct: -dexFeePct,
      swapFeePct: -swapFeePct,
      fixedFeesAsPctOfPosition: -fixedFeesAsPctOfPosition,
      slippagePct: -inputs.slippagePct,
      priceImpactPct: -inputs.priceImpactPct,
      safetyMarginPct: -safetyMarginPct,
    },
  };
}
