export type ExitReason =
  | 'circuit_breaker'
  | 'dynamic_sl'
  | 'quick_tp'
  | 'momentum_tp'
  | 'trailing_stop'
  | 'reversal'
  | 'liquidity_deterioration'
  | 'max_hold_timeout'
  | 'execution_safety_failure';

export type TradeStatus = 'open' | 'closed';

export interface PricePoint {
  priceSol: number;
  liquiditySol: number;
  timestampMs: number;
}

export interface Position {
  tradeId: string;
  mint: string;
  poolAddress: string | null;
  entryTimeMs: number;
  entryPriceSol: number;
  entrySizeSol: number;
  /** SOL value actually deployed after entry fees/impact/slippage (the buy fill's filledAmountSol). */
  entryFilledAmountSol: number;
  reentryIndex: number;
  strategyVersion: string;
  dryRun: boolean;
  /** Price history since entry, used for trailing-stop / MFE / MAE calculations. */
  priceHistory: PricePoint[];
  peakPriceSol: number;
  troughPriceSol: number;
}

export interface TokenEvaluationRecord {
  id: string;
  mint: string;
  poolAddress: string | null;
  discoverySource: string;
  discoveredAtMs: number;
  evaluatedAtMs: number;
  tokenAgeSec: number | null;
  safetyPassed: boolean;
  safetyReasons: string[];
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  top10HolderPct: number | null;
  liquiditySol: number | null;
  volume1mSol: number | null;
  buySellRatio: number | null;
  priceVelocity5sPct: number | null;
  volumeAccelerationX: number | null;
  estimatedPriceImpactPct: number | null;
  entryScore: number | null;
  entryScoreComponents: Record<string, number> | null;
  expectedNetEdgePct: number | null;
  expectedNetEdgeBreakdown: Record<string, number> | null;
  riskAllowed: boolean | null;
  riskRejectReasons: string[];
  ledToTradeId: string | null;
  strategyVersion: string;
}

export interface TradeEntryRecord {
  id: string;
  mint: string;
  poolAddress: string | null;
  strategyVersion: string;
  dryRun: boolean;
  reentryIndex: number;
  entryTimeMs: number;
  entryPriceSol: number;
  entrySizeSol: number;
  entryTokenAgeSec: number | null;
  entryLiquiditySol: number | null;
  entryVolume1mSol: number | null;
  entryBuySellRatio: number | null;
  entryPriceVelocity5sPct: number | null;
  entryVolumeAccelerationX: number | null;
  entryScore: number | null;
  entryScoreComponents: Record<string, number> | null;
  expectedNetEdgePct: number | null;
  expectedNetEdgeBreakdown: Record<string, number> | null;
  entrySlippagePct: number | null;
  entryPriceImpactPct: number | null;
  entryFeesSol: number | null;
  entryTxSignature: string | null;
  entrySafetyCheckId: string | null;
  dailyRealizedPnlSolAtEntry: number;
}

export interface TradeExitRecord {
  exitTimeMs: number;
  exitPriceSol: number;
  exitReason: ExitReason;
  exitFeesSol: number;
  exitTxSignature: string | null;
  exitSlippagePct: number | null;
  holdDurationMs: number;
  pnlSol: number;
  pnlPct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  dailyRealizedPnlSolAtExit: number;
}

export interface TokenTradeHistory {
  mint: string;
  /** Trades already executed for this mint (0 = never traded). Also doubles as the reentryIndex to assign to the next trade. */
  totalTrades: number;
  lastTradeExitTimeMs: number | null;
  lastTradeWasLoss: boolean | null;
  consecutiveLosses: number;
  cumulativePnlSol: number;
}
