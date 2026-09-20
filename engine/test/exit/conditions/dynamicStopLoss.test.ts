import { describe, expect, it } from 'vitest';
import { checkDynamicStopLoss, computeDynamicStopLossPct } from '../../../src/exit/conditions/dynamicStopLoss.js';

const cfg = { dynamicSlMinPct: 2, dynamicSlMaxPct: 3 };

describe('computeDynamicStopLossPct', () => {
  it('clamps to the minimum for low volatility', () => {
    expect(computeDynamicStopLossPct(0.5, cfg)).toBe(2);
  });

  it('clamps to the maximum for high volatility', () => {
    expect(computeDynamicStopLossPct(10, cfg)).toBe(3);
  });

  it('passes through volatility within the band', () => {
    expect(computeDynamicStopLossPct(2.5, cfg)).toBe(2.5);
  });
});

describe('checkDynamicStopLoss', () => {
  it('does not trigger above the (negative) threshold', () => {
    expect(checkDynamicStopLoss(-1, 1, cfg)).toBe(false); // band clamps to 2%, -1% pnl is fine
  });

  it('triggers once pnl breaches the volatility-sized band', () => {
    expect(checkDynamicStopLoss(-2.5, 1, cfg)).toBe(true); // band=2%, -2.5% breaches
  });

  it('widens the allowed loss band under high volatility', () => {
    expect(checkDynamicStopLoss(-2.5, 10, cfg)).toBe(false); // band clamps to 3%, -2.5% is within it
  });
});
