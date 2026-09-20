/**
 * Runtime emergency-stop switch (spec section 10). This is deliberately NOT
 * part of the frozen HARD_RISK_PARAMETERS object -- it's mutable operator
 * state (triggered by a critical execution/safety failure, or manually),
 * whereas HARD_RISK_PARAMETERS.emergencyStopEnabled just says whether this
 * capability is active at all in the current build. Only deterministic
 * engine code may call trigger(); the AI/learning layer never gets a
 * reference to this class.
 */
export class EmergencyStop {
  private triggered = false;
  private reason: string | null = null;
  private triggeredAtMs: number | null = null;

  trigger(reason: string, nowMs: number = Date.now()): void {
    this.triggered = true;
    this.reason = reason;
    this.triggeredAtMs = nowMs;
  }

  reset(): void {
    this.triggered = false;
    this.reason = null;
    this.triggeredAtMs = null;
  }

  isTriggered(): boolean {
    return this.triggered;
  }

  getReason(): string | null {
    return this.reason;
  }

  getTriggeredAtMs(): number | null {
    return this.triggeredAtMs;
  }
}
