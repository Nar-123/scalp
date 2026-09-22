import type { DatabaseSync } from 'node:sqlite';
import { PumpfunVolumeEngine, type PumpfunVolumeEngineOptions } from './pumpfunVolumeEngine.js';
import { unavailableVolume, type LifecycleEvent, type NativeMarketSnapshot, type NormalizedTradeEvent, type OneMinuteVolume, type QuoteClass, type VolumeCoverageReason } from './types.js';

interface TradeRow {
  signature: string;
  program: string;
  event_ordinal: number;
  mint: string;
  sol_amount_lamports: number;
  token_amount: string;
  is_buy: number;
  event_timestamp: number;
  slot: number;
  quote_mint: string | null;
  quote_class: string;
  received_at_ms: number;
  virtual_sol_reserves: string | null;
  virtual_token_reserves: string | null;
  real_sol_reserves: string | null;
  real_token_reserves: string | null;
  fee_basis_points: number | null;
  creator_fee_basis_points: number | null;
  mayhem_mode: number | null;
}
interface LifeRow {
  signature: string;
  program: string;
  event_ordinal: number;
  kind: string;
  mint: string;
  event_timestamp: number;
  slot: number;
  quote_mint: string | null;
  received_at_ms: number;
}
interface CovRow {
  at_ms: number;
  kind: string;
  reason: string;
}

type Step = { at: number; order: number; apply: (e: PumpfunVolumeEngine) => void };

/**
 * Recomputes the native 1-minute volume for `mint` as it would have been
 * observed at wall-clock `atMs`, from the RECORDED normalized events and the
 * recorded coverage log, through the SAME engine class production uses (no
 * second formula). Replay only ever knows what was recorded:
 *  - no recorded events / no recorded coverage start  => null (never a
 *    reconstruction from any other data source);
 *  - history older than `lookbackMs` before `atMs` is not consulted, so replay
 *    can be MORE conservative than live (null where live had a value), never
 *    less.
 */
export function replayPumpfunVolume(
  db: DatabaseSync,
  mint: string,
  atMs: number,
  options: { lookbackMs?: number; engine?: PumpfunVolumeEngineOptions } = {},
): OneMinuteVolume {
  const engine = replayEngine(db, atMs, options);
  return engine ? engine.getOneMinuteVolume(mint, atMs) : unavailableVolume('no_historical_events', 'UNKNOWN');
}

/**
 * Native market snapshot (price, liquidity, price impact, volume...) as it would have been observed at `atMs`,
 * from recorded events only, through the SAME engine class. No recorded events => UNAVAILABLE (never fabricated).
 */
export function replayNativeMarketSnapshot(
  db: DatabaseSync,
  mint: string,
  entrySizeSol: number,
  atMs: number,
  options: { lookbackMs?: number; engine?: PumpfunVolumeEngineOptions } = {},
): NativeMarketSnapshot {
  const engine = replayEngine(db, atMs, options);
  if (engine) return engine.getNativeMarketSnapshot(mint, entrySizeSol, atMs);
  return {
    source: 'pumpfun_native',
    quality: 'UNAVAILABLE',
    reason: 'no_historical_events',
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
    volumeCoverage: unavailableVolume('no_historical_events', 'UNKNOWN').coverage,
    curve: null,
    marketDataAsOfSec: null,
    stateEventSec: null,
    stateSlot: null,
    volumeWindowEndSec: null,
    watermarkSec: null,
    skewSec: null,
  };
}

function replayEngine(db: DatabaseSync, atMs: number, options: { lookbackMs?: number; engine?: PumpfunVolumeEngineOptions }): PumpfunVolumeEngine | null {
  const lookbackMs = options.lookbackMs ?? 15 * 60_000;
  const fromMs = atMs - lookbackMs;

  const trades = db
    .prepare(
      `SELECT * FROM pumpfun_trade_events WHERE received_at_ms > ? AND received_at_ms <= ? ORDER BY received_at_ms, rowid`,
    )
    .all(fromMs, atMs) as unknown as TradeRow[];
  if (trades.length === 0) return null;
  const life = db
    .prepare(`SELECT * FROM pumpfun_lifecycle_events WHERE received_at_ms > ? AND received_at_ms <= ? ORDER BY received_at_ms, rowid`)
    .all(fromMs, atMs) as unknown as LifeRow[];
  const cov = db
    .prepare(`SELECT at_ms, kind, reason FROM volume_coverage_log WHERE at_ms > ? AND at_ms <= ? AND kind IN ('start','break') ORDER BY at_ms, id`)
    .all(fromMs, atMs) as unknown as CovRow[];

  const steps: Step[] = [];
  // Coverage rows sort BEFORE events sharing a millisecond: a break is logged before the notification's events are applied.
  let order = 0;
  for (const c of cov) {
    steps.push({
      at: c.at_ms,
      order: order++,
      apply: (e) => (c.kind === 'start' ? e.markStreamStarted(c.at_ms) : e.recordBreak(c.reason as VolumeCoverageReason, c.at_ms)),
    });
  }
  const firstEventAt = trades[0]?.received_at_ms ?? atMs;
  // A recorded stream always has a 'start' row; if the window opens mid-run there is none, so mark the stream started at the first event.
  if (!cov.some((c) => c.kind === 'start')) steps.unshift({ at: firstEventAt, order: -1, apply: (e) => e.markStreamStarted(firstEventAt) });
  for (const t of trades) {
    steps.push({ at: t.received_at_ms, order: order++, apply: (e) => e.ingestNormalizedTrade(toTrade(t)) });
  }
  for (const l of life) {
    steps.push({ at: l.received_at_ms, order: order++, apply: (e) => e.ingestNormalizedLifecycle(toLifecycle(l)) });
  }
  steps.sort((a, b) => a.at - b.at || a.order - b.order);

  const engine = new PumpfunVolumeEngine(options.engine);
  for (const s of steps) s.apply(engine);
  return engine;
}

function toTrade(t: TradeRow): NormalizedTradeEvent {
  return {
    signature: t.signature,
    program: t.program,
    eventOrdinal: t.event_ordinal,
    mint: t.mint,
    solAmountLamports: t.sol_amount_lamports,
    tokenAmount: t.token_amount,
    isBuy: t.is_buy === 1,
    trader: '',
    eventTimestampSec: t.event_timestamp,
    slot: t.slot,
    quoteMint: t.quote_mint,
    quoteClass: t.quote_class as QuoteClass,
    curve:
      t.virtual_sol_reserves !== null && t.virtual_token_reserves !== null && t.real_sol_reserves !== null && t.real_token_reserves !== null
        ? {
            virtualSolReserves: BigInt(t.virtual_sol_reserves),
            virtualTokenReserves: BigInt(t.virtual_token_reserves),
            realSolReserves: BigInt(t.real_sol_reserves),
            realTokenReserves: BigInt(t.real_token_reserves),
            feeBasisPoints: t.fee_basis_points ?? 0,
            creatorFeeBasisPoints: t.creator_fee_basis_points ?? 0,
            mayhemMode: t.mayhem_mode === null ? null : t.mayhem_mode === 1,
          }
        : null,
    receivedAtMs: t.received_at_ms,
    source: 'onlogs_program_data',
  };
}

function toLifecycle(l: LifeRow): LifecycleEvent {
  return {
    signature: l.signature,
    program: l.program,
    eventOrdinal: l.event_ordinal,
    kind: l.kind as LifecycleEvent['kind'],
    mint: l.mint,
    eventTimestampSec: l.event_timestamp,
    slot: l.slot,
    quoteMint: l.quote_mint,
    receivedAtMs: l.received_at_ms,
  };
}
