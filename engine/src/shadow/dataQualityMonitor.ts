import type { DataQualityEventKind, DataQualityEventRecord, DataQualitySeverity, ShadowMarketTick } from './types.js';

/**
 * Realtime, stream-oriented data-quality checks -- the live twin of
 * backtest/dataQuality.ts. Every event is persisted by the caller and
 * carries a severity:
 *   block   duplicate / out-of-order tick: acting on it would be logically
 *           unsound (re-processing or moving backward in time)
 *   reject  malformed data, invalid liquidity, impossible price jump: must
 *           never become a trade signal
 *   warning stale tick, fetch errors, missing quote: recorded, tick still used
 *
 * `missing_event` is a defined kind but NO detector emits it: the only
 * "expected event" this architecture has is the ~2s evaluation timer, and a
 * gap in it is indistinguishable from stale_market_data (already reported).
 * Manufacturing missing events from that would double-count, so it is left
 * unused (see docs/PHASE_5_SHADOW_TRADING.md).
 */

const STALE_THRESHOLD_MS = 10_000; // ~5x the live ~2s poll interval
const IMPOSSIBLE_PRICE_JUMP_MULTIPLE = 5; // >5x or <1/5x in one tick is treated as implausible

export const SEVERITY_BY_KIND: Record<DataQualityEventKind, DataQualitySeverity> = {
  duplicate_event: 'block',
  out_of_order_event: 'block',
  malformed_market_data: 'reject',
  degenerate_ratio: 'warning',
  invalid_liquidity: 'reject',
  impossible_price_change: 'reject',
  stale_market_data: 'warning',
  missing_event: 'warning',
  missing_quote: 'warning',
  rpc_error: 'warning',
  aggregator_error: 'warning',
};

/** True when this severity means the tick must not drive entry/exit decisions. */
export function isBlockingSeverity(severity: DataQualitySeverity): boolean {
  return severity === 'block' || severity === 'reject';
}

function bad(value: number | null, positive = false): boolean {
  if (value === null) return false; // absent is handled as missing data, not malformed
  if (!Number.isFinite(value)) return true;
  return positive ? value <= 0 : value < 0;
}

export function checkTickDataQuality(
  mint: string,
  strategyVersion: string | null,
  previousTick: ShadowMarketTick | null,
  tick: ShadowMarketTick,
): DataQualityEventRecord[] {
  const issues: DataQualityEventRecord[] = [];
  const push = (kind: DataQualityEventKind, detail: string): void => {
    issues.push({ mint, strategyVersion, observedAtMs: tick.observedAtMs, kind, severity: SEVERITY_BY_KIND[kind], detail });
  };

  if (tick.fetchError) {
    push(
      tick.fetchError.source === 'rpc' ? 'rpc_error' : tick.fetchError.source === 'aggregator' ? 'aggregator_error' : 'missing_quote',
      tick.fetchError.message,
    );
  }

  if (tick.liquiditySol !== null && (!Number.isFinite(tick.liquiditySol) || tick.liquiditySol < 0)) {
    push('invalid_liquidity', `liquiditySol=${tick.liquiditySol}`);
  }

  const malformed: string[] = [];
  if (bad(tick.priceSol, true)) malformed.push(`priceSol=${tick.priceSol}`);
  if (bad(tick.volume1mSol)) malformed.push(`volume1mSol=${tick.volume1mSol}`);
  // +Infinity in a RATIO is the aggregator's documented result of dividing by
  // zero (buys with no sells yet; volume with no prior volume) -- a real,
  // common state for brand-new tokens that the production strategy defines
  // handling for (baseline filters pass it; entry scoring treats a non-finite
  // input as its worst case). Live validation showed rejecting it as
  // "malformed" discarded 100% of ticks for such tokens and diverged from
  // production, so it is recorded as a warning instead. NaN, -Infinity and
  // negatives remain malformed.
  const degenerate: string[] = [];
  if (tick.buySellRatio === Number.POSITIVE_INFINITY) degenerate.push('buySellRatio=Infinity');
  else if (bad(tick.buySellRatio)) malformed.push(`buySellRatio=${tick.buySellRatio}`);
  if (bad(tick.txCount1m)) malformed.push(`txCount1m=${tick.txCount1m}`);
  if (bad(tick.estimatedPriceImpactPct)) malformed.push(`estimatedPriceImpactPct=${tick.estimatedPriceImpactPct}`);
  if (tick.priceVelocity5sPct !== null && !Number.isFinite(tick.priceVelocity5sPct)) malformed.push(`priceVelocity5sPct=${tick.priceVelocity5sPct}`);
  if (tick.volumeAccelerationX === Number.POSITIVE_INFINITY) degenerate.push('volumeAccelerationX=Infinity');
  else if (tick.volumeAccelerationX !== null && !Number.isFinite(tick.volumeAccelerationX)) malformed.push(`volumeAccelerationX=${tick.volumeAccelerationX}`);
  if (!Number.isFinite(tick.observedAtMs)) malformed.push('observedAtMs not finite');
  if (malformed.length) push('malformed_market_data', malformed.join(', '));
  if (degenerate.length) push('degenerate_ratio', degenerate.join(', '));

  if (previousTick) {
    if (tick.observedAtMs === previousTick.observedAtMs) {
      push('duplicate_event', `duplicate observedAtMs=${tick.observedAtMs}`);
    } else if (tick.observedAtMs < previousTick.observedAtMs) {
      push('out_of_order_event', `observedAtMs=${tick.observedAtMs} precedes previous tick at ${previousTick.observedAtMs}`);
    } else if (tick.observedAtMs - previousTick.observedAtMs > STALE_THRESHOLD_MS) {
      push('stale_market_data', `${tick.observedAtMs - previousTick.observedAtMs}ms since the previous tick (threshold ${STALE_THRESHOLD_MS}ms)`);
    }

    if (previousTick.priceSol !== null && tick.priceSol !== null && previousTick.priceSol > 0 && tick.priceSol > 0) {
      const ratio = tick.priceSol / previousTick.priceSol;
      if (ratio > IMPOSSIBLE_PRICE_JUMP_MULTIPLE || ratio < 1 / IMPOSSIBLE_PRICE_JUMP_MULTIPLE) {
        push('impossible_price_change', `price moved from ${previousTick.priceSol} to ${tick.priceSol} (${ratio.toFixed(2)}x) in one tick`);
      }
    }
  }

  return issues;
}
