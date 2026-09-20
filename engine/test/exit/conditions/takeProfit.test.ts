import { describe, expect, it } from 'vitest';
import { checkQuickTakeProfit } from '../../../src/exit/conditions/takeProfit.js';

const cfg = { quickTpMinPct: 2 };

describe('checkQuickTakeProfit', () => {
  it('does not trigger below the threshold', () => {
    expect(checkQuickTakeProfit(1.9, cfg)).toBe(false);
  });

  it('triggers exactly at the threshold', () => {
    expect(checkQuickTakeProfit(2, cfg)).toBe(true);
  });

  it('triggers above the threshold', () => {
    expect(checkQuickTakeProfit(5, cfg)).toBe(true);
  });
});
