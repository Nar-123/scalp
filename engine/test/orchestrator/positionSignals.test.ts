import { describe, expect, it } from 'vitest';
import { computeRecentMomentumPct, computeRecentVolatilityPct } from '../../src/orchestrator/positionSignals.js';
import type { PricePoint } from '../../src/types/trade.js';

describe('computeRecentMomentumPct', () => {
  it('returns 0 when there is no history old enough to compare against', () => {
    expect(computeRecentMomentumPct([{ priceSol: 1, liquiditySol: 40, timestampMs: 9900 }], 1.01, 10_000)).toBe(0);
  });

  it('computes percent change over the ~3s window', () => {
    const history: PricePoint[] = [
      { priceSol: 1, liquiditySol: 40, timestampMs: 6000 },
      { priceSol: 1.01, liquiditySol: 40, timestampMs: 9000 },
    ];
    expect(computeRecentMomentumPct(history, 1.02, 10_000)).toBeCloseTo(2, 5); // vs price at t=6000 (10000-3000ms window)
  });
});

describe('computeRecentVolatilityPct', () => {
  it('returns 0 for empty history', () => {
    expect(computeRecentVolatilityPct([], 1)).toBe(0);
  });

  it('computes peak-to-trough range as a percent of entry price', () => {
    const history: PricePoint[] = [
      { priceSol: 0.98, liquiditySol: 40, timestampMs: 0 },
      { priceSol: 1.03, liquiditySol: 40, timestampMs: 1000 },
      { priceSol: 1.0, liquiditySol: 40, timestampMs: 2000 },
    ];
    expect(computeRecentVolatilityPct(history, 1)).toBeCloseTo(5, 5); // (1.03-0.98)/1*100
  });

  it('fails closed to 0 rather than dividing by a non-positive entry price', () => {
    expect(computeRecentVolatilityPct([{ priceSol: 1, liquiditySol: 40, timestampMs: 0 }], 0)).toBe(0);
  });
});
