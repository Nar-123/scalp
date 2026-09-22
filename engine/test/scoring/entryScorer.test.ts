import { describe, expect, it } from 'vitest';
import { computeEntryScore } from '../../src/scoring/entryScorer.js';

const weights = {
  momentum: 1,
  volume: 1,
  buyPressure: 1,
  txVelocity: 0.5,
  liquidityQuality: 1,
  slippageRisk: 1,
  priceImpactRisk: 1,
};

const baselineInputs = {
  momentumPct5s: 1,
  volumeAccelerationX: 1.5,
  buySellRatio: 1.5,
  txVelocityPerSec: 1,
  liquiditySol: 20,
  estimatedSlippagePct: 0.3,
  estimatedPriceImpactPct: 0.5,
};

describe('computeEntryScore', () => {
  it('computes the hand-computed score for a known input vector', () => {
    const result = computeEntryScore(baselineInputs, weights, 3);
    // momentum=1, volume=0.5, buyPressure=0.5, txVelocity=0.5, liquidityQuality=1, slippage=-0.3, impact=-0.5
    expect(result.score).toBeCloseTo(1 + 0.5 + 0.5 + 0.5 + 1 - 0.3 - 0.5, 5);
  });

  it('is monotonically increasing in momentum', () => {
    const low = computeEntryScore({ ...baselineInputs, momentumPct5s: 1 }, weights, 3);
    const high = computeEntryScore({ ...baselineInputs, momentumPct5s: 5 }, weights, 3);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('is monotonically decreasing in price impact risk', () => {
    const low = computeEntryScore({ ...baselineInputs, estimatedPriceImpactPct: 0.2 }, weights, 3);
    const high = computeEntryScore({ ...baselineInputs, estimatedPriceImpactPct: 5 }, weights, 3);
    expect(high.score).toBeLessThan(low.score);
  });

  it('passesThreshold reflects the configured minimum score', () => {
    const passing = computeEntryScore(baselineInputs, weights, 1);
    const failing = computeEntryScore(baselineInputs, weights, 100);
    expect(passing.passesThreshold).toBe(true);
    expect(failing.passesThreshold).toBe(false);
  });

  it('treats non-finite inputs as the worst case rather than propagating NaN', () => {
    const result = computeEntryScore({ ...baselineInputs, momentumPct5s: NaN }, weights, 3);
    expect(Number.isNaN(result.score)).toBe(false);
    expect(result.passesThreshold).toBe(false);
  });
});
