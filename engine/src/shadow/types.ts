import type { ExitReason } from '../types/trade.js';

/**
 * A read-only observation of a real Jupiter (or equivalent) quote, task 15
 * ("realtime quote observation"). This is data the CALLER supplies (loop.ts's
 * integration point, which already has a quote client available) --
 * shadowRunner.ts itself performs no network I/O, so it stays pure and
 * testable with synthetic ticks, exactly like the backtest replay engine.
 * Never executed: nothing in this codebase turns a QuoteObservation into a
 * transaction.
 */
export interface QuoteObservation {
  /** Implied SOL/token price; null when it cannot be derived without the mint's decimals (never guessed). */
  quotedPriceSol: number | null;
  quoteTimestampMs: number;
  route: string;
  /** Quoted output in SOL terms; null for a SOL->token buy quote (output is raw token units, decimals unknown). */
  expectedOutputSol: number | null;
  /** Raw quoted output amount in the output mint's base units (string, lossless). */
  outAmountRaw?: string | null;
  estimatedPriceImpactPct: number;
  /** A quote reports an impact and echoes a slippage TOLERANCE, not an estimated slippage; null => the runner uses the ASSUMED latency-slippage buffer. */
  estimatedSlippagePct: number | null;
  /** Round-trip time of the read-only quote HTTP request itself (OBSERVED). */
  quoteRequestLatencyMs?: number;
}

/**
 * Wall-clock timestamps captured at each pipeline stage for ONE tick, in
 * milliseconds since epoch -- task 14. These are OBSERVED SYSTEM LATENCY
 * (real deltas measured within this process), never to be confused with
 * SimulationAssumptions.latencySlippageBufferPct (an ASSUMED cost applied
 * to fills because no real execution happens at all in shadow/backtest
 * mode -- see latencyTracker.ts's docs for the explicit distinction).
 */
export interface TickTimings {
  /** On-chain creation time of the token (blockTime, 1s resolution). */
  discoveryTimeMs: number;
  /** When this process first saw the creation event; discovery latency = detectedAtMs - discoveryTimeMs. */
  detectedAtMs?: number | null;
  /** Start of this evaluation tick. */
  signalTimeMs: number;
  /** When price + liquidity/volume fetches for this tick completed. */
  marketDataTimeMs?: number | null;
  quoteTimeMs: number | null;
  simulationTimeMs: number;
  exitSignalTimeMs: number | null;
}

/**
 * The realtime twin of backtest/types.ts's HistoricalMarketSnapshot: the
 * ONLY shape shadowRunner.ts ever consumes. A caller (the live orchestrator
 * integration, or a test) builds this from data it ALREADY fetched this
 * tick -- shadowRunner.ts never issues its own RPC/aggregator/quote call,
 * so feeding it ticks can never duplicate a network request (task 4).
 */
export interface ShadowMarketTick {
  mint: string;
  discoveredAtMs: number;
  observedAtMs: number;
  priceSol: number | null;
  liquiditySol: number | null;
  volume1mSol: number | null;
  buySellRatio: number | null;
  priceVelocity5sPct: number | null;
  volumeAccelerationX: number | null;
  txCount1m: number | null;
  estimatedPriceImpactPct: number | null;
  /**
   * Phase 5.6: SELL-direction price impact of liquidating the entry-sized position at THIS tick's market (a sell
   * quote / the exact curve sell formula), computed by the caller. Exits use ONLY this figure -- never the buy
   * impact. undefined/null => unavailable => a triggered exit is DEFERRED (fail closed), not filled at a guess.
   */
  estimatedSellPriceImpactPct?: number | null;
  /**
   * Phase 5.6H: the venue's per-leg fee in bps at this tick (Pump.fun protocol + creator fee of the curve). null/undefined =>
   * unknown => the configured generic fee model prices both legs.
   */
  venueFeeBps?: number | null;
  /** Raw tokens the entry-sized position holds at this tick's price (what that sell liquidates). */
  buyTokenAmountRaw?: string | null;
  buyVolume1mSol?: number | null;
  sellVolume1mSol?: number | null;
  /** Which source produced this tick's market values and the event-time stamps they represent. */
  marketSource?: 'pumpfun_native' | 'dexscreener' | null;
  marketDataAsOfSec?: number | null;
  volumeWindowEndSec?: number | null;
  stateEventSec?: number | null;
  safetyPassedAtObservationTime: boolean | null;
  safetyReasonsAtObservationTime: string[];
  quote: QuoteObservation | null;
  timings: TickTimings;
  /** Set by the caller when this tick exists only because an upstream fetch failed, so shadow can record a real data-quality event instead of silently treating nulls as "just no data yet". */
  fetchError: { source: 'rpc' | 'aggregator' | 'quote'; message: string } | null;
}

export type ShadowOutcomeKind =
  | 'entered'
  | 'exited'
  | 'held'
  | 'missed_signal'
  | 'rejected_baseline'
  | 'rejected_safety'
  | 'rejected_score_or_edge'
  | 'skipped_data_quality'
  | 'no_action';

export interface ShadowOutcome {
  strategyVersion: string;
  mint: string;
  kind: ShadowOutcomeKind;
  detail?: string;
  exitReason?: ExitReason;
}

/**
 * The risk-engine-sourced reasons (max_concurrent_positions_reached,
 * max_total_exposure_reached, reentry_cooldown_active,
 * consecutive_loss_limit_reached, max_reentries_per_token_reached,
 * daily_loss_circuit_breaker_triggered, emergency_stop_triggered) come
 * verbatim from risk/exposureManager.ts, risk/reentryTracker.ts, and
 * risk/riskEngine.ts's own reason strings -- deliberately NOT re-listed
 * here as a closed union, so this type never drifts out of sync with the
 * single source of truth for those strings. The values below are this
 * module's OWN synthetic reasons, for situations the risk engine never
 * sees at all (the signal never got that far).
 */
export type ShadowSpecificMissedSignalReason =
  | 'invalid_safety_state'
  | 'missing_market_data'
  | 'stale_quote'
  | 'rpc_failure'
  | 'aggregator_failure'
  | 'insufficient_market_data';

export interface MissedSignalRecord {
  mint: string;
  strategyVersion: string;
  observedAtMs: number;
  reason: string;
  detail: string;
}

export type DataQualitySeverity = 'block' | 'reject' | 'warning';

export type DataQualityEventKind =
  | 'malformed_market_data'
  | 'degenerate_ratio'
  | 'stale_market_data'
  | 'duplicate_event'
  | 'missing_event'
  | 'out_of_order_event'
  | 'impossible_price_change'
  | 'invalid_liquidity'
  | 'missing_quote'
  | 'rpc_error'
  | 'aggregator_error';

export interface DataQualityEventRecord {
  mint: string;
  strategyVersion: string | null;
  observedAtMs: number;
  kind: DataQualityEventKind;
  /** block = tick not used (duplicate/out-of-order); reject = malformed/impossible data never allowed to become a signal; warning = recorded, tick still used. */
  severity: DataQualitySeverity;
  detail: string;
}

/** Every field is OBSERVED SYSTEM LATENCY (measured in this process). None feeds the fill model, which uses the separate ASSUMED latencySlippageBufferPct. */
export interface LatencySampleRecord {
  mint: string;
  observedAtMs: number;
  discoveryTimeMs: number;
  detectedAtMs?: number | null;
  marketDataTimeMs?: number | null;
  signalTimeMs: number;
  quoteTimeMs: number | null;
  simulationTimeMs: number;
  exitSignalTimeMs: number | null;
  /** on-chain creation -> first seen by this process (null when the event carried no detection time) */
  discoveryLatencyMs: number | null;
  /** tick start -> price + liquidity/volume fetched */
  marketDataLatencyMs?: number | null;
  /** read-only quote request duration, after market data (null when no quote was attempted) */
  quoteLatencyMs: number | null;
  /** after data acquisition -> tick handed to shadow (includes the production safety-gate wait) */
  signalLatencyMs: number;
  /** tick start -> handed to shadow (fetch + safety pipeline) */
  processingLatencyMs: number;
  /** time spent inside ShadowRunner.onMarketTick itself (measured by the runner) */
  shadowProcessingLatencyMs?: number | null;
}

export type ShadowTradeStatus = 'open' | 'closed';

export interface ShadowTradeRecord {
  tradeId: string;
  strategyVersion: string;
  executionMode: 'shadow';
  simulatorVersion: string;
  mint: string;
  reentryIndex: number;
  entryTimeMs: number;
  entryPriceSol: number;
  entrySizeSol: number;
  entryFilledAmountSol: number;
  entryFeesSol: number;
  entryScore: number;
  expectedNetEdgePct: number;
  entryLiquiditySol: number | null;
  entryQuote: QuoteObservation | null;
  /** Phase 5.6: raw tokens held, the decision context and the exit context (see orchestrator/decisionContext.ts). */
  entryTokenAmountRaw?: string | null;
  entryContext?: Record<string, unknown> | null;
  exitContext?: Record<string, unknown> | null;
  exitTimeMs: number | null;
  exitPriceSol: number | null;
  exitReason: ExitReason | null;
  exitFeesSol: number | null;
  status: ShadowTradeStatus;
  pnlSol: number | null;
  pnlPct: number | null;
  holdDurationMs: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
}
