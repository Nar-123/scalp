import type { AppConfig } from '../config/schema.js';
import type { EntrySignalInputs, EntryScoreResult } from '../types/signals.js';
import { isFiniteNumber } from '../utils/math.js';

const LIQUIDITY_NORMALIZATION_BASELINE_SOL = 20; // matches spec's MIN_LIQUIDITY baseline

/**
 * Deterministic entry score, per spec section 5:
 *
 *   score = momentum + volume + buyPressure + txVelocity + liquidityQuality
 *           - slippageRisk - priceImpactRisk
 *
 * Each raw signal is normalized to a roughly comparable scale before the
 * configurable weight is applied, so that hitting exactly the spec's
 * baseline filter values contributes about one weighted "point":
 *   - momentum: raw 5s price-velocity percent
 *   - volume: acceleration multiplier minus 1 (1.5x accel -> 0.5)
 *   - buyPressure: buy/sell ratio minus 1 (1.5 ratio -> 0.5)
 *   - txVelocity: raw transactions/sec
 *   - liquidityQuality: liquiditySol / 20 SOL baseline
 *   - slippageRisk / priceImpactRisk: raw percentages, subtracted
 *
 * Any non-finite input is treated as the worst case for that component
 * (fails closed) rather than propagating NaN through the score.
 */
export function computeEntryScore(
  inputs: EntrySignalInputs,
  weights: AppConfig['scoring']['weights'],
  minScore: number,
): EntryScoreResult {
  const safe = (value: number, worstCase: number): number => (isFiniteNumber(value) ? value : worstCase);

  const momentum = weights.momentum * safe(inputs.momentumPct5s, -1000);
  const volume = weights.volume * (safe(inputs.volumeAccelerationX, 0) - 1);
  const buyPressure = weights.buyPressure * (safe(inputs.buySellRatio, 0) - 1);
  const txVelocity = weights.txVelocity * safe(inputs.txVelocityPerSec, 0);
  const liquidityQuality =
    weights.liquidityQuality * (safe(inputs.liquiditySol, 0) / LIQUIDITY_NORMALIZATION_BASELINE_SOL);
  const slippageRisk = weights.slippageRisk * safe(inputs.estimatedSlippagePct, 1000);
  const priceImpactRisk = weights.priceImpactRisk * safe(inputs.estimatedPriceImpactPct, 1000);

  const components = {
    momentum,
    volume,
    buyPressure,
    txVelocity,
    liquidityQuality,
    slippageRisk: -slippageRisk,
    priceImpactRisk: -priceImpactRisk,
  };

  const score = momentum + volume + buyPressure + txVelocity + liquidityQuality - slippageRisk - priceImpactRisk;

  return {
    score,
    components,
    passesThreshold: score >= minScore,
    minScore,
  };
}
