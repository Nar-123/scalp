import { describe, expect, it } from 'vitest';
import { canOpenNewPosition } from '../../src/risk/exposureManager.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';

describe('canOpenNewPosition', () => {
  it('allows opening when under both the count cap and the exposure cap', () => {
    const result = canOpenNewPosition([], HARD_RISK_PARAMETERS);
    expect(result.allowed).toBe(true);
  });

  it('blocks when at the max concurrent positions count, independent of exposure', () => {
    const positions = Array.from({ length: HARD_RISK_PARAMETERS.maxConcurrentPositions }, (_, i) => ({
      tradeId: `t${i}`,
      mint: `m${i}`,
      entrySizeSol: 0.01, // tiny, well under exposure cap
    }));
    const result = canOpenNewPosition(positions, HARD_RISK_PARAMETERS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('max_concurrent_positions_reached');
  });

  it('blocks when under the count cap but adding one more would exceed total exposure', () => {
    const positions = [{ tradeId: 't1', mint: 'm1', entrySizeSol: HARD_RISK_PARAMETERS.maxTotalExposureSol }];
    const result = canOpenNewPosition(positions, HARD_RISK_PARAMETERS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('max_total_exposure_reached');
  });
});
