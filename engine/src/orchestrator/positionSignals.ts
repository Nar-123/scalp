import type { PricePoint } from '../types/trade.js';
import { pctChange } from '../utils/math.js';

const MOMENTUM_WINDOW_MS = 3000;

function findClosestBefore(points: PricePoint[], targetMs: number): PricePoint | null {
  let best: PricePoint | null = null;
  for (const point of points) {
    if (point.timestampMs <= targetMs && (!best || point.timestampMs > best.timestampMs)) {
      best = point;
    }
  }
  return best;
}

/** Percent price change over the last ~3s of recorded history; 0 if not enough history yet. */
export function computeRecentMomentumPct(priceHistory: PricePoint[], currentPriceSol: number, nowMs: number): number {
  const reference = findClosestBefore(priceHistory, nowMs - MOMENTUM_WINDOW_MS);
  if (!reference) return 0;
  return pctChange(reference.priceSol, currentPriceSol);
}

/**
 * Simple realized-volatility proxy: the peak-to-trough price range over all
 * recorded history so far, as a percent of the entry price. Deliberately
 * simple (no stddev/EWMA) so it stays cheap to compute every polling tick
 * and easy to reason about/test.
 */
export function computeRecentVolatilityPct(priceHistory: PricePoint[], entryPriceSol: number): number {
  if (priceHistory.length === 0 || entryPriceSol <= 0) return 0;
  let max = -Infinity;
  let min = Infinity;
  for (const point of priceHistory) {
    if (point.priceSol > max) max = point.priceSol;
    if (point.priceSol < min) min = point.priceSol;
  }
  return ((max - min) / entryPriceSol) * 100;
}
