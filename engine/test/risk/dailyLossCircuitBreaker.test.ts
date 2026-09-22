import { describe, expect, it } from 'vitest';
import { isDailyLossLimitBreached, shouldLatchCircuitBreaker } from '../../src/risk/dailyLossCircuitBreaker.js';

describe('isDailyLossLimitBreached', () => {
  it('is not breached just under the limit', () => {
    expect(isDailyLossLimitBreached(-0.999, 10, 10)).toBe(false);
  });

  it('is breached exactly at the limit boundary', () => {
    expect(isDailyLossLimitBreached(-1, 10, 10)).toBe(true);
  });

  it('is breached beyond the limit', () => {
    expect(isDailyLossLimitBreached(-2, 10, 10)).toBe(true);
  });

  it('is not breached when in profit', () => {
    expect(isDailyLossLimitBreached(5, 10, 10)).toBe(false);
  });

  it('fails closed on a non-positive starting balance', () => {
    expect(isDailyLossLimitBreached(0, 0, 10)).toBe(true);
    expect(isDailyLossLimitBreached(0, -5, 10)).toBe(true);
  });

  it('fails closed on non-finite inputs', () => {
    expect(isDailyLossLimitBreached(NaN, 10, 10)).toBe(true);
  });
});

describe('shouldLatchCircuitBreaker', () => {
  it('stays latched once already triggered, even if PnL recovers', () => {
    expect(shouldLatchCircuitBreaker(true, 5, 10, 10)).toBe(true);
  });

  it('latches on first breach', () => {
    expect(shouldLatchCircuitBreaker(false, -1, 10, 10)).toBe(true);
  });

  it('does not latch when not yet triggered and not breached', () => {
    expect(shouldLatchCircuitBreaker(false, -0.5, 10, 10)).toBe(false);
  });
});
