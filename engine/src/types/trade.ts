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
  /** Raw token amount held (from the buy fill); needed to price the SELL. null => sells fail closed. */
  entryTokenAmountRaw?: string | null;
  /** Fees charged by the entry fill (for the exit audit context). */
  entryFeesSol?: number | null;
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
  /** Observed price at evaluation time, in SOL. Added in Phase 3-alt specifically so historical replay/backtesting never has to invent a price series. */
  priceSol: number | null;
  liquiditySol: number | null;
  volume1mSol: number | null;
  buySellRatio: number | null;
  priceVelocity5sPct: number | null;
  volumeAccelerationX: number | null;
  /** Observed buy+sell transaction count normalized to 1 minute. Added in Phase 3-alt for the same reason as priceSol. */
  txCount1m: number | null;
  estimatedPriceImpactPct: number | null;
  entryScore: number | null;
  entryScoreComponents: Record<string, number> | null;
  expectedNetEdgePct: number | null;
  expectedNetEdgeBreakdown: Record<string, number> | null;
  riskAllowed: boolean | null;
  riskRejectReasons: string[];
  ledToTradeId: string | null;
  strategyVersion: string;
  /** Phase 5.6: sell-direction impact of the entry-sized position and the buy/sell split of the 1m volume (null = unavailable). */
  estimatedSellPriceImpactPct?: number | null;
  buyVolume1mSol?: number | null;
  sellVolume1mSol?: number | null;
  /** Phase 5.5: where the market values came from and the event-time stamps they represent (null = not recorded / not native). */
  marketData?: EvaluationMarketData | null;
}

export interface EvaluationMarketData {
  source: 'pumpfun_native' | 'dexscreener';
  /** Event second the price/liquidity state is valid as of (stream watermark). */
  asOfSec: number | null;
  /** End (inclusive) of the 60 s volume window, event seconds. */
  volumeWindowEndSec: number | null;
  /** Event second of the last trade that changed the curve state. */
  stateEventSec: number | null;
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
  /** Phase 5.6 */
  entryTokenAmountRaw?: string | null;
  entryContext?: Record<string, unknown> | null;
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
  /** Phase 5.6: sell impact, gross/net PnL and the market observation the exit was taken on. */
  exitContext?: Record<string, unknown> | null;
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
