import type { AppConfig } from '../../config/schema.js';

/**
 * Documented definition (the spec names this mechanism but not an exact
 * formula): a reversal is a sharp negative velocity swing -- recent momentum
 * dropping to/below -reversalDropFromPeakPct -- independent of current PnL,
 * so it can catch a fading move before dynamic-SL/trailing-stop would.
 */
export function checkReversal(recentMomentumPct: number, cfg: Pick<AppConfig['exits'], 'reversalDropFromPeakPct'>): boolean {
  return recentMomentumPct <= -cfg.reversalDropFromPeakPct;
}
