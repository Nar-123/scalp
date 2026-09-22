import type { ExitReason, Position } from '../types/trade.js';

export interface ExitEvaluationInputs {
  position: Position;
  /** null => the price provider had nothing this tick. Never a fabricated or stale-reused value (see positionMonitor.ts). */
  currentPriceSol: number | null;
  /** null => the aggregator had nothing this tick. Never a fabricated or stale-reused value (see positionMonitor.ts). */
  currentLiquiditySol: number | null;
  /** Price velocity over the last few seconds, percent; negative = falling. */
  recentMomentumPct: number;
  /** Recent realized volatility, percent, used to size the dynamic stop-loss band. */
  recentVolatilityPct: number;
  nowMs: number;
  emergencyStopTriggered: boolean;
}

export interface ExitDecision {
  shouldExit: boolean;
  reason?: ExitReason;
  details?: Record<string, unknown>;
}
