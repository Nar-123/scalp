import { describe, expect, it } from 'vitest';
import { assertHardRiskUnmodified, HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';

describe('HARD_RISK_PARAMETERS', () => {
  it('matches the frozen spec values exactly', () => {
    expect(HARD_RISK_PARAMETERS.positionSizeSol).toBe(0.3);
    expect(HARD_RISK_PARAMETERS.dailyLossLimitPct).toBe(10);
    expect(HARD_RISK_PARAMETERS.maxReentriesPerToken).toBe(5);
    expect(HARD_RISK_PARAMETERS.emergencyStopEnabled).toBe(true);
  });

  it('is frozen and cannot be mutated', () => {
    expect(Object.isFrozen(HARD_RISK_PARAMETERS)).toBe(true);
    expect(() => {
      // @ts-expect-error -- intentionally attempting an illegal mutation
      HARD_RISK_PARAMETERS.positionSizeSol = 999;
    }).toThrow();
    expect(HARD_RISK_PARAMETERS.positionSizeSol).toBe(0.3);
  });

  it('assertHardRiskUnmodified does not throw under normal conditions', () => {
    expect(() => assertHardRiskUnmodified()).not.toThrow();
  });
});
