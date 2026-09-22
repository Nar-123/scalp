import type { DatabaseSync } from 'node:sqlite';
import { simulateSellFill } from '../execution/fillSimulation.js';
import type { AppConfig } from '../config/schema.js';
import type { NativeMarketProvider } from '../volume/types.js';

/**
 * Shadow price-path instrumentation (Phase 5.6H). OBSERVATION ONLY.
 *
 * After a shadow entry, the price the position would be worth is sampled at fixed offsets (default +1, 2, 3, 5, 10, 15, 30 s)
 * from the native Pump.fun market-data CACHE (in-memory reads: no RPC, no HTTP, no extra trading transaction, no polling of
 * any provider). Every observation is stored, together with the metrics derived from them (MFE, MAE, max gross move, max
 * exact net move, times to each, holding time, exit accounting).
 *
 * Data-quality rules:
 *  - a missing observation is a row with a status and a reason and null values; nothing is interpolated, carried forward or
 *    defaulted, and a missing value is never counted as a favorable move;
 *  - the exact net PnL of an observation is computed only when the sell impact of the ACTUAL held tokens and a fee rate are
 *    known, with the same `simulateSellFill` the simulator uses; otherwise it is null with a reason;
 *  - this module never feeds anything back to entry, exit or risk decisions; every entry point is exception-safe.
 */

export const DEFAULT_PATH_OFFSETS_MS: readonly number[] = [1000, 2000, 3000, 5000, 10_000, 15_000, 30_000];

export type PathPointStatus = 'observed' | 'missing' | 'after_exit' | 'interrupted';
export type PathPointKind = 'scheduled' | 'exit';
export type PathStatus = 'open' | 'complete' | 'exited_early' | 'exited_after_path' | 'interrupted';

/** What the native cache says about a token right now (no I/O). */
export interface PathObservationSource {
  priceSol: number | null;
  liquiditySol: number | null;
  stateEventSec: number | null;
  /** Venue per-leg fee of the curve state behind this observation. */
  venueFeeBps: number | null;
  /** Sell impact (%) of the ACTUAL held tokens into the current curve; null if not computable. */
  sellPriceImpactPct: number | null;
  /** Why price is unavailable (null when available). */
  unavailableReason: string | null;
  /** Why the sell impact is unavailable (null when available or when the price itself is unavailable). */
  sellImpactUnavailableReason: string | null;
}

export interface PathObserver {
  observe(mint: string, tokenAmountRaw: string | null, nowMs: number): PathObservationSource;
}

/** Reads the native Pump.fun cache. Synchronous, in-memory; a token that is not (or no longer) a provable curve is reported as unavailable. */
export class NativePathObserver implements PathObserver {
  constructor(private readonly native: NativeMarketProvider) {}

  observe(mint: string, tokenAmountRaw: string | null, nowMs: number): PathObservationSource {
    const snap = this.native.getNativeMarketSnapshot(mint, 0, nowMs);
    if (snap.quality !== 'VALID') {
      return {
        priceSol: null,
        liquiditySol: null,
        stateEventSec: null,
        venueFeeBps: null,
        sellPriceImpactPct: null,
        unavailableReason: `native_${snap.quality.toLowerCase()}${snap.reason ? `:${snap.reason}` : ''}`,
        sellImpactUnavailableReason: null,
      };
    }
    const fee = snap.curve ? snap.curve.feeBasisPoints + snap.curve.creatorFeeBasisPoints : null;
    let sellPriceImpactPct: number | null = null;
    let sellImpactUnavailableReason: string | null = null;
    if (tokenAmountRaw === null) {
      sellImpactUnavailableReason = 'entry_token_amount_missing';
    } else {
      try {
        const sell = this.native.getNativeSellImpact(mint, BigInt(tokenAmountRaw), nowMs);
        if (sell.quality === 'VALID') sellPriceImpactPct = sell.sellPriceImpactPct;
        else sellImpactUnavailableReason = `native_${sell.quality.toLowerCase()}${sell.reason ? `:${sell.reason}` : ''}`;
      } catch {
        sellImpactUnavailableReason = 'entry_token_amount_invalid';
      }
    }
    return {
      priceSol: snap.priceSol,
      liquiditySol: snap.liquiditySol,
      stateEventSec: snap.stateEventSec,
      venueFeeBps: fee !== null && Number.isFinite(fee) ? fee : null,
      sellPriceImpactPct,
      unavailableReason: snap.priceSol === null ? 'price_null' : null,
      sellImpactUnavailableReason,
    };
  }
}

export interface PathPoint {
  kind: PathPointKind;
  offsetMs: number;
  status: PathPointStatus;
  missingReason: string | null;
  scheduledAtMs: number | null;
  observedAtMs: number | null;
  observationLagMs: number | null;
  priceSol: number | null;
  liquiditySol: number | null;
  stateEventSec: number | null;
  stateAgeMs: number | null;
  sellPriceImpactPct: number | null;
  venueFeeBps: number | null;
  grossMovePct: number | null;
  netPnlSol: number | null;
  netPnlPct: number | null;
  netUnavailableReason: string | null;
}

export interface TrackedEntry {
  tradeId: string;
  tradeKind: 'shadow' | 'dry_run';
  strategyVersion: string | null;
  mint: string;
  entryTimeMs: number;
  entryPriceSol: number;
  entrySizeSol: number;
  entryFilledAmountSol: number;
  entryFeesSol: number;
  entryTokenAmountRaw: string | null;
  entryLiquiditySol: number | null;
  entryVolume1mSol: number | null;
  /** Fee model/rate the BUY leg was priced with. */
  entryFeeModel: 'pumpfun_curve' | 'configured_flat' | null;
  entryFeeBps: number | null;
}

export interface TrackedExit {
  exitTimeMs: number;
  exitPriceSol: number;
  exitFeesSol: number;
  exitReason: string;
  netPnlSol: number;
  netPnlPct: number;
}

export interface PathMetrics {
  observationsExpected: number;
  observationsObserved: number;
  pathComplete30s: boolean;
  netObservations: number;
  /** max(0, best gross move): the entry itself is the zero baseline. */
  mfePct: number | null;
  /** min(0, worst gross move). */
  maePct: number | null;
  /** Offset of the first observation reaching the MFE; null if price was never observed above the entry. */
  timeToMfeMs: number | null;
  timeToMaeMs: number | null;
  /** Largest gross move actually observed (may be negative); null if nothing was observed. */
  maxGrossMovePct: number | null;
  timeToMaxGrossMs: number | null;
  /** Largest exact net PnL % among observations where it is calculable; null if none is. */
  maxNetPnlPct: number | null;
  timeToMaxNetMs: number | null;
  /** true only if a calculable observation had net PnL > 0; false if some were calculable and none positive; null if none calculable. */
  everNetPositive: boolean | null;
}

/** Pure: metrics from the observed points. Non-observed points contribute nothing (they are never a favorable move). */
export function computePathMetrics(points: readonly PathPoint[], expectedScheduled: number): PathMetrics {
  const observed = points.filter((p) => p.status === 'observed');
  const scheduledObserved = observed.filter((p) => p.kind === 'scheduled' && p.priceSol !== null).length;
  const withGross = observed.filter((p) => p.grossMovePct !== null && Number.isFinite(p.grossMovePct));
  const withNet = observed.filter((p) => p.netPnlPct !== null && Number.isFinite(p.netPnlPct));

  let maxGross: PathPoint | null = null;
  let minGross: PathPoint | null = null;
  for (const p of withGross) {
    if (maxGross === null || (p.grossMovePct as number) > (maxGross.grossMovePct as number)) maxGross = p;
    if (minGross === null || (p.grossMovePct as number) < (minGross.grossMovePct as number)) minGross = p;
  }
  let maxNet: PathPoint | null = null;
  for (const p of withNet) if (maxNet === null || (p.netPnlPct as number) > (maxNet.netPnlPct as number)) maxNet = p;

  const haveAny = withGross.length > 0;
  const mfe = haveAny ? Math.max(0, maxGross!.grossMovePct as number) : null;
  const mae = haveAny ? Math.min(0, minGross!.grossMovePct as number) : null;
  return {
    observationsExpected: expectedScheduled,
    observationsObserved: scheduledObserved,
    pathComplete30s: expectedScheduled > 0 && scheduledObserved === expectedScheduled,
    netObservations: withNet.length,
    mfePct: mfe,
    maePct: mae,
    timeToMfeMs: mfe !== null && mfe > 0 ? maxGross!.offsetMs : null,
    timeToMaeMs: mae !== null && mae < 0 ? minGross!.offsetMs : null,
    maxGrossMovePct: haveAny ? (maxGross!.grossMovePct as number) : null,
    timeToMaxGrossMs: haveAny ? maxGross!.offsetMs : null,
    maxNetPnlPct: maxNet ? (maxNet.netPnlPct as number) : null,
    timeToMaxNetMs: maxNet ? maxNet.offsetMs : null,
    everNetPositive: withNet.length === 0 ? null : withNet.some((p) => (p.netPnlPct as number) > 0),
  };
}

/** Additive SQLite store for the two path tables (see ledger/migrations/008_price_paths.ts). */
export class PricePathStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertPoint(tradeId: string, mint: string, p: PathPoint): void {
    this.db
      .prepare(
        `INSERT INTO trade_price_paths (
          trade_id, point_kind, offset_ms, mint, status, missing_reason, scheduled_at_ms, observed_at_ms, observation_lag_ms,
          price_sol, liquidity_sol, state_event_sec, state_age_ms, sell_price_impact_pct, venue_fee_bps, gross_move_pct,
          net_pnl_sol, net_pnl_pct, net_unavailable_reason
        ) VALUES (
          @tradeId, @kind, @offsetMs, @mint, @status, @missingReason, @scheduledAtMs, @observedAtMs, @observationLagMs,
          @priceSol, @liquiditySol, @stateEventSec, @stateAgeMs, @sellPriceImpactPct, @venueFeeBps, @grossMovePct,
          @netPnlSol, @netPnlPct, @netUnavailableReason
        ) ON CONFLICT(trade_id, point_kind, offset_ms) DO UPDATE SET
          status = excluded.status, missing_reason = excluded.missing_reason, scheduled_at_ms = excluded.scheduled_at_ms,
          observed_at_ms = excluded.observed_at_ms, observation_lag_ms = excluded.observation_lag_ms, price_sol = excluded.price_sol,
          liquidity_sol = excluded.liquidity_sol, state_event_sec = excluded.state_event_sec, state_age_ms = excluded.state_age_ms,
          sell_price_impact_pct = excluded.sell_price_impact_pct, venue_fee_bps = excluded.venue_fee_bps,
          gross_move_pct = excluded.gross_move_pct, net_pnl_sol = excluded.net_pnl_sol, net_pnl_pct = excluded.net_pnl_pct,
          net_unavailable_reason = excluded.net_unavailable_reason`,
      )
      .run({ tradeId, mint, ...p });
  }

  upsertMetrics(t: TrackedEntry, exit: TrackedExit | null, status: PathStatus, m: PathMetrics, nowMs: number, finalized: boolean): void {
    this.db
      .prepare(
        `INSERT INTO trade_path_metrics (
          trade_id, trade_kind, strategy_version, mint, entry_time_ms, entry_price_sol, entry_size_sol, entry_filled_amount_sol,
          entry_fee_sol, entry_token_amount_raw, entry_liquidity_sol, entry_volume_1m_sol, entry_fee_bps, entry_fee_model,
          exit_time_ms, exit_price_sol, exit_fee_sol, exit_reason, net_pnl_sol, net_pnl_pct, holding_time_ms, path_status,
          observations_expected, observations_observed, path_complete_30s, mfe_pct, mae_pct, time_to_mfe_ms, time_to_mae_ms,
          max_gross_move_pct, time_to_max_gross_ms, max_net_pnl_pct, time_to_max_net_ms, ever_net_positive, net_observations,
          finalized_at_ms, updated_at_ms
        ) VALUES (
          @tradeId, @tradeKind, @strategyVersion, @mint, @entryTimeMs, @entryPriceSol, @entrySizeSol, @entryFilledAmountSol,
          @entryFeesSol, @entryTokenAmountRaw, @entryLiquiditySol, @entryVolume1mSol, @entryFeeBps, @entryFeeModel,
          @exitTimeMs, @exitPriceSol, @exitFeesSol, @exitReason, @netPnlSol, @netPnlPct, @holdingTimeMs, @pathStatus,
          @observationsExpected, @observationsObserved, @pathComplete30s, @mfePct, @maePct, @timeToMfeMs, @timeToMaeMs,
          @maxGrossMovePct, @timeToMaxGrossMs, @maxNetPnlPct, @timeToMaxNetMs, @everNetPositive, @netObservations,
          @finalizedAtMs, @updatedAtMs
        ) ON CONFLICT(trade_id) DO UPDATE SET
          exit_time_ms = excluded.exit_time_ms, exit_price_sol = excluded.exit_price_sol, exit_fee_sol = excluded.exit_fee_sol,
          exit_reason = excluded.exit_reason, net_pnl_sol = excluded.net_pnl_sol, net_pnl_pct = excluded.net_pnl_pct,
          holding_time_ms = excluded.holding_time_ms, path_status = excluded.path_status,
          observations_expected = excluded.observations_expected, observations_observed = excluded.observations_observed,
          path_complete_30s = excluded.path_complete_30s, mfe_pct = excluded.mfe_pct, mae_pct = excluded.mae_pct,
          time_to_mfe_ms = excluded.time_to_mfe_ms, time_to_mae_ms = excluded.time_to_mae_ms,
          max_gross_move_pct = excluded.max_gross_move_pct, time_to_max_gross_ms = excluded.time_to_max_gross_ms,
          max_net_pnl_pct = excluded.max_net_pnl_pct, time_to_max_net_ms = excluded.time_to_max_net_ms,
          ever_net_positive = excluded.ever_net_positive, net_observations = excluded.net_observations,
          finalized_at_ms = excluded.finalized_at_ms, updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
        tradeId: t.tradeId,
        tradeKind: t.tradeKind,
        strategyVersion: t.strategyVersion,
        mint: t.mint,
        entryTimeMs: t.entryTimeMs,
        entryPriceSol: t.entryPriceSol,
        entrySizeSol: t.entrySizeSol,
        entryFilledAmountSol: t.entryFilledAmountSol,
        entryFeesSol: t.entryFeesSol,
        entryTokenAmountRaw: t.entryTokenAmountRaw,
        entryLiquiditySol: t.entryLiquiditySol,
        entryVolume1mSol: t.entryVolume1mSol,
        entryFeeBps: t.entryFeeBps,
        entryFeeModel: t.entryFeeModel,
        exitTimeMs: exit?.exitTimeMs ?? null,
        exitPriceSol: exit?.exitPriceSol ?? null,
        exitFeesSol: exit?.exitFeesSol ?? null,
        exitReason: exit?.exitReason ?? null,
        netPnlSol: exit?.netPnlSol ?? null,
        netPnlPct: exit?.netPnlPct ?? null,
        holdingTimeMs: exit ? exit.exitTimeMs - t.entryTimeMs : null,
        pathStatus: status,
        observationsExpected: m.observationsExpected,
        observationsObserved: m.observationsObserved,
        pathComplete30s: m.pathComplete30s ? 1 : 0,
        mfePct: m.mfePct,
        maePct: m.maePct,
        timeToMfeMs: m.timeToMfeMs,
        timeToMaeMs: m.timeToMaeMs,
        maxGrossMovePct: m.maxGrossMovePct,
        timeToMaxGrossMs: m.timeToMaxGrossMs,
        maxNetPnlPct: m.maxNetPnlPct,
        timeToMaxNetMs: m.timeToMaxNetMs,
        everNetPositive: m.everNetPositive === null ? null : m.everNetPositive ? 1 : 0,
        netObservations: m.netObservations,
        finalizedAtMs: finalized ? nowMs : null,
        updatedAtMs: nowMs,
      });
  }
}

export interface PricePathScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers, unref'd so a pending observation can never keep the process alive. */
export const realScheduler: PricePathScheduler = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface PricePathRecorderOptions {
  store: PricePathStore;
  observer: PathObserver;
  /** The same accounting inputs the simulator uses (used only to price the exact net PnL of an observation). */
  edge: AppConfig['edge'];
  latencySlippageBufferPct: number;
  offsetsMs?: readonly number[];
  now?: () => number;
  scheduler?: PricePathScheduler;
  onError?: (message: string, err: unknown) => void;
}

interface Tracked {
  entry: TrackedEntry;
  points: Map<string, PathPoint>;
  timers: Map<number, unknown>;
  exit: TrackedExit | null;
  closed: boolean;
}

const pointKey = (kind: PathPointKind, offsetMs: number): string => `${kind}:${offsetMs}`;

export class PricePathRecorder {
  private readonly offsets: readonly number[];
  private readonly now: () => number;
  private readonly scheduler: PricePathScheduler;
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly o: PricePathRecorderOptions) {
    this.offsets = [...(o.offsetsMs ?? DEFAULT_PATH_OFFSETS_MS)].sort((a, b) => a - b);
    this.now = o.now ?? Date.now;
    this.scheduler = o.scheduler ?? realScheduler;
  }

  get activeCount(): number {
    return this.tracked.size;
  }

  /** Begin tracking an entry: stores the entry snapshot and schedules the observations. Never throws. */
  startTrade(entry: TrackedEntry): void {
    try {
      if (this.tracked.has(entry.tradeId)) return;
      const t: Tracked = { entry, points: new Map(), timers: new Map(), exit: null, closed: false };
      this.tracked.set(entry.tradeId, t);
      this.persistMetrics(t, 'open', false);
      for (const offsetMs of this.offsets) {
        const dueAtMs = entry.entryTimeMs + offsetMs;
        const delay = Math.max(0, dueAtMs - this.now());
        t.timers.set(offsetMs, this.scheduler.setTimeout(() => this.observe(t, offsetMs, dueAtMs), delay));
      }
    } catch (err) {
      this.o.onError?.('price_path_start_failed', err);
    }
  }

  /** The trade exited: stop scheduling, mark the not-yet-due offsets, record the exit point and finalize. Never throws. */
  recordExit(tradeId: string, exit: TrackedExit): void {
    try {
      const t = this.tracked.get(tradeId);
      if (!t || t.closed) return;
      t.exit = exit;
      this.cancelTimers(t);
      const holdMs = exit.exitTimeMs - t.entry.entryTimeMs;
      for (const offsetMs of this.offsets) {
        const key = pointKey('scheduled', offsetMs);
        if (t.points.has(key)) continue;
        // Offsets up to the exit moment whose timer had not fired yet are simply unobserved; later ones happen after the exit.
        this.putPoint(t, this.emptyPoint('scheduled', offsetMs, offsetMs > holdMs ? 'after_exit' : 'missing', offsetMs > holdMs ? 'trade_exited_before_offset' : 'exit_preempted_observation', t.entry.entryTimeMs + offsetMs));
      }
      const gross = t.entry.entryPriceSol > 0 ? (exit.exitPriceSol / t.entry.entryPriceSol - 1) * 100 : null;
      this.putPoint(t, {
        ...this.emptyPoint('exit', Math.max(0, holdMs), 'observed', null, exit.exitTimeMs),
        observedAtMs: exit.exitTimeMs,
        observationLagMs: 0,
        priceSol: exit.exitPriceSol,
        grossMovePct: gross,
        netPnlSol: exit.netPnlSol,
        netPnlPct: exit.netPnlPct,
      });
      const complete = this.offsets.every((off) => t.points.get(pointKey('scheduled', off))?.status === 'observed');
      const observedAll = complete ? 'exited_after_path' : 'exited_early';
      this.persistMetrics(t, observedAll, true);
      t.closed = true;
      this.tracked.delete(tradeId);
    } catch (err) {
      this.o.onError?.('price_path_exit_failed', err);
    }
  }

  /** Shutdown: cancel every timer; still-open trades keep what was observed and are marked interrupted. */
  stop(): void {
    for (const t of [...this.tracked.values()]) {
      try {
        this.cancelTimers(t);
        for (const offsetMs of this.offsets) {
          const key = pointKey('scheduled', offsetMs);
          if (!t.points.has(key)) this.putPoint(t, this.emptyPoint('scheduled', offsetMs, 'interrupted', 'shutdown_before_observation', t.entry.entryTimeMs + offsetMs));
        }
        const pathDone = this.offsets.every((off) => t.points.get(pointKey('scheduled', off))?.status === 'observed');
        this.persistMetrics(t, pathDone ? 'complete' : 'interrupted', true);
        t.closed = true;
      } catch (err) {
        this.o.onError?.('price_path_stop_failed', err);
      }
    }
    this.tracked.clear();
  }

  private cancelTimers(t: Tracked): void {
    for (const h of t.timers.values()) this.scheduler.clearTimeout(h);
    t.timers.clear();
  }

  private emptyPoint(kind: PathPointKind, offsetMs: number, status: PathPointStatus, missingReason: string | null, scheduledAtMs: number | null): PathPoint {
    return {
      kind,
      offsetMs,
      status,
      missingReason,
      scheduledAtMs,
      observedAtMs: null,
      observationLagMs: null,
      priceSol: null,
      liquiditySol: null,
      stateEventSec: null,
      stateAgeMs: null,
      sellPriceImpactPct: null,
      venueFeeBps: null,
      grossMovePct: null,
      netPnlSol: null,
      netPnlPct: null,
      netUnavailableReason: null,
    };
  }

  private observe(t: Tracked, offsetMs: number, dueAtMs: number): void {
    t.timers.delete(offsetMs);
    if (t.closed) return;
    try {
      const nowMs = this.now();
      let src: PathObservationSource;
      try {
        src = this.o.observer.observe(t.entry.mint, t.entry.entryTokenAmountRaw, nowMs);
      } catch (err) {
        this.o.onError?.('price_path_observe_failed', err);
        this.putPoint(t, this.emptyPoint('scheduled', offsetMs, 'missing', 'observer_error', dueAtMs));
        this.persistMetrics(t, 'open', false);
        return;
      }
      const price = src.priceSol;
      if (price === null || !Number.isFinite(price) || price <= 0) {
        this.putPoint(t, { ...this.emptyPoint('scheduled', offsetMs, 'missing', src.unavailableReason ?? 'price_unavailable', dueAtMs), observedAtMs: nowMs, observationLagMs: nowMs - dueAtMs });
        this.persistMetrics(t, 'open', false);
        return;
      }
      const e = t.entry;
      const grossMovePct = e.entryPriceSol > 0 ? (price / e.entryPriceSol - 1) * 100 : null;
      const feeBps = src.venueFeeBps ?? (e.entryFeeModel === 'pumpfun_curve' ? e.entryFeeBps : null);
      let netPnlSol: number | null = null;
      let netPnlPct: number | null = null;
      let netUnavailableReason: string | null = null;
      const sellImpact = src.sellPriceImpactPct;
      if (sellImpact === null || !Number.isFinite(sellImpact) || sellImpact < 0) {
        netUnavailableReason = src.sellImpactUnavailableReason ?? 'sell_impact_unavailable';
      } else if (e.entryPriceSol <= 0 || e.entrySizeSol <= 0) {
        netUnavailableReason = 'entry_state_invalid';
      } else {
        const grossValueSol = e.entryFilledAmountSol * (price / e.entryPriceSol);
        const sell = simulateSellFill(grossValueSol, sellImpact, this.o.latencySlippageBufferPct, this.o.edge, feeBps);
        netPnlSol = sell.filledAmountSol - e.entrySizeSol;
        netPnlPct = (netPnlSol / e.entrySizeSol) * 100;
      }
      this.putPoint(t, {
        kind: 'scheduled',
        offsetMs,
        status: 'observed',
        missingReason: null,
        scheduledAtMs: dueAtMs,
        observedAtMs: nowMs,
        observationLagMs: nowMs - dueAtMs,
        priceSol: price,
        liquiditySol: src.liquiditySol,
        stateEventSec: src.stateEventSec,
        stateAgeMs: src.stateEventSec === null ? null : nowMs - src.stateEventSec * 1000,
        sellPriceImpactPct: sellImpact,
        venueFeeBps: feeBps,
        grossMovePct,
        netPnlSol,
        netPnlPct,
        netUnavailableReason,
      });
      const done = this.offsets.every((off) => t.points.has(pointKey('scheduled', off)));
      this.persistMetrics(t, done ? 'complete' : 'open', false);
    } catch (err) {
      this.o.onError?.('price_path_observe_failed', err);
    }
  }

  private putPoint(t: Tracked, p: PathPoint): void {
    t.points.set(pointKey(p.kind, p.offsetMs), p);
    this.o.store.upsertPoint(t.entry.tradeId, t.entry.mint, p);
  }

  private persistMetrics(t: Tracked, status: PathStatus, finalized: boolean): void {
    const metrics = computePathMetrics([...t.points.values()], this.offsets.length);
    this.o.store.upsertMetrics(t.entry, t.exit, status, metrics, this.now(), finalized);
  }
}
