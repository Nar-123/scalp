import type { HardRiskParameters } from '../config/hardRisk.js';
import type { AppConfig } from '../config/schema.js';
import type { TokenTradeHistory } from '../types/trade.js';

/**
 * Re-entry is never "averaging down" -- every re-entry must independently
 * re-pass every entry/safety/edge/risk check. This tracker only decides
 * whether a re-entry attempt is even allowed to be considered.
 *
 * `history.totalTrades` doubles as the reentryIndex that WOULD be assigned
 * to the next trade (0 = initial entry, 1..5 = re-entries 1 through 5 when
 * maxReentriesPerToken=5). A totalTrades value greater than
 * maxReentriesPerToken means all allowed re-entries have been used.
 */
export function canReenter(
  history: TokenTradeHistory,
  hard: HardRiskParameters,
  cfg: AppConfig['reentry'],
  nowMs: number,
): { allowed: boolean; reason?: string } {
  if (history.totalTrades > hard.maxReentriesPerToken) {
    return { allowed: false, reason: 'max_reentries_per_token_reached' };
  }
  if (history.totalTrades > 0) {
    if (history.consecutiveLosses >= cfg.consecutiveLossLimit) {
      return { allowed: false, reason: 'consecutive_loss_limit_reached' };
    }
    if (history.lastTradeExitTimeMs !== null && nowMs - history.lastTradeExitTimeMs < cfg.cooldownMs) {
      return { allowed: false, reason: 'reentry_cooldown_active' };
    }
  }
  return { allowed: true };
}
