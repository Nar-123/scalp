/**
 * The daily loss circuit breaker (risk/dailyLossCircuitBreaker.ts) only
 * blocks NEW entries -- per spec section 9 the bot "may still perform safe
 * management of existing positions." This exit condition instead fires only
 * on the runtime EmergencyStop switch (critical execution/safety failure or
 * a manual kill), which does force-close open positions immediately.
 */
export function checkCircuitBreakerExit(emergencyStopTriggered: boolean): boolean {
  return emergencyStopTriggered;
}
