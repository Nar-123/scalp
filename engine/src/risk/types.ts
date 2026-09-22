import type { TokenTradeHistory } from '../types/trade.js';

export interface OpenPositionSummary {
  tradeId: string;
  mint: string;
  entrySizeSol: number;
}

export interface RiskDecisionContext {
  mint: string;
  openPositions: OpenPositionSummary[];
  dailyRealizedPnlSol: number;
  dailyStartingBalanceSol: number;
  dailyCircuitBreakerAlreadyTriggered: boolean;
  emergencyStopTriggered: boolean;
  tokenHistory: TokenTradeHistory;
  now: number;
}

export interface RiskDecision {
  allowed: boolean;
  reasons: string[];
  sizingSol: number;
  circuitBreakerTriggered: boolean;
}
