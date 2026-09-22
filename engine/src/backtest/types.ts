import type { ExitReason } from '../types/trade.js';

/**
 * Historical market-data contract (Phase 3-alt task 5). One row per live
 * evaluation tick the orchestrator already recorded to `token_evaluations`
 * -- this project does not operate a separate historical tick-data
 * collection pipeline, so the replay engine's "historical data" IS the
 * live engine's own evaluation log, repurposed. This is deliberate and
 * documented, not a placeholder: every field below was genuinely observed
 * or locally derived at the time, never invented after the fact.
 *
 * OBSERVED DIRECTLY (came straight from an RPC/aggregator call at
 * `observedAtMs`): discoveredAtMs, discoverySource, priceSol, liquiditySol,
 * volume1mSol, buySellRatio, txCount1m, estimatedPriceImpactPct,
 * safetyPassedAtObservationTime, safetyReasonsAtObservationTime.
 *
 * DERIVED LOCALLY (computed live from a rolling window of prior
 * observations for the same mint -- see orchestrator/marketHistory.ts):
 * priceVelocity5sPct, volumeAccelerationX.
 *
 * NEVER AVAILABLE in this project's data (explicitly absent, never
 * fabricated): separate buy_volume/sell_volume (only their ratio was ever
 * computed), raw transaction_count (only a 1-minute rate, txCount1m), swap
 * count, slot, block_time (the ledger records wall-clock ms, not a slot),
 * and a slippage estimate independent of price impact (this project's live
 * engine only ever estimates price impact from a quote and separately
 * assumes a configured latency-slippage buffer -- it has never observed a
 * real historical slippage figure to replay).
 */
export interface HistoricalMarketSnapshot {
  mint: string;
  observedAtMs: number;
  discoveredAtMs: number;
  discoverySource: string;
  priceSol: number | null;
  liquiditySol: number | null;
  volume1mSol: number | null;
  buySellRatio: number | null;
  priceVelocity5sPct: number | null;
  volumeAccelerationX: number | null;
  txCount1m: number | null;
  estimatedPriceImpactPct: number | null;
  /** Phase 5.6: SELL-direction impact of the entry-sized position as recorded at this snapshot. null/absent => an exit cannot be priced here and is deferred (never filled with the buy impact). */
  estimatedSellPriceImpactPct?: number | null;
  /** Phase 5.6H: the venue's per-leg fee (bps) at this snapshot when recorded; absent => the configured generic fee model. */
  venueFeeBps?: number | null;
  safetyPassedAtObservationTime: boolean;
  safetyReasonsAtObservationTime: string[];
}

/**
 * Every cost/timing assumption the replay engine needs, all configurable,
 * all clearly separated from HARD_RISK_PARAMETERS (which this interface
 * never touches -- see backtest/replayEngine.ts's use of HARD_RISK_PARAMETERS
 * directly, unmodified, alongside this).
 */
export interface SimulationAssumptions {
  edge: {
    dexFeeBps: number;
    swapFeeBps: number;
    networkFeeSol: number;
    priorityFeeSol: number;
    safetyMarginBps: number;
  };
  /** Used whenever a snapshot's own estimatedPriceImpactPct is null. */
  fallbackPriceImpactPct: number;
  /**
   * Modeled cost standing in for "the price could move between signal
   * generation and execution" (task 10). This project's historical
   * snapshots are spaced by the live polling interval (~2s), far coarser
   * than real execution latency (milliseconds) -- there is no sub-poll-
   * interval price data to look up a literal "price 200ms later." Latency
   * is therefore modeled as an additional assumed cost, not a price
   * lookup. This is the same mechanism (and, by default, the same
   * configured value) `DryRunExecutor` already uses for live DRY_RUN
   * simulation, applied here for consistency, not as a separate model.
   */
  latencySlippageBufferPct: number;
  /** A label so a result can state which simulator produced it (task 25/27). */
  simulatorVersion: string;
}

export const DEFAULT_SIMULATOR_VERSION = 'backtest-replay-v2';

export type BacktestTradeStatus = 'closed' | 'still_open_at_end_of_data';

export interface BacktestTrade {
  mint: string;
  reentryIndex: number;
  entryTimeMs: number;
  entryPriceSol: number;
  entrySizeSol: number;
  entryFilledAmountSol: number;
  entryFeesSol: number;
  entryScore: number;
  expectedNetEdgePct: number;
  exitTimeMs: number | null;
  exitPriceSol: number | null;
  exitReason: ExitReason | null;
  exitFeesSol: number | null;
  status: BacktestTradeStatus;
  pnlSol: number | null;
  pnlPct: number | null;
  holdDurationMs: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
}

export interface DataQualityIssue {
  mint: string;
  kind:
    | 'missing_timestamp'
    | 'duplicate_record'
    | 'impossible_price'
    | 'negative_liquidity'
    | 'negative_volume'
    | 'non_chronological_order'
    | 'impossible_token_age'
    | 'missing_required_feature';
  detail: string;
  observedAtMs: number | null;
}

export type BacktestStatus = 'completed' | 'insufficient_data';

export interface BacktestResult {
  status: BacktestStatus;
  simulatorVersion: string;
  strategyLabel: string;
  sampleSizeSnapshots: number;
  trades: BacktestTrade[];
  dataQualityIssues: DataQualityIssue[];
  /** Exit signals that could not be filled because no sell impact was recorded at that snapshot (the position stayed open). */
  exitsDeferredSellImpactUnavailable?: number;
  notes: string;
}
