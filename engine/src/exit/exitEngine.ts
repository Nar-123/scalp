import type { AppConfig } from '../config/schema.js';
import { pctChange } from '../utils/math.js';
import { checkCircuitBreakerExit } from './conditions/circuitBreakerExit.js';
import { checkDynamicStopLoss } from './conditions/dynamicStopLoss.js';
import { checkMomentumTakeProfit } from './conditions/momentumTakeProfit.js';
import { checkQuickTakeProfit } from './conditions/takeProfit.js';
import { checkTrailingStop } from './conditions/trailingStop.js';
import { checkReversal } from './conditions/reversalDetector.js';
import { checkLiquidityDeterioration } from './conditions/liquidityDeterioration.js';
import { checkMaxHoldTimeout } from './conditions/maxHoldTimeout.js';
import type { ExitDecision, ExitEvaluationInputs } from './types.js';

/**
 * Evaluates every exit condition in a fixed, documented priority order and
 * returns the first one that triggers. Capital protection takes precedence
 * over profit-taking: circuit_breaker > dynamic_sl > momentum_tp > quick_tp
 * > trailing_stop > reversal > liquidity_deterioration > max_hold_timeout.
 */
export function evaluateExit(inputs: ExitEvaluationInputs, cfg: AppConfig['exits']): ExitDecision {
  const { position, currentPriceSol, currentLiquiditySol, recentMomentumPct, recentVolatilityPct, nowMs } = inputs;
  const pnlPct = pctChange(position.entryPriceSol, currentPriceSol);
  const entryLiquiditySol = position.priceHistory[0]?.liquiditySol ?? currentLiquiditySol;

  if (checkCircuitBreakerExit(inputs.emergencyStopTriggered)) {
    return { shouldExit: true, reason: 'circuit_breaker', details: { emergencyStopTriggered: true } };
  }

  if (checkDynamicStopLoss(pnlPct, recentVolatilityPct, cfg)) {
    return { shouldExit: true, reason: 'dynamic_sl', details: { pnlPct, recentVolatilityPct } };
  }

  if (checkMomentumTakeProfit(pnlPct, recentMomentumPct, cfg)) {
    return { shouldExit: true, reason: 'momentum_tp', details: { pnlPct, recentMomentumPct } };
  }

  if (checkQuickTakeProfit(pnlPct, cfg)) {
    return { shouldExit: true, reason: 'quick_tp', details: { pnlPct } };
  }

  if (checkTrailingStop(position, currentPriceSol, cfg)) {
    return { shouldExit: true, reason: 'trailing_stop', details: { pnlPct, peakPriceSol: position.peakPriceSol } };
  }

  if (checkReversal(recentMomentumPct, cfg)) {
    return { shouldExit: true, reason: 'reversal', details: { recentMomentumPct } };
  }

  if (checkLiquidityDeterioration(entryLiquiditySol, currentLiquiditySol, cfg)) {
    return { shouldExit: true, reason: 'liquidity_deterioration', details: { entryLiquiditySol, currentLiquiditySol } };
  }

  if (checkMaxHoldTimeout(position.entryTimeMs, nowMs, cfg)) {
    return { shouldExit: true, reason: 'max_hold_timeout', details: { holdMs: nowMs - position.entryTimeMs } };
  }

  return { shouldExit: false };
}
