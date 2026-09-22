import { describe, expect, it } from 'vitest';
import { computeExpectedNetEdge } from '../../src/scoring/expectedNetEdge.js';

const baseInputs = {
  expectedGrossMovePct: 2,
  dexFeeBps: 25,
  swapFeeBps: 5,
  networkFeeSol: 0.000005,
  priorityFeeSol: 0.0005,
  slippagePct: 0.3,
  priceImpactPct: 0.5,
  sellPriceImpactPct: 0.5, // Phase 5.6H: the edge is a complete round trip and needs the SELL impact too
  safetyMarginBps: 50,
  positionSizeSol: 0.3,
};

describe('computeExpectedNetEdge', () => {
  it('is favorable when the gross move comfortably outweighs all costs', () => {
    const result = computeExpectedNetEdge({ ...baseInputs, expectedGrossMovePct: 10 });
    expect(result.isFavorable).toBe(true);
    expect(result.netEdgePct).toBeGreaterThan(0);
  });

  it('is unfavorable when fees/slippage/impact dominate a small expected move', () => {
    const result = computeExpectedNetEdge({ ...baseInputs, expectedGrossMovePct: 0.1 });
    expect(result.isFavorable).toBe(false);
    expect(result.netEdgePct).toBeLessThan(0);
  });

  it('converts netEdgePct to netEdgeSol consistently with positionSizeSol', () => {
    const result = computeExpectedNetEdge(baseInputs);
    expect(result.netEdgeSol).toBeCloseTo((result.netEdgePct / 100) * baseInputs.positionSizeSol, 10);
  });

  it('treats a zero position size as maximally unfavorable rather than dividing by zero', () => {
    const result = computeExpectedNetEdge({ ...baseInputs, positionSizeSol: 0 });
    expect(result.isFavorable).toBe(false);
    expect(Number.isFinite(result.netEdgePct)).toBe(false);
  });

  it('breakdown sums to the total netEdgePct', () => {
    const result = computeExpectedNetEdge(baseInputs);
    const sum = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(result.netEdgePct, 8);
  });
});
