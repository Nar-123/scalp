import { describe, expect, it } from 'vitest';
import { checkReversal } from '../../../src/exit/conditions/reversalDetector.js';

const cfg = { reversalDropFromPeakPct: 2 };

describe('checkReversal', () => {
  it('does not trigger on positive momentum', () => {
    expect(checkReversal(1, cfg)).toBe(false);
  });

  it('does not trigger on a mild negative swing under the threshold', () => {
    expect(checkReversal(-1.9, cfg)).toBe(false);
  });

  it('triggers exactly at the negative threshold boundary', () => {
    expect(checkReversal(-2, cfg)).toBe(true);
  });

  it('triggers on a sharp negative swing beyond the threshold', () => {
    expect(checkReversal(-5, cfg)).toBe(true);
  });
});
