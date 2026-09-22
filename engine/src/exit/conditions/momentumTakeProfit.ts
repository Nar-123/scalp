import type { AppConfig } from '../../config/schema.js';

/**
 * Take the larger "momentum" profit target only while the move is still
 * confirmed continuing (positive recent velocity) -- otherwise a stalled
 * position sitting above the momentum threshold should fall through to the
 * quick-TP / trailing-stop logic instead of holding out for more upside.
 */
export function checkMomentumTakeProfit(
  pnlPct: number,
  recentMomentumPct: number,
  cfg: Pick<AppConfig['exits'], 'momentumTpMinPct'>,
): boolean {
  return pnlPct >= cfg.momentumTpMinPct && recentMomentumPct > 0;
}
