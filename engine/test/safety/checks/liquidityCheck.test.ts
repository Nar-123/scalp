import { describe, expect, it } from 'vitest';
import { evaluateLiquidity } from '../../../src/safety/checks/liquidityCheck.js';

describe('evaluateLiquidity', () => {
  it('fails closed when liquidity is null', () => {
    expect(evaluateLiquidity(null, 20).passed).toBe(false);
  });

  it('fails closed when liquidity is NaN', () => {
    expect(evaluateLiquidity(NaN, 20).passed).toBe(false);
  });

  it('fails when below the minimum', () => {
    const result = evaluateLiquidity(19.99, 20);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('liquidity_below_minimum');
  });

  it('passes at exactly the minimum boundary', () => {
    expect(evaluateLiquidity(20, 20).passed).toBe(true);
  });

  it('passes above the minimum', () => {
    expect(evaluateLiquidity(100, 20).passed).toBe(true);
  });
});
