import { describe, expect, it } from 'vitest';
import { detectDataQualityIssues, detectDataQualityIssuesAcrossMints } from '../../src/backtest/dataQuality.js';
import { entryEligibleSnapshot, snapshotsByMint } from './fixtures.js';

describe('detectDataQualityIssues', () => {
  it('reports no issues for a clean, chronologically-ordered sequence', () => {
    const snaps = [entryEligibleSnapshot({ observedAtMs: 40_000 }), entryEligibleSnapshot({ observedAtMs: 42_000 })];
    expect(detectDataQualityIssues('MINT_A', snaps)).toEqual([]);
  });

  it('detects a duplicate observedAtMs', () => {
    const snaps = [entryEligibleSnapshot({ observedAtMs: 40_000 }), entryEligibleSnapshot({ observedAtMs: 40_000 })];
    const issues = detectDataQualityIssues('MINT_A', snaps);
    expect(issues.some((i) => i.kind === 'duplicate_record')).toBe(true);
  });

  it('detects non-chronological order', () => {
    const snaps = [entryEligibleSnapshot({ observedAtMs: 42_000 }), entryEligibleSnapshot({ observedAtMs: 40_000 })];
    const issues = detectDataQualityIssues('MINT_A', snaps);
    expect(issues.some((i) => i.kind === 'non_chronological_order')).toBe(true);
  });

  it('detects an impossible (non-positive) price without treating null as impossible', () => {
    const snaps = [entryEligibleSnapshot({ priceSol: 0 }), entryEligibleSnapshot({ observedAtMs: 41_000, priceSol: null })];
    const issues = detectDataQualityIssues('MINT_A', snaps);
    expect(issues.some((i) => i.kind === 'impossible_price')).toBe(true);
    expect(issues.length).toBe(1);
  });

  it('detects negative liquidity and negative volume separately', () => {
    const snaps = [entryEligibleSnapshot({ liquiditySol: -5, volume1mSol: -1 })];
    const issues = detectDataQualityIssues('MINT_A', snaps);
    expect(issues.some((i) => i.kind === 'negative_liquidity')).toBe(true);
    expect(issues.some((i) => i.kind === 'negative_volume')).toBe(true);
  });

  it('detects an impossible token age (observed before discovery)', () => {
    const snaps = [entryEligibleSnapshot({ discoveredAtMs: 100_000, observedAtMs: 40_000 })];
    const issues = detectDataQualityIssues('MINT_A', snaps);
    expect(issues.some((i) => i.kind === 'impossible_token_age')).toBe(true);
  });

  it('detects a missing/non-finite timestamp', () => {
    const snaps = [entryEligibleSnapshot({ observedAtMs: Number.NaN })];
    const issues = detectDataQualityIssues('MINT_A', snaps);
    expect(issues.some((i) => i.kind === 'missing_timestamp')).toBe(true);
  });

  it('aggregates issues across every mint via detectDataQualityIssuesAcrossMints', () => {
    const byMint = snapshotsByMint([
      entryEligibleSnapshot({ mint: 'MINT_A', liquiditySol: -1 }),
      entryEligibleSnapshot({ mint: 'MINT_B', observedAtMs: 41_000 }),
    ]);
    const issues = detectDataQualityIssuesAcrossMints(byMint);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.mint).toBe('MINT_A');
  });
});
