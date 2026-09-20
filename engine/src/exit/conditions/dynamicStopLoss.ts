import type { AppConfig } from '../../config/schema.js';
import { clamp } from '../../utils/math.js';

/**
 * Widens/tightens the stop-loss band based on recent realized volatility,
 * bounded to the configured [dynamicSlMinPct, dynamicSlMaxPct] range (spec:
 * "approximately -2% to -3%"). Higher recent volatility widens the band
 * (avoid getting stopped out by noise); lower volatility tightens it.
 */
export function computeDynamicStopLossPct(
  recentVolatilityPct: number,
  cfg: Pick<AppConfig['exits'], 'dynamicSlMinPct' | 'dynamicSlMaxPct'>,
): number {
  return clamp(recentVolatilityPct, cfg.dynamicSlMinPct, cfg.dynamicSlMaxPct);
}

export function checkDynamicStopLoss(
  pnlPct: number,
  recentVolatilityPct: number,
  cfg: Pick<AppConfig['exits'], 'dynamicSlMinPct' | 'dynamicSlMaxPct'>,
): boolean {
  const thresholdPct = computeDynamicStopLossPct(recentVolatilityPct, cfg);
  return pnlPct <= -thresholdPct;
}
