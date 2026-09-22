import type { DatabaseSync } from 'node:sqlite';
import type { OpenPositionSummary } from '../risk/types.js';
import type { TokenTradeHistory } from '../types/trade.js';
import type {
  DataQualityEventRecord,
  LatencySampleRecord,
  MissedSignalRecord,
  QuoteObservation,
  ShadowTradeRecord,
} from './types.js';

function toJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function fromJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

interface ShadowTradeRow {
  trade_id: string;
  mint: string;
  entry_size_sol: number;
}

interface ShadowDailyRiskRow {
  starting_balance_sol: number;
  realized_pnl_sol: number;
  circuit_breaker_triggered: number;
  circuit_breaker_triggered_at_ms: number | null;
}

/**
 * The shadow twin of ledger/tradeLedger.ts::TradeLedger -- same method
 * shapes (getOpenPositions, getOrInitDailyRiskState, applyRealizedPnl,
 * latchCircuitBreaker, getTokenTradeHistory, recordEntry, recordExit) so
 * shadowRunner.ts can drive risk/exit evaluation exactly the way the live
 * orchestrator does, just against shadow_* tables instead of
 * trades/daily_risk_state. EVERY method is scoped by strategy_version,
 * because (unlike production, which only ever runs one strategy at a
 * time) multiple shadow strategies share these tables concurrently and
 * must never see each other's open positions, daily risk, or trade
 * history (task 17: candidate/shadow isolation).
 */
export class ShadowLedger {
  constructor(private readonly db: DatabaseSync) {}

  recordEntry(trade: ShadowTradeRecord): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO shadow_trades (
          trade_id, strategy_version, execution_mode, simulator_version, mint, reentry_index,
          entry_time_ms, entry_price_sol, entry_size_sol, entry_filled_amount_sol, entry_fees_sol,
          entry_score, expected_net_edge_pct, entry_liquidity_sol, entry_quote_json,
          entry_token_amount_raw, entry_context_json, status, created_at_ms, updated_at_ms
        ) VALUES (
          @tradeId, @strategyVersion, @executionMode, @simulatorVersion, @mint, @reentryIndex,
          @entryTimeMs, @entryPriceSol, @entrySizeSol, @entryFilledAmountSol, @entryFeesSol,
          @entryScore, @expectedNetEdgePct, @entryLiquiditySol, @entryQuoteJson,
          @entryTokenAmountRaw, @entryContextJson, 'open', @createdAtMs, @updatedAtMs
        )`,
      )
      .run({
        tradeId: trade.tradeId,
        strategyVersion: trade.strategyVersion,
        executionMode: trade.executionMode,
        simulatorVersion: trade.simulatorVersion,
        mint: trade.mint,
        reentryIndex: trade.reentryIndex,
        entryTimeMs: trade.entryTimeMs,
        entryPriceSol: trade.entryPriceSol,
        entrySizeSol: trade.entrySizeSol,
        entryFilledAmountSol: trade.entryFilledAmountSol,
        entryFeesSol: trade.entryFeesSol,
        entryScore: trade.entryScore,
        expectedNetEdgePct: trade.expectedNetEdgePct,
        entryLiquiditySol: trade.entryLiquiditySol,
        entryQuoteJson: toJson(trade.entryQuote),
        entryTokenAmountRaw: trade.entryTokenAmountRaw ?? null,
        entryContextJson: toJson(trade.entryContext ?? null),
        createdAtMs: now,
        updatedAtMs: now,
      });
  }

  recordExit(
    tradeId: string,
    exit: {
      exitTimeMs: number;
      exitPriceSol: number;
      exitReason: NonNullable<ShadowTradeRecord['exitReason']>;
      exitFeesSol: number;
      pnlSol: number;
      pnlPct: number;
      holdDurationMs: number;
      maxFavorableExcursionPct: number;
      maxAdverseExcursionPct: number;
      exitContext?: Record<string, unknown> | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE shadow_trades SET
          exit_time_ms = @exitTimeMs, exit_price_sol = @exitPriceSol, exit_reason = @exitReason,
          exit_fees_sol = @exitFeesSol, pnl_sol = @pnlSol, pnl_pct = @pnlPct,
          hold_duration_ms = @holdDurationMs, max_favorable_excursion_pct = @maxFavorableExcursionPct,
          max_adverse_excursion_pct = @maxAdverseExcursionPct, exit_context_json = @exitContextJson, status = 'closed', updated_at_ms = @updatedAtMs
        WHERE trade_id = @tradeId`,
      )
      .run({ tradeId, updatedAtMs: Date.now(), ...withoutContext(exit), exitContextJson: toJson(exit.exitContext ?? null) });
  }

  getOpenPositions(strategyVersion: string): OpenPositionSummary[] {
    const rows = this.db
      .prepare(`SELECT trade_id, mint, entry_size_sol FROM shadow_trades WHERE strategy_version = ? AND status = 'open'`)
      .all(strategyVersion) as unknown as ShadowTradeRow[];
    return rows.map((row) => ({ tradeId: row.trade_id, mint: row.mint, entrySizeSol: row.entry_size_sol }));
  }

  getOpenPosition(strategyVersion: string, mint: string): ShadowTradeRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM shadow_trades WHERE strategy_version = ? AND mint = ? AND status = 'open'`)
      .get(strategyVersion, mint) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    return hydrateShadowTradeRow(row);
  }

  getOrInitDailyRiskState(
    strategyVersion: string,
    dateIsoUtc: string,
    startingBalanceSol: number,
  ): { startingBalanceSol: number; realizedPnlSol: number; circuitBreakerTriggered: boolean } {
    const existing = this.db
      .prepare(`SELECT * FROM shadow_daily_risk_state WHERE strategy_version = ? AND trading_date_utc = ?`)
      .get(strategyVersion, dateIsoUtc) as unknown as ShadowDailyRiskRow | undefined;
    if (existing) {
      return {
        startingBalanceSol: existing.starting_balance_sol,
        realizedPnlSol: existing.realized_pnl_sol,
        circuitBreakerTriggered: existing.circuit_breaker_triggered === 1,
      };
    }
    this.db
      .prepare(
        `INSERT INTO shadow_daily_risk_state (strategy_version, trading_date_utc, starting_balance_sol, realized_pnl_sol, circuit_breaker_triggered)
         VALUES (?, ?, ?, 0, 0)`,
      )
      .run(strategyVersion, dateIsoUtc, startingBalanceSol);
    return { startingBalanceSol, realizedPnlSol: 0, circuitBreakerTriggered: false };
  }

  applyRealizedPnl(strategyVersion: string, dateIsoUtc: string, pnlSol: number): void {
    this.db
      .prepare(
        `UPDATE shadow_daily_risk_state SET realized_pnl_sol = realized_pnl_sol + ?
         WHERE strategy_version = ? AND trading_date_utc = ?`,
      )
      .run(pnlSol, strategyVersion, dateIsoUtc);
  }

  latchCircuitBreaker(strategyVersion: string, dateIsoUtc: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE shadow_daily_risk_state
         SET circuit_breaker_triggered = 1, circuit_breaker_triggered_at_ms = COALESCE(circuit_breaker_triggered_at_ms, ?)
         WHERE strategy_version = ? AND trading_date_utc = ?`,
      )
      .run(nowMs, strategyVersion, dateIsoUtc);
  }

  getTokenTradeHistory(strategyVersion: string, mint: string): TokenTradeHistory {
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) as total_trades, SUM(COALESCE(pnl_sol, 0)) as cumulative_pnl_sol
         FROM shadow_trades WHERE strategy_version = ? AND mint = ?`,
      )
      .get(strategyVersion, mint) as unknown as { total_trades: number; cumulative_pnl_sol: number | null };

    const lastClosed = this.db
      .prepare(
        `SELECT exit_time_ms, pnl_sol FROM shadow_trades WHERE strategy_version = ? AND mint = ? AND status = 'closed'
         ORDER BY exit_time_ms DESC LIMIT 1`,
      )
      .get(strategyVersion, mint) as unknown as { exit_time_ms: number | null; pnl_sol: number | null } | undefined;

    const recentClosed = this.db
      .prepare(
        `SELECT pnl_sol FROM shadow_trades WHERE strategy_version = ? AND mint = ? AND status = 'closed'
         ORDER BY exit_time_ms DESC LIMIT 20`,
      )
      .all(strategyVersion, mint) as unknown as { pnl_sol: number | null }[];

    let consecutiveLosses = 0;
    for (const row of recentClosed) {
      if (row.pnl_sol !== null && row.pnl_sol < 0) consecutiveLosses += 1;
      else break;
    }

    return {
      mint,
      totalTrades: summary.total_trades ?? 0,
      lastTradeExitTimeMs: lastClosed?.exit_time_ms ?? null,
      lastTradeWasLoss: lastClosed?.pnl_sol !== undefined && lastClosed?.pnl_sol !== null ? lastClosed.pnl_sol < 0 : null,
      consecutiveLosses,
      cumulativePnlSol: summary.cumulative_pnl_sol ?? 0,
    };
  }

  recordMissedSignal(id: string, signal: MissedSignalRecord): void {
    this.db
      .prepare(
        `INSERT INTO shadow_missed_signals (id, strategy_version, mint, observed_at_ms, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, signal.strategyVersion, signal.mint, signal.observedAtMs, signal.reason, signal.detail);
  }

  recordDataQualityEvent(id: string, event: DataQualityEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO shadow_data_quality_events (id, strategy_version, mint, observed_at_ms, kind, severity, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, event.strategyVersion, event.mint, event.observedAtMs, event.kind, event.severity, event.detail);
  }

  recordLatencySample(id: string, sample: LatencySampleRecord): void {
    this.db
      .prepare(
        `INSERT INTO shadow_latency_samples (
          id, mint, observed_at_ms, discovery_time_ms, signal_time_ms, quote_time_ms, simulation_time_ms,
          exit_signal_time_ms, discovery_latency_ms, signal_latency_ms, quote_latency_ms, processing_latency_ms,
          detected_at_ms, market_data_time_ms, market_data_latency_ms, shadow_processing_latency_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sample.mint,
        sample.observedAtMs,
        sample.discoveryTimeMs,
        sample.signalTimeMs,
        sample.quoteTimeMs,
        sample.simulationTimeMs,
        sample.exitSignalTimeMs,
        sample.discoveryLatencyMs,
        sample.signalLatencyMs,
        sample.quoteLatencyMs,
        sample.processingLatencyMs,
        sample.detectedAtMs ?? null,
        sample.marketDataTimeMs ?? null,
        sample.marketDataLatencyMs ?? null,
        sample.shadowProcessingLatencyMs ?? null,
      );
  }

  /** Persisted health/tick counters (upsert-increment) so the status CLI can read what the engine process counted. */
  incrementCounter(name: string, by = 1): void {
    this.db
      .prepare(
        `INSERT INTO shadow_health_counters (name, value, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + excluded.value, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(name, by, Date.now());
  }

  getCounters(): Record<string, number> {
    const rows = this.db.prepare(`SELECT name, value FROM shadow_health_counters`).all() as unknown as Array<{ name: string; value: number }>;
    return Object.fromEntries(rows.map((r) => [r.name, r.value]));
  }

  getRecentDataQualityEvents(sinceMs: number): DataQualityEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM shadow_data_quality_events WHERE observed_at_ms >= ? ORDER BY observed_at_ms DESC`)
      .all(sinceMs) as unknown as Array<{ strategy_version: string | null; mint: string; observed_at_ms: number; kind: string; severity: string | null; detail: string | null }>;
    return rows.map((row) => ({
      mint: row.mint,
      strategyVersion: row.strategy_version,
      observedAtMs: row.observed_at_ms,
      kind: row.kind as DataQualityEventRecord['kind'],
      severity: (row.severity ?? 'warning') as DataQualityEventRecord['severity'],
      detail: row.detail ?? '',
    }));
  }

  getRecentMissedSignals(strategyVersion: string, sinceMs: number): MissedSignalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM shadow_missed_signals WHERE strategy_version = ? AND observed_at_ms >= ? ORDER BY observed_at_ms DESC`,
      )
      .all(strategyVersion, sinceMs) as unknown as Array<{ mint: string; observed_at_ms: number; reason: string; detail: string | null }>;
    return rows.map((row) => ({
      mint: row.mint,
      strategyVersion,
      observedAtMs: row.observed_at_ms,
      reason: row.reason as MissedSignalRecord['reason'],
      detail: row.detail ?? '',
    }));
  }

  getRecentLatencySamples(sinceMs: number): LatencySampleRecord[] {
    interface LatencyRow {
      mint: string;
      observed_at_ms: number;
      discovery_time_ms: number;
      signal_time_ms: number;
      quote_time_ms: number | null;
      simulation_time_ms: number;
      exit_signal_time_ms: number | null;
      discovery_latency_ms: number | null;
      signal_latency_ms: number;
      quote_latency_ms: number | null;
      processing_latency_ms: number;
      detected_at_ms: number | null;
      market_data_time_ms: number | null;
      market_data_latency_ms: number | null;
      shadow_processing_latency_ms: number | null;
    }
    const rows = this.db
      .prepare(`SELECT * FROM shadow_latency_samples WHERE observed_at_ms >= ? ORDER BY observed_at_ms DESC`)
      .all(sinceMs) as unknown as LatencyRow[];
    return rows.map((row) => ({
      mint: row.mint,
      observedAtMs: row.observed_at_ms,
      discoveryTimeMs: row.discovery_time_ms,
      signalTimeMs: row.signal_time_ms,
      quoteTimeMs: row.quote_time_ms ?? null,
      simulationTimeMs: row.simulation_time_ms,
      exitSignalTimeMs: row.exit_signal_time_ms ?? null,
      detectedAtMs: row.detected_at_ms ?? null,
      marketDataTimeMs: row.market_data_time_ms ?? null,
      discoveryLatencyMs: row.discovery_latency_ms ?? null,
      marketDataLatencyMs: row.market_data_latency_ms ?? null,
      signalLatencyMs: row.signal_latency_ms,
      quoteLatencyMs: row.quote_latency_ms ?? null,
      processingLatencyMs: row.processing_latency_ms,
      shadowProcessingLatencyMs: row.shadow_processing_latency_ms ?? null,
    }));
  }

  getAllClosedTrades(strategyVersion: string): ShadowTradeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM shadow_trades WHERE strategy_version = ? AND status = 'closed' ORDER BY entry_time_ms ASC`)
      .all(strategyVersion) as unknown as Array<Record<string, unknown>>;
    return rows.map(hydrateShadowTradeRow);
  }
}

function hydrateShadowTradeRow(row: Record<string, unknown>): ShadowTradeRecord {
  return {
    tradeId: row.trade_id as string,
    strategyVersion: row.strategy_version as string,
    executionMode: 'shadow',
    simulatorVersion: row.simulator_version as string,
    mint: row.mint as string,
    reentryIndex: row.reentry_index as number,
    entryTimeMs: row.entry_time_ms as number,
    entryPriceSol: row.entry_price_sol as number,
    entrySizeSol: row.entry_size_sol as number,
    entryFilledAmountSol: row.entry_filled_amount_sol as number,
    entryFeesSol: row.entry_fees_sol as number,
    entryScore: row.entry_score as number,
    expectedNetEdgePct: row.expected_net_edge_pct as number,
    entryLiquiditySol: (row.entry_liquidity_sol as number | null) ?? null,
    entryQuote: fromJson<QuoteObservation>(row.entry_quote_json as string | null),
    entryTokenAmountRaw: (row.entry_token_amount_raw as string | null) ?? null,
    entryContext: fromJson<Record<string, unknown>>(row.entry_context_json as string | null),
    exitContext: fromJson<Record<string, unknown>>(row.exit_context_json as string | null),
    exitTimeMs: (row.exit_time_ms as number | null) ?? null,
    exitPriceSol: (row.exit_price_sol as number | null) ?? null,
    exitReason: (row.exit_reason as ShadowTradeRecord['exitReason']) ?? null,
    exitFeesSol: (row.exit_fees_sol as number | null) ?? null,
    status: row.status as ShadowTradeRecord['status'],
    pnlSol: (row.pnl_sol as number | null) ?? null,
    pnlPct: (row.pnl_pct as number | null) ?? null,
    holdDurationMs: (row.hold_duration_ms as number | null) ?? null,
    maxFavorableExcursionPct: (row.max_favorable_excursion_pct as number | null) ?? null,
    maxAdverseExcursionPct: (row.max_adverse_excursion_pct as number | null) ?? null,
  };
}

function withoutContext<T extends { exitContext?: unknown }>(exit: T): Omit<T, 'exitContext'> {
  const { exitContext: _ignored, ...rest } = exit;
  void _ignored;
  return rest;
}
