import { describe, expect, it } from 'vitest';
import { checkMaxHoldTimeout } from '../../../src/exit/conditions/maxHoldTimeout.js';

const cfg = { maxHoldTimeSec: 30 };

describe('checkMaxHoldTimeout', () => {
  it('does not trigger before the max hold time', () => {
    expect(checkMaxHoldTimeout(0, 29_000, cfg)).toBe(false);
  });

  it('triggers exactly at the boundary', () => {
    expect(checkMaxHoldTimeout(0, 30_000, cfg)).toBe(true);
  });

  it('triggers well past the boundary', () => {
    expect(checkMaxHoldTimeout(0, 60_000, cfg)).toBe(true);
  });
});
