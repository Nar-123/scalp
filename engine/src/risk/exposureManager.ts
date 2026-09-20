import type { HardRiskParameters } from '../config/hardRisk.js';
import type { OpenPositionSummary } from './types.js';

export function canOpenNewPosition(
  openPositions: OpenPositionSummary[],
  hard: HardRiskParameters,
): { allowed: boolean; reason?: string } {
  if (openPositions.length >= hard.maxConcurrentPositions) {
    return { allowed: false, reason: 'max_concurrent_positions_reached' };
  }
  const totalExposureSol = openPositions.reduce((sum, p) => sum + p.entrySizeSol, 0);
  if (totalExposureSol + hard.positionSizeSol > hard.maxTotalExposureSol) {
    return { allowed: false, reason: 'max_total_exposure_reached' };
  }
  return { allowed: true };
}
