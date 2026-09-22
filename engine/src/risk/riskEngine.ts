import type { HardRiskParameters } from '../config/hardRisk.js';
import type { AppConfig } from '../config/schema.js';
import { computePositionSize } from './positionSizing.js';
import { shouldLatchCircuitBreaker } from './dailyLossCircuitBreaker.js';
import { canOpenNewPosition } from './exposureManager.js';
import { canReenter } from './reentryTracker.js';
import type { RiskDecision, RiskDecisionContext } from './types.js';

/**
 * Composes every entry-time risk check. The daily loss circuit breaker is
 * checked first and, once triggered, blocks every other reason from even
 * being evaluated for sizing purposes -- new entries stop outright.
 */
export function evaluateEntryRisk(
  ctx: RiskDecisionContext,
  hard: HardRiskParameters,
  cfg: Pick<AppConfig, 'reentry'>,
): RiskDecision {
  const reasons: string[] = [];

  if (ctx.emergencyStopTriggered) {
    reasons.push('emergency_stop_triggered');
  }

  const circuitBreakerTriggered = shouldLatchCircuitBreaker(
    ctx.dailyCircuitBreakerAlreadyTriggered,
    ctx.dailyRealizedPnlSol,
    ctx.dailyStartingBalanceSol,
    hard.dailyLossLimitPct,
  );
  if (circuitBreakerTriggered) {
    reasons.push('daily_loss_circuit_breaker_triggered');
  }

  const exposureDecision = canOpenNewPosition(ctx.openPositions, hard);
  if (!exposureDecision.allowed) {
    reasons.push(exposureDecision.reason ?? 'exposure_limit_reached');
  }

  const reentryDecision = canReenter(ctx.tokenHistory, hard, cfg.reentry, ctx.now);
  if (!reentryDecision.allowed) {
    reasons.push(reentryDecision.reason ?? 'reentry_blocked');
  }

  const allowed = reasons.length === 0;

  return {
    allowed,
    reasons,
    sizingSol: allowed ? computePositionSize(hard) : 0,
    circuitBreakerTriggered,
  };
}
