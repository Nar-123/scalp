import type { AppConfig } from '../../config/schema.js';
import type { Position } from '../../types/trade.js';
import { pctChange } from '../../utils/math.js';

/**
 * Activates only once the position's peak gain has reached
 * trailingActivationPct, then triggers on a retrace of trailingDistancePct
 * from that peak.
 */
export function checkTrailingStop(
  position: Position,
  currentPriceSol: number,
  cfg: Pick<AppConfig['exits'], 'trailingActivationPct' | 'trailingDistancePct'>,
): boolean {
  const peakGainPct = pctChange(position.entryPriceSol, position.peakPriceSol);
  if (peakGainPct < cfg.trailingActivationPct) return false;
  const retracePct = pctChange(position.peakPriceSol, currentPriceSol);
  return retracePct <= -cfg.trailingDistancePct;
}
