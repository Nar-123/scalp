/**
 * Phase 5.4B -- normalized 1-minute SOL volume contract.
 *
 * Everything downstream (production loop, shadow ticks, backtest snapshots,
 * Python analytics) sees ONLY these shapes. No Pump.fun-specific structure
 * leaks past `OneMinuteVolumeProvider`.
 *
 * Time base: EVENT time in whole unix seconds (the on-chain Clock timestamp
 * carried by the trade event == the transaction blockTime, 1 s precision).
 * Local receive time is kept only as `receivedAtMs` metadata and for liveness
 * checks; it never places an event into a window.
 */

export type VolumeCoverageStatus =
  /** Every event that could belong to the window was provably observed. */
  | 'COMPLETE'
  /** Coverage cannot be proven (disconnect, silence, gap, no history yet). Volume is null, never 0. */
  | 'UNKNOWN'
  /** This source structurally cannot supply the value for this token (graduated, non-SOL quote, unseen). */
  | 'UNAVAILABLE';

export type VolumeCoverageReason =
  | 'ok'
  | 'engine_disabled'
  | 'stream_not_started'
  | 'stream_disconnected'
  | 'stream_silent'
  | 'stream_error'
  | 'watermark_stale'
  | 'coverage_gap'
  | 'insufficient_history'
  | 'decode_error'
  | 'logs_truncated'
  | 'capacity_exceeded'
  | 'mint_not_observed'
  | 'token_state_unproven'
  | 'graduated'
  | 'non_sol_quote'
  | 'quote_unproven'
  | 'no_historical_events';

export interface VolumeCoverage {
  status: VolumeCoverageStatus;
  reason: VolumeCoverageReason;
  /** The 60 s window ending at `windowEndSec` is fully covered. */
  currentWindowCovered: boolean;
  /** The preceding 60 s window is fully covered (needed for acceleration). */
  previousWindowCovered: boolean;
}

export interface OneMinuteVolume {
  /** Sum of gross native-SOL curve-side trade amounts in (T-60, T]; null when coverage is not proven. */
  volume1mSol: number | null;
  /** Same quantity over (T-120, T-60]; null when not proven. */
  previousVolume1mSol: number | null;
  /** current / previous; +Infinity when previous is a proven 0 and current > 0; null otherwise-undefined or unproven. */
  volumeAccelerationX: number | null;
  /** T: end of the (inclusive) 60 s window, unix seconds of EVENT time. null when no watermark exists. */
  windowEndSec: number | null;
  /** Newest event second seen on the stream (the raw watermark, before the settle margin). */
  watermarkSec: number | null;
  currentEventCount: number;
  previousEventCount: number;
  /** Buy trades among `currentEventCount` (same window, same coverage). */
  currentBuyCount: number;
  /** Gross SOL of the buy trades in the current window (sell volume = volume1mSol - this). null when not proven. */
  currentBuyVolumeSol: number | null;
  coverage: VolumeCoverage;
}

/**
 * The only thing consumers depend on. Synchronous, in-memory, never performs
 * I/O: the value is derived from an event stream that is already flowing.
 */
export interface OneMinuteVolumeProvider {
  getOneMinuteVolume(mint: string, nowMs?: number): OneMinuteVolume;
}

export function unavailableVolume(reason: VolumeCoverageReason, status: VolumeCoverageStatus = 'UNAVAILABLE'): OneMinuteVolume {
  return {
    volume1mSol: null,
    previousVolume1mSol: null,
    volumeAccelerationX: null,
    windowEndSec: null,
    watermarkSec: null,
    currentEventCount: 0,
    previousEventCount: 0,
    currentBuyCount: 0,
    currentBuyVolumeSol: null,
    coverage: { status, reason, currentWindowCovered: false, previousWindowCovered: false },
  };
}

/** Provider used when native volume is disabled: never invents a value. */
export class NullOneMinuteVolumeProvider implements OneMinuteVolumeProvider {
  getOneMinuteVolume(): OneMinuteVolume {
    return unavailableVolume('engine_disabled', 'UNAVAILABLE');
  }
}

/** Quote-asset classification of a decoded Pump.fun trade. */
export type QuoteClass = 'native_sol' | 'other' | 'unproven';

/**
 * Bonding-curve state AFTER the trade, exactly as carried by the on-chain
 * TradeEvent (verified equal to the BondingCurve account in Phase 5.5). Kept as
 * bigint: the curve math multiplies u64 reserves and must stay exact.
 */
export interface CurveState {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  /** SOL actually held by the curve (account lamports minus rent, verified). */
  realSolReserves: bigint;
  realTokenReserves: bigint;
  /** Protocol fee rate in effect for this trade (basis points). */
  feeBasisPoints: number;
  /** Creator fee rate in effect for this trade (basis points). */
  creatorFeeBasisPoints: number;
  /** true = mayhem-mode curve (different virtual-reserve mechanics, unsupported); null = layout too old to say. */
  mayhemMode: boolean | null;
}

/** One decoded trade, exactly as observed (before any inclusion decision). */
export interface NormalizedTradeEvent {
  signature: string;
  /** Program that emitted the event (Pump.fun bonding curve program). */
  program: string;
  /** 0-based position among the program's own trade events in the transaction's log stream. */
  eventOrdinal: number;
  mint: string;
  /** Gross curve-side quote amount in base units (lamports when quoteClass is native_sol). Fees excluded. */
  solAmountLamports: number;
  tokenAmount: string;
  isBuy: boolean;
  trader: string;
  /** Event time: unix seconds (on-chain Clock == blockTime). */
  eventTimestampSec: number;
  slot: number;
  quoteMint: string | null;
  quoteClass: QuoteClass;
  /** Post-trade curve state carried by the event; null when the payload could not provide it. */
  curve: CurveState | null;
  /** Local wall-clock ms when the notification arrived. Never used for windowing. */
  receivedAtMs: number;
  /** Which representation this event was read from (always the canonical one). */
  source: 'onlogs_program_data';
}

export function tradeIdentity(e: Pick<NormalizedTradeEvent, 'signature' | 'program' | 'eventOrdinal'>): string {
  return `${e.signature}:${e.program}:${e.eventOrdinal}`;
}

export type LifecycleKind = 'create' | 'graduate' | 'migrate';

export interface LifecycleEvent {
  signature: string;
  program: string;
  eventOrdinal: number;
  kind: LifecycleKind;
  mint: string;
  eventTimestampSec: number;
  slot: number;
  quoteMint: string | null;
  receivedAtMs: number;
}

// ---------------------------------------------------------------------------
// Phase 5.5 -- native bonding-curve market snapshot
// ---------------------------------------------------------------------------

/** Data-quality vocabulary shared by every native market-data path. */
export type NativeDataQuality = 'VALID' | 'UNAVAILABLE' | 'STALE' | 'MALFORMED' | 'GRADUATED' | 'WRONG_PROGRAM' | 'TIMESTAMP_SKEW';

export type NativeUnavailableReason =
  | VolumeCoverageReason
  | 'no_curve_state'
  | 'unsupported_mayhem_curve'
  | 'curve_mode_unproven'
  | 'curve_step_inconsistent'
  | 'curve_state_unreadable'
  | 'timestamp_skew';

export interface NativeCurveSummary {
  /** u64 reserves as decimal strings (exact, JSON-safe). */
  virtualSolReserves: string;
  virtualTokenReserves: string;
  realSolReserves: string;
  realTokenReserves: string;
  feeBasisPoints: number;
  creatorFeeBasisPoints: number;
}

/**
 * ONE coherent market observation of a Pump.fun bonding-curve token, built
 * from the shared trade-event stream only (single source, single watermark).
 * priceSol / liquiditySol / priceImpactPct come from the last curve state; the
 * volume fields come from the Phase 5.4B windows. Any field that cannot be
 * proven is null -- never 0, never a value from another source.
 */
export interface NativeMarketSnapshot {
  source: 'pumpfun_native';
  quality: NativeDataQuality;
  /** Why the curve part is not VALID (null when VALID). Volume has its own coverage below. */
  reason: NativeUnavailableReason | null;
  /** SOL per whole token: (virtual SOL / 1e9) / (virtual tokens / 1e6). */
  priceSol: number | null;
  /** Real SOL held by the curve (what sellers can actually withdraw). NOT the virtual reserve. */
  liquiditySol: number | null;
  /** Exact bonding-curve buy price impact (%) for `entrySizeSol`, fees excluded. */
  priceImpactPct: number | null;
  /** Tokens (base units, decimal string) the entry would receive: the amount a later sell would have to liquidate. */
  buyTokenAmountRaw: string | null;
  /** Exact bonding-curve SELL price impact (%) of selling `buyTokenAmountRaw` back into the curve, fees excluded (Phase 5.6). */
  sellPriceImpactPct: number | null;
  entrySizeSol: number;
  volume1mSol: number | null;
  /** Gross SOL of the buy / sell trades in the current window (buy + sell = volume1mSol). */
  buyVolume1mSol: number | null;
  sellVolume1mSol: number | null;
  previousVolume1mSol: number | null;
  volumeAccelerationX: number | null;
  /** Buys / sells COUNT over the current 60 s window (same convention as the DexScreener path); null when undefined. */
  buySellRatio: number | null;
  /** Trades in the current 60 s window. */
  txCount1m: number | null;
  volumeCoverage: VolumeCoverage;
  curve: NativeCurveSummary | null;
  /** Event second the price/liquidity state is valid as of (stream watermark). */
  marketDataAsOfSec: number | null;
  /** Event second of the last trade that changed the curve state. */
  stateEventSec: number | null;
  stateSlot: number | null;
  /** End (inclusive) of the volume window. */
  volumeWindowEndSec: number | null;
  watermarkSec: number | null;
  /** |marketDataAsOfSec - volumeWindowEndSec|; must not exceed the configured maximum. */
  skewSec: number | null;
}

export interface NativeSellImpact {
  quality: NativeDataQuality;
  reason: NativeUnavailableReason | null;
  sellPriceImpactPct: number | null;
}

export interface NativeMarketProvider {
  getNativeMarketSnapshot(mint: string, entrySizeSol: number, nowMs?: number): NativeMarketSnapshot;
  /** Exact SELL impact of `tokenAmountRaw` base units against the token's current curve state; null impact => fail closed. */
  getNativeSellImpact(mint: string, tokenAmountRaw: bigint, nowMs?: number): NativeSellImpact;
}
