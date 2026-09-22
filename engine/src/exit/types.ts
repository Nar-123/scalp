import type { ExitReason, Position } from '../types/trade.js';

export interface ExitEvaluationInputs {
  position: Position;
  currentPriceSol: number;
  currentLiquiditySol: number;
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
