import { describe, expect, it } from 'vitest';
import { checkMomentumTakeProfit } from '../../../src/exit/conditions/momentumTakeProfit.js';

const cfg = { momentumTpMinPct: 4 };

describe('checkMomentumTakeProfit', () => {
  it('does not trigger below the pnl threshold', () => {
    expect(checkMomentumTakeProfit(3, 1, cfg)).toBe(false);
  });

  it('does not trigger above pnl threshold if momentum has already stalled', () => {
    expect(checkMomentumTakeProfit(5, -0.1, cfg)).toBe(false);
  });

  it('triggers when pnl is above threshold and momentum is still positive', () => {
    expect(checkMomentumTakeProfit(5, 0.5, cfg)).toBe(true);
  });

  it('triggers exactly at the pnl boundary with positive momentum', () => {
    expect(checkMomentumTakeProfit(4, 0.1, cfg)).toBe(true);
  });
});
