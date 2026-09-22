import { describe, expect, it } from 'vitest';
import { evaluateSellability } from '../../../src/safety/checks/sellabilityHeuristic.js';

describe('evaluateSellability', () => {
  it('fails closed when no quote is available', () => {
    expect(evaluateSellability(null, 5).passed).toBe(false);
  });

  it('fails when no sell route is found at all (likely honeypot)', () => {
    const result = evaluateSellability({ buyPriceImpactPct: 1, sellPriceImpactPct: null }, 5);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('no_sell_route_found');
  });

  it('passes when round-trip loss is within the allowed threshold', () => {
    const result = evaluateSellability({ buyPriceImpactPct: 1, sellPriceImpactPct: 1 }, 5);
    expect(result.passed).toBe(true);
    expect(result.impliedRoundTripLossPct).toBeCloseTo(2, 5);
  });

  it('fails when round-trip loss exceeds the allowed threshold', () => {
    const result = evaluateSellability({ buyPriceImpactPct: 3, sellPriceImpactPct: 4 }, 5);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('excessive_round_trip_loss');
  });
});
