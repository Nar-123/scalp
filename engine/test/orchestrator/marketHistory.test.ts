import { describe, expect, it } from 'vitest';
import { checkTickDataQuality } from '../../src/shadow/dataQualityMonitor.js';
import { MarketHistoryTracker } from '../../src/orchestrator/marketHistory.js';
import type { MarketSnapshot } from '../../src/types/market.js';
import { entryEligibleTick } from '../shadow/fixtures.js';

function snap(observedAtMs: number, volume1mSol: number | null): MarketSnapshot {
  return {
    mint: 'M', priceSol: 1, liquiditySol: 40, volume1mSol, buySellRatio: 2, priceVelocity5sPct: 0,
    volumeAccelerationX: null, txVelocityPerSec: 0, estimatedSlippagePct: 0.3, estimatedPriceImpactPct: 0.2, observedAtMs,
  };
}

describe('F. volume acceleration compares the SAME quantity (1-minute SOL volume) in the SAME unit', () => {
  it('is current / reference, both volume1mSol ~60s apart', () => {
    const h = new MarketHistoryTracker();
    h.record(snap(0, 4));
    expect(h.computeVolumeAccelerationX('M', 8, 60_000)).toBe(2);
  });

  it('is unavailable (null) when the current 1-minute volume is unavailable -- never a ratio of mixed units', () => {
    const h = new MarketHistoryTracker();
    h.record(snap(0, 4));
    expect(h.computeVolumeAccelerationX('M', null, 60_000)).toBeNull();
  });

  it('is unavailable (null) when the reference observation had no 1-minute volume', () => {
    const h = new MarketHistoryTracker();
    h.record(snap(0, null));
    expect(h.computeVolumeAccelerationX('M', 8, 60_000)).toBeNull();
  });

  it('keeps the existing degenerate behavior: +Infinity when the reference volume is zero or there is no reference', () => {
    const h = new MarketHistoryTracker();
    expect(h.computeVolumeAccelerationX('M', 3, 60_000)).toBe(Number.POSITIVE_INFINITY);
    h.record(snap(0, 0));
    expect(h.computeVolumeAccelerationX('M', 3, 60_000)).toBe(Number.POSITIVE_INFINITY);
    expect(h.computeVolumeAccelerationX('M', 0, 60_000)).toBe(0);
  });
});

describe('G. Infinity / NaN policy from Phase 5.1 is unchanged', () => {
  it('+Infinity ratio => degenerate_ratio warning (not blocking)', () => {
    const [issue, ...rest] = checkTickDataQuality('M', null, null, entryEligibleTick({ buySellRatio: Number.POSITIVE_INFINITY, volumeAccelerationX: Number.POSITIVE_INFINITY }));
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({ kind: 'degenerate_ratio', severity: 'warning' });
  });

  it('NaN and -Infinity => malformed_market_data reject', () => {
    for (const bad of [{ volumeAccelerationX: Number.NaN }, { volumeAccelerationX: Number.NEGATIVE_INFINITY }, { buySellRatio: Number.NaN }]) {
      const issues = checkTickDataQuality('M', null, null, entryEligibleTick(bad));
      expect(issues.some((i) => i.kind === 'malformed_market_data' && i.severity === 'reject')).toBe(true);
    }
  });

  it('an unavailable (null) 1-minute volume is not a data-quality event; the baseline filter handles it', () => {
    expect(checkTickDataQuality('M', null, null, entryEligibleTick({ volume1mSol: null, volumeAccelerationX: null }))).toEqual([]);
  });
});
