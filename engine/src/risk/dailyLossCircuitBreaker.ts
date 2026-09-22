/**
 * True once realized loss for the trading day reaches/exceeds the configured
 * percentage of the day's starting balance. `realizedPnlSol` negative means
 * a loss. Fails closed (treated as breached) if the starting balance is
 * non-positive, since the percentage math would otherwise be meaningless.
 */
export function isDailyLossLimitBreached(realizedPnlSol: number, startingBalanceSol: number, limitPct: number): boolean {
  if (!Number.isFinite(realizedPnlSol) || !Number.isFinite(startingBalanceSol)) return true;
  if (startingBalanceSol <= 0) return true;
  const lossPct = (-realizedPnlSol / startingBalanceSol) * 100;
  return lossPct >= limitPct;
}

/**
 * The circuit breaker LATCHES: once triggered for a trading day it stays
 * triggered regardless of subsequent recovery, until the next UTC day's
 * daily_risk_state row resets it. Callers pass in whether it was already
 * latched (from persisted state) alongside the live PnL check.
 */
export function shouldLatchCircuitBreaker(
  alreadyTriggered: boolean,
  realizedPnlSol: number,
  startingBalanceSol: number,
  limitPct: number,
): boolean {
  return alreadyTriggered || isDailyLossLimitBreached(realizedPnlSol, startingBalanceSol, limitPct);
}
