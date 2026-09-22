import { performance } from 'node:perf_hooks';
import { BoundedIdentitySet, SecondBucketStore } from './boundedStructures.js';
import { buyPriceImpactPct, chainLinks, entryNetLamports, isConstantProductStep, preTradeState, realSolLiquidity, sellPriceImpactPct, spotPriceSol, tokensOutForNetSol, type PreTradeState } from './bondingCurveMath.js';
import { decodePumpfunNotification, NATIVE_SOL_QUOTE_MINT, PUMPFUN_PROGRAM_ID, type LogNotificationInput } from './pumpfunTradeEventDecoder.js';
import {
  tradeIdentity,
  unavailableVolume,
  type CurveState,
  type LifecycleEvent,
  type NativeDataQuality,
  type NativeMarketProvider,
  type NativeMarketSnapshot,
  type NativeSellImpact,
  type NativeUnavailableReason,
  type NormalizedTradeEvent,
  type OneMinuteVolume,
  type OneMinuteVolumeProvider,
  type VolumeCoverageReason,
} from './types.js';

/**
 * Pump.fun native 1-minute SOL volume engine (Phase 5.4B).
 *
 * ONE shared program-log stream -> decode -> route by mint -> per-second
 * buckets. No RPC, no I/O, no wall-clock in the arithmetic: every window is a
 * function of EVENT time and of the coverage state. Deterministic given the
 * same ordered inputs, which is what lets live, shadow and replay share it.
 *
 * DEFINITIONS (all in whole unix seconds of event time)
 *  - watermark W   = newest event second observed on the stream (any mint, any
 *                    quote, successful transactions only).
 *  - window end T  = W - settleSec (default 1). The newest second is still
 *                    filling (2-3 slots share a second), so T is the newest
 *                    fully-settled second. Using W itself would undercount the
 *                    current window and inflate acceleration by up to ~1/60.
 *  - current       = (T-60, T]   == seconds T-59 .. T   (T-60 is EXCLUDED)
 *  - previous      = (T-120,T-60] == seconds T-119 .. T-60 (T-60 is INCLUDED here)
 *  The local clock is used ONLY for liveness (silence / stale-watermark
 *  checks), never to place an event in a window or to define T.
 *
 * COVERAGE. A window is answered only if every event that could belong to it
 * was provably observed: the stream must have been continuously healthy since
 * the window start (or since the token's own creation, when that was observed
 * in the current healthy period). After ANY break (disconnect, silence, error,
 * truncated log, malformed event, capacity drop) coverage is UNKNOWN and the
 * volume is null until the affected seconds have slid out of the window --
 * there is no reconciliation, so a gap is never repaired, only outlived.
 * "No events" is a valid ZERO only while coverage is proven.
 */

export interface PumpfunVolumeEngineOptions {
  program?: string;
  /** Event history kept (>= 120 s needed; the extra slack absorbs late events). */
  retentionSec?: number;
  settleSec?: number;
  /** No notification (even a failed transaction) for this long => stream considered silent. */
  silenceMs?: number;
  /** Local-clock lag of the watermark beyond which the stream is considered stale. */
  maxWatermarkLagSec?: number;
  /** Events stamped further than this ahead of the local clock are rejected as malformed. */
  futureToleranceSec?: number;
  maxDedupeEntries?: number;
  maxBuckets?: number;
  maxMintStates?: number;
  mintStateIdleSec?: number;
  /** Largest tolerated |price/liquidity as-of second - volume window end| (event seconds). Default 5. */
  maxSnapshotSkewSec?: number;
  onTradeAccepted?: (e: NormalizedTradeEvent) => void;
  onLifecycle?: (e: LifecycleEvent) => void;
  onCoverageChange?: (c: CoverageChange) => void;
}

export interface CoverageChange {
  atMs: number;
  /** Watermark (event second) when the change happened; null before any event. */
  eventSec: number | null;
  kind: 'start' | 'break' | 'resume';
  reason: VolumeCoverageReason | 'ok';
  epoch: number;
}

type MintStatus = 'active' | 'graduated' | 'non_sol_quote' | 'quote_unproven';

interface MintState {
  status: MintStatus;
  creationSec: number | null;
  /** Epoch in which the creation event was received (continuous coverage since creation). */
  createdInEpoch: number | null;
  /** Last epoch in which an event proved the token is (still) on a SOL bonding curve. */
  provenEpoch: number;
  lastEventSec: number;
  /** Latest bonding-curve state carried by a trade event of this mint (null until one arrives). */
  curve: CurveTrack | null;
}

interface CurveTrack {
  post: CurveState;
  /** State before the trade that produced `post` (used to order two events of one slot). */
  pre: PreTradeState;
  slot: number;
  eventSec: number;
  /** The event is a valid constant-product step (k preserved, positive reserves). */
  stepOk: boolean;
  /** The reserves of the trade could not be read at all. */
  unreadable: boolean;
}

export interface EngineStats {
  notifications: number;
  failedTransactions: number;
  unknownStatus: number;
  tradeEventsDecoded: number;
  tradesAccepted: number;
  tradesCountedInVolume: number;
  duplicates: number;
  excludedNonSolQuote: number;
  excludedUnprovenQuote: number;
  lateEvents: number;
  tooOldDropped: number;
  futureRejected: number;
  decodeErrors: number;
  truncatedLogs: number;
  lifecycleEvents: number;
  coverageBreaks: number;
  capacityDrops: number;
  curveChainLinks: number;
  curveChainBreaks: number;
  curveStaleEvents: number;
  curveStepInvalid: number;
}

export interface EngineSizes {
  buckets: number;
  bucketMints: number;
  dedupeEntries: number;
  mintStates: number;
}

class LatencyRecorder {
  private readonly samples: number[] = [];
  private index = 0;
  count = 0;
  private sum = 0;
  max = 0;
  constructor(private readonly capacity = 4096) {}
  record(ms: number): void {
    this.count += 1;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
    if (this.samples.length < this.capacity) this.samples.push(ms);
    else this.samples[this.index++ % this.capacity] = ms;
  }
  summary(): { count: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number } {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const q = (p: number): number => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] as number) : 0);
    return { count: this.count, meanMs: this.count ? this.sum / this.count : 0, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: this.max };
  }
}

export class PumpfunVolumeEngine implements OneMinuteVolumeProvider, NativeMarketProvider {
  private readonly o: Required<Omit<PumpfunVolumeEngineOptions, 'onTradeAccepted' | 'onLifecycle' | 'onCoverageChange'>> &
    Pick<PumpfunVolumeEngineOptions, 'onTradeAccepted' | 'onLifecycle' | 'onCoverageChange'>;
  private readonly buckets = new SecondBucketStore();
  private readonly seen: BoundedIdentitySet;
  private readonly mints = new Map<string, MintState>();

  private started = false;
  private connected = false;
  private awaitingFirstEvent = true;
  private coverageSinceSec: number | null = null;
  private epoch = 0;
  private breakReason: VolumeCoverageReason | null = null;
  private watermarkSec: number | null = null;
  private lastNotificationMs: number | null = null;
  private lastPruneSec = 0;
  private lastMintPruneSec = 0;
  private lastSlot: number | null = null;
  private lastEventReceivedAtMs: number | null = null;

  readonly stats: EngineStats = {
    notifications: 0,
    failedTransactions: 0,
    unknownStatus: 0,
    tradeEventsDecoded: 0,
    tradesAccepted: 0,
    tradesCountedInVolume: 0,
    duplicates: 0,
    excludedNonSolQuote: 0,
    excludedUnprovenQuote: 0,
    lateEvents: 0,
    tooOldDropped: 0,
    futureRejected: 0,
    decodeErrors: 0,
    truncatedLogs: 0,
    lifecycleEvents: 0,
    coverageBreaks: 0,
    capacityDrops: 0,
    curveChainLinks: 0,
    curveChainBreaks: 0,
    curveStaleEvents: 0,
    curveStepInvalid: 0,
  };
  readonly decodeLatency = new LatencyRecorder();
  readonly aggregationLatency = new LatencyRecorder();
  readonly queryLatency = new LatencyRecorder();

  constructor(options: PumpfunVolumeEngineOptions = {}) {
    this.o = {
      program: options.program ?? PUMPFUN_PROGRAM_ID,
      retentionSec: options.retentionSec ?? 180,
      settleSec: options.settleSec ?? 1,
      silenceMs: options.silenceMs ?? 5000,
      maxWatermarkLagSec: options.maxWatermarkLagSec ?? 30,
      futureToleranceSec: options.futureToleranceSec ?? 30,
      maxDedupeEntries: options.maxDedupeEntries ?? 200_000,
      maxBuckets: options.maxBuckets ?? 200_000,
      maxMintStates: options.maxMintStates ?? 50_000,
      mintStateIdleSec: options.mintStateIdleSec ?? 7200,
      maxSnapshotSkewSec: options.maxSnapshotSkewSec ?? 5,
      onTradeAccepted: options.onTradeAccepted,
      onLifecycle: options.onLifecycle,
      onCoverageChange: options.onCoverageChange,
    };
    if (this.o.retentionSec < 120 + this.o.settleSec) throw new Error('retentionSec must cover two 60 s windows plus the settle margin');
    this.seen = new BoundedIdentitySet(this.o.maxDedupeEntries);
  }

  // ---- stream health inputs ------------------------------------------------

  /** The subscription was established. Coverage is NOT assumed: it is restored by the first event. */
  markStreamStarted(nowMs: number): void {
    const first = !this.started;
    this.started = true;
    this.connected = true;
    this.lastNotificationMs = null;
    this.coverageSinceSec = null;
    this.awaitingFirstEvent = true;
    this.epoch += 1;
    this.emitCoverage({ atMs: nowMs, kind: first ? 'start' : 'break', reason: first ? 'ok' : 'coverage_gap' });
  }

  /** The websocket dropped. Whatever web3.js does next, events in the gap are lost and unknowable. */
  markDisconnected(reason: VolumeCoverageReason, nowMs: number): void {
    this.connected = false;
    this.breakCoverage(reason, nowMs);
  }

  /** The websocket is back (web3.js re-subscribed). No replay exists, so coverage stays unknown until the first new event. */
  markReconnected(nowMs: number): void {
    this.started = true;
    this.connected = true;
    this.lastNotificationMs = null;
    if (this.coverageSinceSec !== null) this.breakCoverage('coverage_gap', nowMs);
    this.awaitingFirstEvent = true;
  }

  /** Any error that may have cost us events (subscription error, HTTP error on a related call). */
  recordStreamError(nowMs: number): void {
    this.breakCoverage('stream_error', nowMs);
  }

  /** Silence watchdog. Called from the query path and from a timer. */
  checkLiveness(nowMs: number): void {
    if (!this.started || this.coverageSinceSec === null || this.lastNotificationMs === null) return;
    if (nowMs - this.lastNotificationMs > this.o.silenceMs) this.breakCoverage('stream_silent', nowMs);
  }

  /** Records a coverage break with an explicit reason (also the replay entry point for logged breaks). */
  recordBreak(reason: VolumeCoverageReason, nowMs: number): void {
    this.breakCoverage(reason, nowMs);
  }

  // ---- ingestion -----------------------------------------------------------

  /** Replay entry point: an already-decoded, already-validated trade goes through the SAME acceptance path as a live one. */
  ingestNormalizedTrade(e: NormalizedTradeEvent): void {
    this.lastNotificationMs = null; // replay has no local liveness signal; logged breaks carry that information
    this.acceptTrade(e);
  }

  ingestNormalizedLifecycle(l: LifecycleEvent): void {
    this.acceptLifecycle(l);
  }

  /** Feed one `onLogs` notification. Never throws: a failure becomes a coverage break. */
  onNotification(input: LogNotificationInput): void {
    try {
      this.ingest(input);
    } catch {
      this.breakCoverage('decode_error', input.receivedAtMs);
    }
  }

  private ingest(input: LogNotificationInput): void {
    this.stats.notifications += 1;
    this.lastNotificationMs = input.receivedAtMs;
    this.lastSlot = input.slot;

    const t0 = performance.now();
    const decoded = decodePumpfunNotification({ ...input, programId: this.o.program });
    this.decodeLatency.record(performance.now() - t0);

    if (decoded.status === 'failed_tx') {
      this.stats.failedTransactions += 1;
      return;
    }
    if (decoded.status === 'unknown_status') {
      this.stats.unknownStatus += 1;
      return;
    }
    if (decoded.decodeErrors.length > 0) {
      this.stats.decodeErrors += decoded.decodeErrors.length;
      this.breakCoverage('decode_error', input.receivedAtMs);
    }
    if (decoded.truncated) {
      this.stats.truncatedLogs += 1;
      this.breakCoverage('logs_truncated', input.receivedAtMs);
    }

    const t1 = performance.now();
    for (const l of decoded.lifecycle) this.acceptLifecycle(l);
    for (const e of decoded.trades) this.acceptTrade(e);
    this.aggregationLatency.record(performance.now() - t1);
  }

  private observeEventTime(sec: number, receivedAtMs: number): boolean {
    if (sec > Math.floor(receivedAtMs / 1000) + this.o.futureToleranceSec) {
      this.stats.futureRejected += 1;
      return false;
    }
    if (this.watermarkSec !== null && sec < this.watermarkSec - this.o.retentionSec) {
      this.stats.tooOldDropped += 1;
      return false;
    }
    return true;
  }

  private advanceWatermark(sec: number, receivedAtMs: number): void {
    if (this.awaitingFirstEvent && this.connected) {
      // First event of a (re)started healthy stream: the second it belongs to may already have lost earlier slots, so coverage starts the NEXT second.
      // Never earlier than the newest second already known, so a delayed old event cannot pull coverage backwards.
      this.coverageSinceSec = Math.max(sec, this.watermarkSec ?? sec) + 1;
      this.awaitingFirstEvent = false;
      this.emitCoverage({ atMs: receivedAtMs, kind: 'resume', reason: 'ok' });
    }
    if (this.watermarkSec === null || sec > this.watermarkSec) {
      this.watermarkSec = sec;
      this.lastEventReceivedAtMs = receivedAtMs;
      this.pruneIfDue();
    }
  }

  private acceptTrade(e: NormalizedTradeEvent): void {
    this.stats.tradeEventsDecoded += 1;
    if (!this.observeEventTime(e.eventTimestampSec, e.receivedAtMs)) return;
    if (!this.seen.add(tradeIdentity(e), e.eventTimestampSec)) {
      this.stats.duplicates += 1;
      return;
    }
    this.stats.tradesAccepted += 1;
    if (this.watermarkSec !== null && e.eventTimestampSec < this.watermarkSec) this.stats.lateEvents += 1; // arrived after a newer second (out of order)
    this.advanceWatermark(e.eventTimestampSec, e.receivedAtMs);

    const state = this.touchMint(e.mint, e.eventTimestampSec);
    if (e.quoteClass === 'other') {
      this.stats.excludedNonSolQuote += 1;
      if (state.status === 'active') state.status = 'non_sol_quote';
    } else if (e.quoteClass === 'unproven') {
      this.stats.excludedUnprovenQuote += 1;
      if (state.status === 'active') state.status = 'quote_unproven';
    } else if (state.status === 'active') {
      state.provenEpoch = this.epoch;
      this.updateCurve(state, e);
      this.buckets.add(e.mint, e.eventTimestampSec, e.solAmountLamports, e.isBuy);
      this.stats.tradesCountedInVolume += 1;
      if (this.buckets.buckets > this.o.maxBuckets) {
        this.buckets.enforceCap(this.o.maxBuckets);
        this.stats.capacityDrops += 1;
        this.breakCoverage('capacity_exceeded', e.receivedAtMs);
      }
    }
    this.o.onTradeAccepted?.(e);
  }

  private acceptLifecycle(l: LifecycleEvent): void {
    this.stats.lifecycleEvents += 1;
    if (!this.observeEventTime(l.eventTimestampSec, l.receivedAtMs)) return;
    if (!this.seen.add(`L:${l.kind}:${l.signature}:${l.program}:${l.eventOrdinal}`, l.eventTimestampSec)) return;
    this.advanceWatermark(l.eventTimestampSec, l.receivedAtMs);
    const state = this.touchMint(l.mint, l.eventTimestampSec, l.kind === 'create');
    if (l.kind === 'create') {
      if (state.creationSec === null) {
        state.creationSec = l.eventTimestampSec;
        state.createdInEpoch = this.epoch;
      }
      if (l.quoteMint === null) {
        if (state.status === 'active') state.status = 'quote_unproven';
      } else if (l.quoteMint !== NATIVE_SOL_QUOTE_MINT) {
        if (state.status === 'active') state.status = 'non_sol_quote';
      } else {
        state.provenEpoch = this.epoch;
      }
    } else {
      state.status = 'graduated'; // sticky: bonding-curve trade coverage has ended for this mint
    }
    this.o.onLifecycle?.(l);
  }

  private touchMint(mint: string, sec: number, isCreate = false): MintState {
    let s = this.mints.get(mint);
    if (!s) {
      s = { status: 'active', creationSec: null, createdInEpoch: null, provenEpoch: isCreate ? this.epoch : -1, lastEventSec: sec, curve: null };
      this.mints.set(mint, s);
      if (this.mints.size > this.o.maxMintStates) this.evictOldestMintStates();
    }
    if (sec > s.lastEventSec) s.lastEventSec = sec;
    return s;
  }

  private evictOldestMintStates(): void {
    // Losing a state is fail-closed: an unknown mint is UNAVAILABLE, never zero.
    const excess = this.mints.size - this.o.maxMintStates;
    let removed = 0;
    for (const key of this.mints.keys()) {
      if (removed >= excess) break;
      this.mints.delete(key);
      removed += 1;
    }
  }

  /**
   * Tracks the bonding-curve state carried by the event. The state of a mint is the post-trade state of its
   * LATEST trade; arrival order can differ from execution order inside one slot, so an event that is the
   * predecessor of the current state (its post equals the current pre) is recognised and does not replace it.
   */
  private updateCurve(state: MintState, e: NormalizedTradeEvent): void {
    const post = e.curve;
    if (!post) {
      state.curve = { post: EMPTY_CURVE, pre: EMPTY_PRE, slot: e.slot, eventSec: e.eventTimestampSec, stepOk: false, unreadable: true };
      return;
    }
    const tokenAmount = BigInt(e.tokenAmount);
    const prev = state.curve;
    if (prev && !prev.unreadable) {
      if (e.slot < prev.slot) {
        this.stats.curveStaleEvents += 1;
        return;
      }
      if (chainLinks(prev.post, post, e.isBuy, e.solAmountLamports, tokenAmount)) {
        this.stats.curveChainLinks += 1;
      } else if (e.slot === prev.slot && curvesEqual(prev.pre, post)) {
        this.stats.curveStaleEvents += 1; // this event executed BEFORE the current state within the same slot
        return;
      } else {
        this.stats.curveChainBreaks += 1; // a trade of this mint was missed (or a different curve): re-anchor on this event
      }
    }
    const stepOk = isConstantProductStep(post, e.isBuy, e.solAmountLamports, tokenAmount);
    if (!stepOk) this.stats.curveStepInvalid += 1;
    state.curve = { post, pre: preTradeState(post, e.isBuy, e.solAmountLamports, tokenAmount), slot: e.slot, eventSec: e.eventTimestampSec, stepOk, unreadable: false };
  }

  /** Stream-level gate shared by volume and curve answers. Returns a reason when the stream cannot be trusted right now. */
  private streamGate(nowMs: number): VolumeCoverageReason | null {
    if (!this.started) return 'stream_not_started';
    this.checkLiveness(nowMs);
    if (!this.connected) return this.breakReason ?? 'stream_disconnected';
    if (this.coverageSinceSec === null || this.watermarkSec === null) return this.breakReason ?? 'insufficient_history';
    if (nowMs / 1000 - this.watermarkSec > this.o.maxWatermarkLagSec) return 'watermark_stale';
    return null;
  }

  /** Shared validity ladder for every answer that depends on the curve state (snapshot and sell impact). */
  private resolveCurve(
    mint: string,
    nowMs: number,
  ): { ok: true; track: CurveTrack } | { ok: false; quality: NativeDataQuality; reason: NativeUnavailableReason } {
    const gate = this.streamGate(nowMs);
    if (gate) return { ok: false, quality: gate === 'watermark_stale' ? 'STALE' : 'UNAVAILABLE', reason: gate };
    const state = this.mints.get(mint);
    if (!state) return { ok: false, quality: 'UNAVAILABLE', reason: 'mint_not_observed' };
    if (state.status === 'graduated') return { ok: false, quality: 'GRADUATED', reason: 'graduated' };
    if (state.status === 'non_sol_quote') return { ok: false, quality: 'UNAVAILABLE', reason: 'non_sol_quote' };
    if (state.status === 'quote_unproven') return { ok: false, quality: 'UNAVAILABLE', reason: 'quote_unproven' };
    if (state.provenEpoch !== this.epoch) return { ok: false, quality: 'STALE', reason: 'token_state_unproven' };
    const track = state.curve;
    if (!track) return { ok: false, quality: 'UNAVAILABLE', reason: 'no_curve_state' };
    if (track.unreadable) return { ok: false, quality: 'MALFORMED', reason: 'curve_state_unreadable' };
    if (track.post.mayhemMode === true) return { ok: false, quality: 'UNAVAILABLE', reason: 'unsupported_mayhem_curve' };
    if (track.post.mayhemMode === null) return { ok: false, quality: 'UNAVAILABLE', reason: 'curve_mode_unproven' };
    if (!track.stepOk) return { ok: false, quality: 'MALFORMED', reason: 'curve_step_inconsistent' };
    return { ok: true, track };
  }

  /** Exact SELL impact of `tokenAmountRaw` base units into the token's current curve; null impact => the caller must fail closed. */
  getNativeSellImpact(mint: string, tokenAmountRaw: bigint, nowMs: number = Date.now()): NativeSellImpact {
    const resolved = this.resolveCurve(mint, nowMs);
    if (!resolved.ok) return { quality: resolved.quality, reason: resolved.reason, sellPriceImpactPct: null };
    return { quality: 'VALID', reason: null, sellPriceImpactPct: sellPriceImpactPct(resolved.track.post, tokenAmountRaw) };
  }

  /**
   * ONE coherent native market observation (Phase 5.5). Price, liquidity and price impact come from the latest
   * curve state; volume, acceleration, buy/sell ratio and tx count from the 5.4B windows; both are derived from
   * the same stream and the same watermark. Nothing here performs I/O.
   */
  getNativeMarketSnapshot(mint: string, entrySizeSol: number, nowMs: number = Date.now()): NativeMarketSnapshot {
    const volume = this.compute(mint, nowMs);
    const snap = emptyNativeSnapshot(entrySizeSol, volume);
    const fail = (quality: NativeDataQuality, reason: NativeUnavailableReason): NativeMarketSnapshot => ({ ...snap, quality, reason });

    const resolved = this.resolveCurve(mint, nowMs);
    if (!resolved.ok) return fail(resolved.quality, resolved.reason);
    const track = resolved.track;

    const watermark = this.watermarkSec as number;
    const windowEnd = volume.windowEndSec;
    const skew = windowEnd === null ? null : Math.abs(watermark - windowEnd);
    if (skew !== null && skew > this.o.maxSnapshotSkewSec) return { ...fail('TIMESTAMP_SKEW', 'timestamp_skew'), skewSec: skew };

    const post = track.post;
    const entryLamports = BigInt(Math.round(entrySizeSol * 1e9));
    const net = entryNetLamports(entryLamports, post.feeBasisPoints, post.creatorFeeBasisPoints);
    const tokensBought = tokensOutForNetSol(post.virtualSolReserves, post.virtualTokenReserves, net);
    const sells = volume.currentEventCount - volume.currentBuyCount;
    const volumeKnown = volume.volume1mSol !== null;
    let ratio: number | null = null;
    if (volumeKnown) {
      if (volume.currentBuyCount > 0) ratio = sells > 0 ? volume.currentBuyCount / sells : Number.POSITIVE_INFINITY;
      else if (sells > 0) ratio = 0;
    }
    return {
      ...snap,
      quality: 'VALID',
      reason: null,
      priceSol: spotPriceSol(post.virtualSolReserves, post.virtualTokenReserves),
      liquiditySol: realSolLiquidity(post.realSolReserves),
      priceImpactPct: buyPriceImpactPct(post, net),
      buyTokenAmountRaw: tokensBought > 0n ? tokensBought.toString() : null,
      // Selling exactly what the entry would have bought: a DIFFERENT formula from the buy impact (token-reserve side).
      sellPriceImpactPct: tokensBought > 0n ? sellPriceImpactPct(post, tokensBought) : null,
      volume1mSol: volume.volume1mSol,
      buyVolume1mSol: volume.currentBuyVolumeSol,
      sellVolume1mSol: volume.currentBuyVolumeSol === null || volume.volume1mSol === null ? null : Math.max(0, volume.volume1mSol - volume.currentBuyVolumeSol),
      previousVolume1mSol: volume.previousVolume1mSol,
      volumeAccelerationX: volume.volumeAccelerationX,
      buySellRatio: ratio,
      txCount1m: volumeKnown ? volume.currentEventCount : null,
      curve: {
        virtualSolReserves: post.virtualSolReserves.toString(),
        virtualTokenReserves: post.virtualTokenReserves.toString(),
        realSolReserves: post.realSolReserves.toString(),
        realTokenReserves: post.realTokenReserves.toString(),
        feeBasisPoints: post.feeBasisPoints,
        creatorFeeBasisPoints: post.creatorFeeBasisPoints,
      },
      marketDataAsOfSec: watermark,
      stateEventSec: track.eventSec,
      stateSlot: track.slot,
      skewSec: skew,
    };
  }

  private pruneIfDue(): void {
    const w = this.watermarkSec as number;
    if (w === this.lastPruneSec) return;
    this.lastPruneSec = w;
    const minSec = w - this.o.retentionSec;
    this.buckets.pruneOlderThan(minSec);
    this.seen.pruneOlderThan(minSec);
    if (w - this.lastMintPruneSec >= 60) {
      this.lastMintPruneSec = w;
      const idleCut = w - this.o.mintStateIdleSec;
      for (const [mint, s] of this.mints) if (s.lastEventSec < idleCut) this.mints.delete(mint);
    }
  }

  private breakCoverage(reason: VolumeCoverageReason, nowMs: number): void {
    const transition = this.coverageSinceSec !== null; // healthy -> broken
    const changedReason = this.breakReason !== reason;
    this.coverageSinceSec = null;
    this.awaitingFirstEvent = true;
    this.breakReason = reason;
    this.epoch += 1; // every break invalidates 'proven on the curve' evidence gathered before it
    if (transition) this.stats.coverageBreaks += 1;
    if (transition || changedReason) this.emitCoverage({ atMs: nowMs, kind: 'break', reason });
  }

  private emitCoverage(c: Omit<CoverageChange, 'eventSec' | 'epoch'>): void {
    this.o.onCoverageChange?.({ ...c, eventSec: this.watermarkSec, epoch: this.epoch });
  }

  // ---- queries -------------------------------------------------------------

  getOneMinuteVolume(mint: string, nowMs: number = Date.now()): OneMinuteVolume {
    const t0 = performance.now();
    try {
      return this.compute(mint, nowMs);
    } finally {
      this.queryLatency.record(performance.now() - t0);
    }
  }

  private base(reason: VolumeCoverageReason, status: 'UNKNOWN' | 'UNAVAILABLE'): OneMinuteVolume {
    const v = unavailableVolume(reason, status);
    v.watermarkSec = this.watermarkSec;
    v.windowEndSec = this.watermarkSec === null ? null : this.watermarkSec - this.o.settleSec;
    return v;
  }

  private compute(mint: string, nowMs: number): OneMinuteVolume {
    const gate = this.streamGate(nowMs);
    if (gate) return this.base(gate, 'UNKNOWN');

    const state = this.mints.get(mint);
    if (!state) return this.base('mint_not_observed', 'UNAVAILABLE');
    if (state.status === 'graduated') return this.base('graduated', 'UNAVAILABLE');
    if (state.status === 'non_sol_quote') return this.base('non_sol_quote', 'UNAVAILABLE');
    if (state.status === 'quote_unproven') return this.base('quote_unproven', 'UNAVAILABLE');
    // Not re-proven since the last coverage break: it may have graduated inside the gap.
    if (state.provenEpoch !== this.epoch) return this.base('token_state_unproven', 'UNKNOWN');

    const T = (this.watermarkSec as number) - this.o.settleSec;
    const curStart = T - 59;
    const prevStart = T - 119;
    const prevEnd = T - 60;
    const coverageSince = this.coverageSinceSec as number;
    const creationCovered = state.createdInEpoch === this.epoch && state.creationSec !== null;
    const covered = (start: number, end: number): boolean => {
      if (creationCovered && end < (state.creationSec as number)) return true; // window entirely before the token existed
      if (creationCovered) return true; // continuous coverage since the observed creation
      return coverageSince <= start;
    };
    const curCovered = covered(curStart, T);
    const prevCovered = covered(prevStart, prevEnd);

    const cur = this.buckets.sum(mint, curStart, T);
    const prev = this.buckets.sum(mint, prevStart, prevEnd);
    const volume = curCovered ? cur.lamports / 1e9 : null;
    const previous = prevCovered ? prev.lamports / 1e9 : null;

    let acceleration: number | null = null;
    if (volume !== null && previous !== null) {
      if (previous > 0) acceleration = volume / previous;
      else if (volume > 0) acceleration = Number.POSITIVE_INFINITY;
      // previous == 0 and current == 0: the ratio is undefined; nothing is manufactured.
    }

    return {
      volume1mSol: volume,
      previousVolume1mSol: previous,
      volumeAccelerationX: acceleration,
      windowEndSec: T,
      watermarkSec: this.watermarkSec,
      currentEventCount: curCovered ? cur.count : 0,
      previousEventCount: prevCovered ? prev.count : 0,
      currentBuyCount: curCovered ? cur.buyCount : 0,
      currentBuyVolumeSol: curCovered ? cur.buyLamports / 1e9 : null,
      coverage: curCovered
        ? { status: 'COMPLETE', reason: 'ok', currentWindowCovered: true, previousWindowCovered: prevCovered }
        : { status: 'UNKNOWN', reason: this.breakReason ?? 'insufficient_history', currentWindowCovered: false, previousWindowCovered: false },
    };
  }

  // ---- introspection -------------------------------------------------------

  sizes(): EngineSizes {
    return { buckets: this.buckets.buckets, bucketMints: this.buckets.mints, dedupeEntries: this.seen.size, mintStates: this.mints.size };
  }

  health(nowMs: number): {
    started: boolean;
    connected: boolean;
    coverageSinceSec: number | null;
    epoch: number;
    breakReason: VolumeCoverageReason | null;
    watermarkSec: number | null;
    lastSlot: number | null;
    lastNotificationAgeMs: number | null;
    watermarkLagSec: number | null;
  } {
    return {
      started: this.started,
      connected: this.connected,
      coverageSinceSec: this.coverageSinceSec,
      epoch: this.epoch,
      breakReason: this.breakReason,
      watermarkSec: this.watermarkSec,
      lastSlot: this.lastSlot,
      lastNotificationAgeMs: this.lastNotificationMs === null ? null : nowMs - this.lastNotificationMs,
      watermarkLagSec: this.watermarkSec === null ? null : nowMs / 1000 - this.watermarkSec,
    };
  }

  /** Newest arrival time of an event that advanced the watermark (receipt metadata only). */
  get lastEventReceivedAt(): number | null {
    return this.lastEventReceivedAtMs;
  }

  /** Test/replay helper: forget everything (a process restart). */
  reset(): void {
    this.buckets.clear();
    this.seen.clear();
    this.mints.clear();
    this.started = false;
    this.connected = false;
    this.awaitingFirstEvent = true;
    this.coverageSinceSec = null;
    this.breakReason = null;
    this.watermarkSec = null;
    this.lastNotificationMs = null;
  }
}

const EMPTY_CURVE: CurveState = { virtualSolReserves: 0n, virtualTokenReserves: 0n, realSolReserves: 0n, realTokenReserves: 0n, feeBasisPoints: 0, creatorFeeBasisPoints: 0, mayhemMode: null };
const EMPTY_PRE: PreTradeState = { virtualSol: 0n, virtualToken: 0n, realSol: 0n, realToken: 0n };

function curvesEqual(pre: PreTradeState, post: CurveState): boolean {
  return pre.virtualSol === post.virtualSolReserves && pre.virtualToken === post.virtualTokenReserves && pre.realSol === post.realSolReserves && pre.realToken === post.realTokenReserves;
}

function emptyNativeSnapshot(entrySizeSol: number, volume: OneMinuteVolume): NativeMarketSnapshot {
  return {
    source: 'pumpfun_native',
    quality: 'UNAVAILABLE',
    reason: null,
    priceSol: null,
    liquiditySol: null,
    priceImpactPct: null,
    buyTokenAmountRaw: null,
    sellPriceImpactPct: null,
    entrySizeSol,
    volume1mSol: null,
    buyVolume1mSol: null,
    sellVolume1mSol: null,
    previousVolume1mSol: null,
    volumeAccelerationX: null,
    buySellRatio: null,
    txCount1m: null,
    volumeCoverage: volume.coverage,
    curve: null,
    marketDataAsOfSec: volume.watermarkSec,
    stateEventSec: null,
    stateSlot: null,
    volumeWindowEndSec: volume.windowEndSec,
    watermarkSec: volume.watermarkSec,
    skewSec: null,
  };
}
