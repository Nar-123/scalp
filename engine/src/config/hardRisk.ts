import { createHash } from 'node:crypto';

/**
 * Hard risk parameters, per the frozen New-Token Ultra Scalper V1 spec (section 10).
 *
 * This module is structurally isolated: no learning/analytics/AI code may import it
 * (enforced by directory convention + the `no-restricted-imports` eslint rule in
 * .eslintrc). Nothing outside this file may construct a HardRiskParameters value --
 * the only way to get one is HARD_RISK_PARAMETERS itself, which is frozen.
 */
export interface HardRiskParameters {
  readonly positionSizeSol: number;
  readonly dailyLossLimitPct: number;
  readonly maxReentriesPerToken: number;
  readonly maxConcurrentPositions: number;
  readonly maxTotalExposureSol: number;
  readonly maxSlippageBps: number;
  readonly maxPriceImpactBps: number;
  readonly emergencyStopEnabled: boolean;
}

const RAW_HARD_RISK_PARAMETERS: HardRiskParameters = {
  positionSizeSol: 0.3,
  dailyLossLimitPct: 10,
  maxReentriesPerToken: 5,
  maxConcurrentPositions: 3,
  maxTotalExposureSol: 0.9,
  maxSlippageBps: 100,
  maxPriceImpactBps: 100,
  emergencyStopEnabled: true,
};

export const HARD_RISK_PARAMETERS: HardRiskParameters = Object.freeze({
  ...RAW_HARD_RISK_PARAMETERS,
});

function fingerprint(params: HardRiskParameters): string {
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

const EXPECTED_FINGERPRINT = fingerprint(RAW_HARD_RISK_PARAMETERS);

/**
 * Fatal-exits the process if HARD_RISK_PARAMETERS has been tampered with at
 * runtime (e.g. via prototype pollution or a bad merge). Call once at startup.
 */
export function assertHardRiskUnmodified(): void {
  if (!Object.isFrozen(HARD_RISK_PARAMETERS)) {
    throw new Error('FATAL: HARD_RISK_PARAMETERS is not frozen. Refusing to start.');
  }
  const actual = fingerprint(HARD_RISK_PARAMETERS);
  if (actual !== EXPECTED_FINGERPRINT) {
    throw new Error(
      `FATAL: HARD_RISK_PARAMETERS fingerprint mismatch (expected ${EXPECTED_FINGERPRINT}, got ${actual}). Refusing to start.`,
    );
  }
}
