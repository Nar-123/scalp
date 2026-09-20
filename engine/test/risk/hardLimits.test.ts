import { describe, expect, it } from 'vitest';
import { hardLimitsFrom } from '../../src/risk/hardLimits.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';

describe('hardLimitsFrom', () => {
  it('derives every limit directly from HARD_RISK_PARAMETERS', () => {
    const limits = hardLimitsFrom(HARD_RISK_PARAMETERS);
    expect(limits.maxAmountSol).toBe(HARD_RISK_PARAMETERS.positionSizeSol);
    expect(limits.maxSlippagePct).toBe(HARD_RISK_PARAMETERS.maxSlippageBps / 100);
    expect(limits.maxPriceImpactPct).toBe(HARD_RISK_PARAMETERS.maxPriceImpactBps / 100);
    expect(limits.maxExposureSol).toBe(HARD_RISK_PARAMETERS.maxTotalExposureSol);
  });
});
