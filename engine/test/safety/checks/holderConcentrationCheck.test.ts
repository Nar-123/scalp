import { describe, expect, it } from 'vitest';
import { evaluateHolderConcentration } from '../../../src/safety/checks/holderConcentrationCheck.js';

describe('evaluateHolderConcentration', () => {
  it('fails closed on invalid (zero) total supply', () => {
    const result = evaluateHolderConcentration(
      { largestAccounts: [], totalSupply: 0n, excludeAddresses: [] },
      60,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('invalid_supply');
  });

  it('passes when top-10 concentration is under the limit', () => {
    const result = evaluateHolderConcentration(
      {
        largestAccounts: [
          { address: 'a', amount: 100n },
          { address: 'b', amount: 100n },
        ],
        totalSupply: 1000n,
        excludeAddresses: [],
      },
      60,
    );
    expect(result.passed).toBe(true);
    expect(result.top10Pct).toBeCloseTo(20, 5);
  });

  it('fails when top-10 concentration exceeds the limit', () => {
    const result = evaluateHolderConcentration(
      {
        largestAccounts: [
          { address: 'a', amount: 400n },
          { address: 'b', amount: 400n },
        ],
        totalSupply: 1000n,
        excludeAddresses: [],
      },
      60,
    );
    expect(result.passed).toBe(false);
    expect(result.top10Pct).toBeCloseTo(80, 5);
  });

  it('excludes LP/burn addresses from the concentration calculation', () => {
    const result = evaluateHolderConcentration(
      {
        largestAccounts: [
          { address: 'lp-vault', amount: 900n },
          { address: 'holder', amount: 50n },
        ],
        totalSupply: 1000n,
        excludeAddresses: ['lp-vault'],
      },
      60,
    );
    expect(result.passed).toBe(true);
    expect(result.top10Pct).toBeCloseTo(5, 5);
  });

  it('only considers the top 10 accounts even if more are supplied', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ address: `holder${i}`, amount: 10n }));
    const result = evaluateHolderConcentration({ largestAccounts: many, totalSupply: 1000n, excludeAddresses: [] }, 60);
    expect(result.top10Pct).toBeCloseTo(10, 5); // 10 accounts * 10 / 1000 = 10%, not 15*10/1000=15%
  });
});
