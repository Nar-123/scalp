import { describe, expect, it } from 'vitest';
import { isWithinAgeWindow, tokenAgeSeconds } from '../../src/discovery/tokenRegistry.js';

const cfg = { minTokenAgeSec: 30, maxTokenAgeSec: 900 };

describe('isWithinAgeWindow', () => {
  const now = 1_000_000_000;

  it('excludes a token younger than the minimum age', () => {
    expect(isWithinAgeWindow(now - 29_000, now, cfg)).toBe(false);
  });

  it('includes a token exactly at the minimum age boundary', () => {
    expect(isWithinAgeWindow(now - 30_000, now, cfg)).toBe(true);
  });

  it('includes a token just under the maximum age', () => {
    expect(isWithinAgeWindow(now - 899_000, now, cfg)).toBe(true);
  });

  it('excludes a token exactly at the maximum age boundary', () => {
    expect(isWithinAgeWindow(now - 900_000, now, cfg)).toBe(false);
  });

  it('excludes a token discovered in the future (negative age)', () => {
    expect(isWithinAgeWindow(now + 5000, now, cfg)).toBe(false);
  });

  it('fails closed on non-finite timestamps', () => {
    expect(isWithinAgeWindow(NaN, now, cfg)).toBe(false);
    expect(isWithinAgeWindow(now - 60_000, NaN, cfg)).toBe(false);
  });
});

describe('tokenAgeSeconds', () => {
  it('computes age in seconds, clamped at zero', () => {
    expect(tokenAgeSeconds(1000, 6000)).toBe(5);
    expect(tokenAgeSeconds(6000, 1000)).toBe(0);
  });
});
