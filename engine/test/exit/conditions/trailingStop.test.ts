import { describe, expect, it } from 'vitest';
import { checkTrailingStop } from '../../../src/exit/conditions/trailingStop.js';
import type { Position } from '../../../src/types/trade.js';

const cfg = { trailingActivationPct: 3, trailingDistancePct: 1.5 };

function position(overrides: Partial<Position> = {}): Position {
  return {
    tradeId: 't1',
    mint: 'MINT',
    poolAddress: null,
    entryTimeMs: 0,
    entryPriceSol: 1,
    entrySizeSol: 0.3,
    entryFilledAmountSol: 0.29,
    reentryIndex: 0,
    strategyVersion: 'baseline-v1',
    dryRun: true,
    priceHistory: [],
    peakPriceSol: 1,
    troughPriceSol: 1,
    ...overrides,
  };
}

describe('checkTrailingStop', () => {
  it('does not activate before the peak gain reaches the activation threshold', () => {
    const pos = position({ entryPriceSol: 1, peakPriceSol: 1.02 }); // +2%, below 3% activation
    expect(checkTrailingStop(pos, 1.0, cfg)).toBe(false);
  });

  it('does not trigger once activated if price has not retraced enough', () => {
    const pos = position({ entryPriceSol: 1, peakPriceSol: 1.05 }); // +5%, activated
    expect(checkTrailingStop(pos, 1.045, cfg)).toBe(false); // ~-0.48% from peak, under 1.5% distance
  });

  it('triggers once activated and price retraces past the trailing distance from peak', () => {
    const pos = position({ entryPriceSol: 1, peakPriceSol: 1.05 });
    expect(checkTrailingStop(pos, 1.03, cfg)).toBe(true); // ~-1.9% from peak, past 1.5%
  });
});
