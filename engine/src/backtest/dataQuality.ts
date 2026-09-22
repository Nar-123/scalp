import type { DataQualityIssue, HistoricalMarketSnapshot } from './types.js';

/**
 * Detects (never silently discards -- spec section 26) data-quality
 * problems in a historical snapshot sequence for ONE mint, already sorted
 * as the caller intends to replay it. The replay engine calls this before
 * replaying and surfaces every issue in the final BacktestResult; it does
 * not decide on the caller's behalf whether to proceed.
 */
export function detectDataQualityIssues(mint: string, snapshots: HistoricalMarketSnapshot[]): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const seenAt = new Set<number>();
  let previousObservedAtMs: number | null = null;

  for (const snap of snapshots) {
    if (snap.observedAtMs === undefined || snap.observedAtMs === null || !Number.isFinite(snap.observedAtMs)) {
      issues.push({ mint, kind: 'missing_timestamp', detail: 'observedAtMs is missing or not finite', observedAtMs: null });
      continue;
    }

    if (seenAt.has(snap.observedAtMs)) {
      issues.push({
        mint,
        kind: 'duplicate_record',
        detail: `duplicate observedAtMs=${snap.observedAtMs}`,
        observedAtMs: snap.observedAtMs,
      });
    }
    seenAt.add(snap.observedAtMs);

    if (previousObservedAtMs !== null && snap.observedAtMs < previousObservedAtMs) {
      issues.push({
        mint,
        kind: 'non_chronological_order',
        detail: `observedAtMs=${snap.observedAtMs} precedes a previous record at ${previousObservedAtMs}`,
        observedAtMs: snap.observedAtMs,
      });
    }
    previousObservedAtMs = snap.observedAtMs;

    if (snap.priceSol !== null && (!Number.isFinite(snap.priceSol) || snap.priceSol <= 0)) {
      issues.push({ mint, kind: 'impossible_price', detail: `priceSol=${snap.priceSol}`, observedAtMs: snap.observedAtMs });
    }

    if (snap.liquiditySol !== null && (!Number.isFinite(snap.liquiditySol) || snap.liquiditySol < 0)) {
      issues.push({ mint, kind: 'negative_liquidity', detail: `liquiditySol=${snap.liquiditySol}`, observedAtMs: snap.observedAtMs });
    }

    if (snap.volume1mSol !== null && (!Number.isFinite(snap.volume1mSol) || snap.volume1mSol < 0)) {
      issues.push({ mint, kind: 'negative_volume', detail: `volume1mSol=${snap.volume1mSol}`, observedAtMs: snap.observedAtMs });
    }

    const ageSec = (snap.observedAtMs - snap.discoveredAtMs) / 1000;
    if (!Number.isFinite(ageSec) || ageSec < 0) {
      issues.push({
        mint,
        kind: 'impossible_token_age',
        detail: `computed age ${ageSec}s (observedAtMs=${snap.observedAtMs}, discoveredAtMs=${snap.discoveredAtMs})`,
        observedAtMs: snap.observedAtMs,
      });
    }

    if (snap.mint !== mint) {
      issues.push({ mint, kind: 'missing_required_feature', detail: `snapshot.mint (${snap.mint}) does not match the expected mint`, observedAtMs: snap.observedAtMs });
    }
  }

  return issues;
}

export function detectDataQualityIssuesAcrossMints(byMint: Map<string, HistoricalMarketSnapshot[]>): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  for (const [mint, snapshots] of byMint) {
    issues.push(...detectDataQualityIssues(mint, snapshots));
  }
  return issues;
}
