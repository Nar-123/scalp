import type { HardRiskParameters } from '../config/hardRisk.js';

/**
 * Position size is a HARD risk parameter (spec section 10) -- it is always
 * the fixed configured amount, never scaled up/down by strategy or AI logic.
 * This function exists so callers have one place to get it from rather than
 * reading HARD_RISK_PARAMETERS.positionSizeSol directly everywhere.
 */
export function computePositionSize(hard: HardRiskParameters): number {
  return hard.positionSizeSol;
}
