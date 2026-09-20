import type { HardRiskParameters } from '../config/hardRisk.js';

/**
 * Translates HARD_RISK_PARAMETERS into the shape a transaction-safety check
 * needs, so nothing outside config/risk/orchestrator ever imports
 * hardRisk.ts directly (enforced by eslint.config.js's no-restricted-imports
 * rule) -- execution/transactionSafety.ts imports HardLimits + this
 * function from here instead of reaching into hardRisk.ts itself.
 */
export interface HardLimits {
  maxAmountSol: number;
  maxSlippagePct: number;
  maxPriceImpactPct: number;
  maxExposureSol: number;
}

export function hardLimitsFrom(hard: HardRiskParameters): HardLimits {
  return {
    maxAmountSol: hard.positionSizeSol,
    maxSlippagePct: hard.maxSlippageBps / 100,
    maxPriceImpactPct: hard.maxPriceImpactBps / 100,
    maxExposureSol: hard.maxTotalExposureSol,
  };
}
