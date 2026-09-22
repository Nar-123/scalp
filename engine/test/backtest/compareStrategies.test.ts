import { describe, expect, it } from 'vitest';
import { compareStrategies } from '../../src/backtest/compareStrategies.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleSnapshot, snapshotsByMint } from './fixtures.js';

describe('compareStrategies', () => {
  it('runs the parent and every candidate against the identical snapshot set and assumptions', () => {
    const snapshots = snapshotsByMint([
      entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: 40_000 }),
      entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: 42_000, priceSol: 1.03 }),
    ]);

    const tighterFilters = {
      ...DEFAULT_CONFIG,
      filters: { ...DEFAULT_CONFIG.filters, minLiquiditySol: 1000 }, // so tight the candidate takes no trades
    };

    const result = compareStrategies(
      snapshots,
      DEFAULT_ASSUMPTIONS,
      { label: 'baseline-v1', config: DEFAULT_CONFIG },
      [{ label: 'candidate-tight-liquidity', config: tighterFilters }],
    );

    expect(result.parent.trades).toHaveLength(1);
    expect(result.candidates[0]!.trades).toHaveLength(0);
    expect(result.parent.strategyLabel).toBe('baseline-v1');
    expect(result.candidates[0]!.strategyLabel).toBe('candidate-tight-liquidity');
  });

  it('reports exactly which tunable groups differ, for audit logging (candidate fairness)', () => {
    const snapshots = snapshotsByMint([entryEligibleSnapshot({ observedAtMs: 40_000 })]);
    const candidateConfig = {
      ...DEFAULT_CONFIG,
      filters: { ...DEFAULT_CONFIG.filters, minLiquiditySol: 25 },
    };

    const result = compareStrategies(
      snapshots,
      DEFAULT_ASSUMPTIONS,
      { label: 'baseline-v1', config: DEFAULT_CONFIG },
      [{ label: 'candidate-a', config: candidateConfig }],
    );

    expect(result.diffs).toEqual([{ label: 'candidate-a', changedFields: ['filters'] }]);
  });

  it('reports no changed fields for an identical candidate', () => {
    const snapshots = snapshotsByMint([entryEligibleSnapshot({ observedAtMs: 40_000 })]);
    const result = compareStrategies(
      snapshots,
      DEFAULT_ASSUMPTIONS,
      { label: 'baseline-v1', config: DEFAULT_CONFIG },
      [{ label: 'identical-clone', config: DEFAULT_CONFIG }],
    );
    expect(result.diffs).toEqual([{ label: 'identical-clone', changedFields: [] }]);
  });
});
