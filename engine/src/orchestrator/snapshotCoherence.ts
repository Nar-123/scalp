/**
 * Timestamp coherence and freshness of one market observation (Phase 5.6). These bounds are DATA-QUALITY limits,
 * not strategy parameters: they only decide whether an observation is trustworthy enough to act on. A violation
 * fails closed (no entry); nothing here touches any V1 threshold.
 */

/** Largest tolerated gap between the parts of one observation (tick start, market data, quote), in ms. */
export const MAX_SNAPSHOT_SKEW_MS = 10_000;
/** Oldest a market observation may be when the entry decision is finally taken, in ms. */
export const MAX_MARKET_DATA_AGE_AT_DECISION_MS = 10_000;

export interface SnapshotTimes {
  /** Start of the evaluation tick. */
  observedAtMs: number;
  /** When the price/liquidity/volume fetch completed. null = unknown (=> incoherent). */
  marketDataTimeMs: number | null;
  /** When the read-only quote completed; null when no quote was used. */
  quoteTimeMs: number | null;
}

/** Reasons the parts of one observation cannot be treated as a single moment. Empty = coherent. */
export function snapshotCoherenceIssues(t: SnapshotTimes, maxSkewMs: number = MAX_SNAPSHOT_SKEW_MS): string[] {
  const issues: string[] = [];
  if (t.marketDataTimeMs === null || !Number.isFinite(t.marketDataTimeMs)) {
    issues.push('market_data_timestamp_missing');
    return issues;
  }
  if (t.marketDataTimeMs < t.observedAtMs) issues.push('market_data_before_tick_start'); // a clock going backwards / a mislabelled snapshot
  if (t.marketDataTimeMs - t.observedAtMs > maxSkewMs) issues.push('market_data_too_slow_for_tick');
  if (t.quoteTimeMs !== null && Math.abs(t.quoteTimeMs - t.marketDataTimeMs) > maxSkewMs) issues.push('quote_and_market_data_skewed');
  return issues;
}

/** true when the observation is too old to act on at `decisionAtMs` (e.g. slow safety RPCs sat between fetch and decision). */
export function isStaleAtDecision(marketDataTimeMs: number | null, decisionAtMs: number, maxAgeMs: number = MAX_MARKET_DATA_AGE_AT_DECISION_MS): boolean {
  if (marketDataTimeMs === null || !Number.isFinite(marketDataTimeMs)) return true;
  return decisionAtMs - marketDataTimeMs > maxAgeMs;
}
