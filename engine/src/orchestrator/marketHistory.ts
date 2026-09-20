import type { MarketSnapshot } from '../types/market.js';
import { pctChange } from '../utils/math.js';

const MAX_HISTORY_LENGTH = 30;
const VELOCITY_WINDOW_MS = 5000;
const ACCELERATION_WINDOW_MS = 60_000;

function findClosestBefore(list: MarketSnapshot[], targetMs: number): MarketSnapshot | null {
  let best: MarketSnapshot | null = null;
  for (const snap of list) {
    if (snap.observedAtMs <= targetMs && (!best || snap.observedAtMs > best.observedAtMs)) {
      best = snap;
    }
  }
  return best;
}

/**
 * Rolling per-mint snapshot history used to derive momentum/acceleration
 * signals from repeated aggregator polls. This is a polling-cadence
 * approximation (bounded by aggregator request latency, typically a couple
 * of seconds) rather than a true tick-by-tick feed -- a direct pool-account
 * websocket subscription would be needed for sub-second precision, which is
 * out of scope for this pass.
 */
export class MarketHistoryTracker {
  private readonly history = new Map<string, MarketSnapshot[]>();

  record(snapshot: MarketSnapshot): void {
    const list = this.history.get(snapshot.mint) ?? [];
    list.push(snapshot);
    while (list.length > MAX_HISTORY_LENGTH) list.shift();
    this.history.set(snapshot.mint, list);
  }

  computeVelocityPct(mint: string, currentPriceSol: number, nowMs: number): number {
    const reference = findClosestBefore(this.history.get(mint) ?? [], nowMs - VELOCITY_WINDOW_MS);
    if (!reference) return 0;
    return pctChange(reference.priceSol, currentPriceSol);
  }

  computeVolumeAccelerationX(mint: string, currentVolume1mSol: number, nowMs: number): number {
    const reference = findClosestBefore(this.history.get(mint) ?? [], nowMs - ACCELERATION_WINDOW_MS);
    if (!reference || reference.volume1mSol <= 0) {
      return currentVolume1mSol > 0 ? Number.POSITIVE_INFINITY : 0;
    }
    return currentVolume1mSol / reference.volume1mSol;
  }

  clear(mint: string): void {
    this.history.delete(mint);
  }
}
