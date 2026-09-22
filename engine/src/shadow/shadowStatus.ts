import type { ShadowLedger } from './shadowLedger.js';

/**
 * Health counters (RPC / aggregator / market data / quote outcomes, shadow
 * tick counts). Fed by the live loop and the runner; persisted through an
 * optional sink so the separate status CLI process can read what the engine
 * process counted. If nothing has been recorded, rates are `null` ("no data
 * yet") -- never a guessed 100%. Counters are observations only and never
 * influence a trading decision.
 */
export class HealthCounters {
  private readonly counts = new Map<string, number>();

  /**
   * @param sink called on every increment (the live engine passes
   *   `(n, by) => ledger.incrementCounter(n, by)`)
   * @param initial hydrates from persisted counters (status CLI)
   */
  constructor(
    private readonly sink?: (name: string, by: number) => void,
    initial: Record<string, number> = {},
  ) {
    for (const [k, v] of Object.entries(initial)) this.counts.set(k, v);
  }

  increment(name: string, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
    try {
      this.sink?.(name, by);
    } catch {
      // health accounting must never break the pipeline it observes
    }
  }

  recordRpcResult(success: boolean): void {
    this.increment(success ? 'rpc_success' : 'rpc_error');
  }

  recordAggregatorResult(success: boolean): void {
    this.increment(success ? 'aggregator_success' : 'aggregator_error');
  }

  recordMarketDataResult(success: boolean): void {
    this.increment(success ? 'market_data_success' : 'market_data_error');
  }

  recordQuoteResult(success: boolean): void {
    this.increment(success ? 'quote_success' : 'quote_error');
  }

  private get(name: string): number {
    return this.counts.get(name) ?? 0;
  }

  private static rate(successes: number, failures: number): number | null {
    const total = successes + failures;
    return total === 0 ? null : successes / total;
  }

  snapshot(): HealthSnapshot {
    const pair = (p: string) => ({ ok: this.get(`${p}_success`), err: this.get(`${p}_error`) });
    const rpc = pair('rpc');
    const quote = pair('quote');
    const agg = pair('aggregator');
    const md = pair('market_data');
    return {
      rpcSuccessRate: HealthCounters.rate(rpc.ok, rpc.err),
      rpcTotal: rpc.ok + rpc.err,
      quoteSuccessRate: HealthCounters.rate(quote.ok, quote.err),
      quoteTotal: quote.ok + quote.err,
      aggregatorSuccessRate: HealthCounters.rate(agg.ok, agg.err),
      aggregatorTotal: agg.ok + agg.err,
      marketDataSuccessRate: HealthCounters.rate(md.ok, md.err),
      marketDataTotal: md.ok + md.err,
      counters: Object.fromEntries(this.counts),
    };
  }
}

export interface HealthSnapshot {
  rpcSuccessRate: number | null;
  rpcTotal: number;
  quoteSuccessRate: number | null;
  quoteTotal: number;
  aggregatorSuccessRate: number | null;
  aggregatorTotal: number;
  marketDataSuccessRate: number | null;
  marketDataTotal: number;
  counters: Record<string, number>;
}

export interface StrategyShadowStatus {
  strategyVersion: string;
  openPositions: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlSol: number;
  avgPnlSol: number | null;
  maxDrawdownSol: number;
  missedSignalCount: number;
  missedSignalsByReason: Record<string, number>;
  dailySimulatedLossSol: number;
  dailyCircuitBreakerTriggered: boolean;
}

export interface ShadowStatusReport {
  generatedAtMs: number;
  strategies: StrategyShadowStatus[];
  dataQualityEventCounts: Record<string, number>;
  dataQualityBySeverity: Record<string, number>;
  latency: {
    sampleCount: number;
    /** all OBSERVED SYSTEM LATENCY -- never the assumed fill-simulator latency */
    avgDiscoveryLatencyMs: number | null;
    avgMarketDataLatencyMs: number | null;
    avgQuoteLatencyMs: number | null;
    avgSignalLatencyMs: number | null;
    avgProcessingLatencyMs: number | null;
    avgShadowProcessingLatencyMs: number | null;
  };
  health: HealthSnapshot;
}

function nonNull(values: Array<number | null>): number[] {
  return values.filter((v): v is number => v !== null);
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function computeMaxDrawdown(pnlInOrder: number[]): number {
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  for (const pnl of pnlInOrder) {
    cumulative += pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

/** Builds the read-only monitoring report, computed fresh from ShadowLedger every call. */
export function buildShadowStatusReport(
  ledger: ShadowLedger,
  strategyVersions: string[],
  utcDateString: (ms: number) => string,
  nowMs: number,
  health: HealthCounters,
  latencyWindowMs = 60 * 60 * 1000,
  missedSignalWindowMs = 24 * 60 * 60 * 1000,
): ShadowStatusReport {
  const strategies: StrategyShadowStatus[] = strategyVersions.map((strategyVersion) => {
    const closed = ledger.getAllClosedTrades(strategyVersion);
    const pnlValues = closed.map((t) => t.pnlSol ?? 0);
    const wins = pnlValues.filter((p) => p > 0).length;
    const losses = pnlValues.filter((p) => p <= 0).length;
    const openPositions = ledger.getOpenPositions(strategyVersion).length;

    const dateIsoUtc = utcDateString(nowMs);
    const dailyState = ledger.getOrInitDailyRiskState(strategyVersion, dateIsoUtc, 0);

    const missed = ledger.getRecentMissedSignals(strategyVersion, nowMs - missedSignalWindowMs);
    const missedByReason: Record<string, number> = {};
    for (const m of missed) {
      missedByReason[m.reason] = (missedByReason[m.reason] ?? 0) + 1;
    }

    return {
      strategyVersion,
      openPositions,
      closedTrades: closed.length,
      wins,
      losses,
      winRate: closed.length ? wins / closed.length : null,
      netPnlSol: pnlValues.reduce((a, b) => a + b, 0),
      avgPnlSol: average(pnlValues),
      maxDrawdownSol: computeMaxDrawdown(pnlValues),
      missedSignalCount: missed.length,
      missedSignalsByReason: missedByReason,
      dailySimulatedLossSol: Math.min(0, dailyState.realizedPnlSol),
      dailyCircuitBreakerTriggered: dailyState.circuitBreakerTriggered,
    };
  });

  const dqEvents = ledger.getRecentDataQualityEvents(nowMs - missedSignalWindowMs);
  const dataQualityEventCounts: Record<string, number> = {};
  const dataQualityBySeverity: Record<string, number> = {};
  for (const event of dqEvents) {
    dataQualityEventCounts[event.kind] = (dataQualityEventCounts[event.kind] ?? 0) + 1;
    dataQualityBySeverity[event.severity] = (dataQualityBySeverity[event.severity] ?? 0) + 1;
  }

  const latencySamples = ledger.getRecentLatencySamples(nowMs - latencyWindowMs);

  return {
    generatedAtMs: nowMs,
    strategies,
    dataQualityEventCounts,
    dataQualityBySeverity,
    latency: {
      sampleCount: latencySamples.length,
      avgDiscoveryLatencyMs: average(nonNull(latencySamples.map((s) => s.discoveryLatencyMs))),
      avgMarketDataLatencyMs: average(nonNull(latencySamples.map((s) => s.marketDataLatencyMs ?? null))),
      avgQuoteLatencyMs: average(nonNull(latencySamples.map((s) => s.quoteLatencyMs))),
      avgSignalLatencyMs: average(latencySamples.map((s) => s.signalLatencyMs)),
      avgProcessingLatencyMs: average(latencySamples.map((s) => s.processingLatencyMs)),
      avgShadowProcessingLatencyMs: average(nonNull(latencySamples.map((s) => s.shadowProcessingLatencyMs ?? null))),
    },
    health: health.snapshot(),
  };
}
