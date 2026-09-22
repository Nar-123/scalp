import { describe, expect, it } from 'vitest';
import { checkLiquidityDeterioration } from '../../../src/exit/conditions/liquidityDeterioration.js';

const cfg = { liquidityDeteriorationPct: 30 };

describe('checkLiquidityDeterioration', () => {
  it('does not trigger on a mild liquidity drop', () => {
    expect(checkLiquidityDeterioration(100, 80, cfg)).toBe(false); // -20%
  });

  it('triggers once liquidity has dropped past the threshold', () => {
    expect(checkLiquidityDeterioration(100, 60, cfg)).toBe(true); // -40%
  });

  it('does not trigger when liquidity increased', () => {
    expect(checkLiquidityDeterioration(100, 150, cfg)).toBe(false);
  });

  it('fails closed when entry liquidity is zero/invalid', () => {
    expect(checkLiquidityDeterioration(0, 50, cfg)).toBe(true);
  });

  it('fails closed when current liquidity is non-finite', () => {
    expect(checkLiquidityDeterioration(100, NaN, cfg)).toBe(true);
  });
});
