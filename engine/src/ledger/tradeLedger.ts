import type { DatabaseSync } from 'node:sqlite';
import type { OpenPositionSummary } from '../risk/types.js';
import type {
  TokenEvaluationRecord,
  TokenTradeHistory,
  TradeEntryRecord,
  TradeExitRecord,
} from '../types/trade.js';
import { utcDateString } from '../utils/time.js';

function toIntBool(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function toJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

interface TradeRow {
  id: string;
  mint: string;
  entry_size_sol: number;
}

interface DailyRiskRow {
  trading_date_utc: string;
  starting_balance_sol: number;
  realized_pnl_sol: number;
  circuit_breaker_triggered: number;
  circuit_breaker_triggered_at_ms: number | null;
}

export class TradeLedger {
  constructor(private readonly db: DatabaseSync) {}

  recordEvaluation(evaluation: TokenEvaluationRecord): string {
    this.db
      .prepare(
        `INSERT INTO token_evaluations (
          id, mint, pool_address, discovery_source, discovered_at_ms, evaluated_at_ms, token_age_sec,
          safety_passed, safety_reasons, mint_authority_renounced, freeze_authority_renounced, top10_holder_pct,
          liquidity_sol, volume_1m_sol, buy_sell_ratio, price_velocity_5s_pct, volume_acceleration_x,
          estimated_price_impact_pct, entry_score, entry_score_components, expected_net_edge_pct,
          expected_net_edge_breakdown, risk_allowed, risk_reject_reasons, led_to_trade_id, strategy_version
        ) VALUES (
          @id, @mint, @poolAddress, @discoverySource, @discoveredAtMs, @evaluatedAtMs, @tokenAgeSec,
          @safetyPassed, @safetyReasons, @mintAuthorityRenounced, @freezeAuthorityRenounced, @top10HolderPct,
          @liquiditySol, @volume1mSol, @buySellRatio, @priceVelocity5sPct, @volumeAccelerationX,
          @estimatedPriceImpactPct, @entryScore, @entryScoreComponents, @expectedNetEdgePct,
          @expectedNetEdgeBreakdown, @riskAllowed, @riskRejectReasons, @ledToTradeId, @strategyVersion
        )`,
      )
      .run({
        id: evaluation.id,
        mint: evaluation.mint,
        poolAddress: evaluation.poolAddress,
        discoverySource: evaluation.discoverySource,
        discoveredAtMs: evaluation.discoveredAtMs,
        evaluatedAtMs: evaluation.evaluatedAtMs,
        tokenAgeSec: evaluation.tokenAgeSec,
        safetyPassed: toIntBool(evaluation.safetyPassed),
        safetyReasons: toJson(evaluation.safetyReasons),
        mintAuthorityRenounced: toIntBool(evaluation.mintAuthorityRenounced),
        freezeAuthorityRenounced: toIntBool(evaluation.freezeAuthorityRenounced),
        top10HolderPct: evaluation.top10HolderPct,
        liquiditySol: evaluation.liquiditySol,
        volume1mSol: evaluation.volume1mSol,
        buySellRatio: evaluation.buySellRatio,
        priceVelocity5sPct: evaluation.priceVelocity5sPct,
        volumeAccelerationX: evaluation.volumeAccelerationX,
        estimatedPriceImpactPct: evaluation.estimatedPriceImpactPct,
        entryScore: evaluation.entryScore,
        entryScoreComponents: toJson(evaluation.entryScoreComponents),
        expectedNetEdgePct: evaluation.expectedNetEdgePct,
        expectedNetEdgeBreakdown: toJson(evaluation.expectedNetEdgeBreakdown),
        riskAllowed: toIntBool(evaluation.riskAllowed),
        riskRejectReasons: toJson(evaluation.riskRejectReasons),
        ledToTradeId: evaluation.ledToTradeId,
        strategyVersion: evaluation.strategyVersion,
      });
    return evaluation.id;
  }

  linkEvaluationToTrade(evaluationId: string, tradeId: string): void {
    this.db.prepare(`UPDATE token_evaluations SET led_to_trade_id = ? WHERE id = ?`).run(tradeId, evaluationId);
  }

  recordEntry(entry: TradeEntryRecord): string {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO trades (
          id, mint, pool_address, strategy_version, dry_run, reentry_index,
          entry_time_ms, entry_price_sol, entry_size_sol, entry_token_age_sec, entry_liquidity_sol,
          entry_volume_1m_sol, entry_buy_sell_ratio, entry_price_velocity_5s_pct, entry_volume_acceleration_x,
          entry_score, entry_score_components, expected_net_edge_pct, expected_net_edge_breakdown,
          entry_slippage_pct, entry_price_impact_pct, entry_fees_sol, entry_tx_signature, entry_safety_check_id,
          daily_realized_pnl_sol_at_entry, status, created_at_ms, updated_at_ms
        ) VALUES (
          @id, @mint, @poolAddress, @strategyVersion, @dryRun, @reentryIndex,
          @entryTimeMs, @entryPriceSol, @entrySizeSol, @entryTokenAgeSec, @entryLiquiditySol,
          @entryVolume1mSol, @entryBuySellRatio, @entryPriceVelocity5sPct, @entryVolumeAccelerationX,
          @entryScore, @entryScoreComponents, @expectedNetEdgePct, @expectedNetEdgeBreakdown,
          @entrySlippagePct, @entryPriceImpactPct, @entryFeesSol, @entryTxSignature, @entrySafetyCheckId,
          @dailyRealizedPnlSolAtEntry, 'open', @createdAtMs, @updatedAtMs
        )`,
      )
      .run({
        id: entry.id,
        mint: entry.mint,
        poolAddress: entry.poolAddress,
        strategyVersion: entry.strategyVersion,
        dryRun: toIntBool(entry.dryRun),
        reentryIndex: entry.reentryIndex,
        entryTimeMs: entry.entryTimeMs,
        entryPriceSol: entry.entryPriceSol,
        entrySizeSol: entry.entrySizeSol,
        entryTokenAgeSec: entry.entryTokenAgeSec,
        entryLiquiditySol: entry.entryLiquiditySol,
        entryVolume1mSol: entry.entryVolume1mSol,
        entryBuySellRatio: entry.entryBuySellRatio,
        entryPriceVelocity5sPct: entry.entryPriceVelocity5sPct,
        entryVolumeAccelerationX: entry.entryVolumeAccelerationX,
        entryScore: entry.entryScore,
        entryScoreComponents: toJson(entry.entryScoreComponents),
        expectedNetEdgePct: entry.expectedNetEdgePct,
        expectedNetEdgeBreakdown: toJson(entry.expectedNetEdgeBreakdown),
        entrySlippagePct: entry.entrySlippagePct,
        entryPriceImpactPct: entry.entryPriceImpactPct,
        entryFeesSol: entry.entryFeesSol,
        entryTxSignature: entry.entryTxSignature,
        entrySafetyCheckId: entry.entrySafetyCheckId,
        dailyRealizedPnlSolAtEntry: entry.dailyRealizedPnlSolAtEntry,
        createdAtMs: now,
        updatedAtMs: now,
      });
    if (entry.entrySafetyCheckId) {
      this.linkEvaluationToTrade(entry.entrySafetyCheckId, entry.id);
    }
    return entry.id;
  }

  recordExit(tradeId: string, exit: TradeExitRecord): void {
    this.db
      .prepare(
        `UPDATE trades SET
          exit_time_ms = @exitTimeMs, exit_price_sol = @exitPriceSol, exit_reason = @exitReason,
          exit_fees_sol = @exitFeesSol, exit_tx_signature = @exitTxSignature, exit_slippage_pct = @exitSlippagePct,
          hold_duration_ms = @holdDurationMs, pnl_sol = @pnlSol, pnl_pct = @pnlPct,
          max_favorable_excursion_pct = @maxFavorableExcursionPct, max_adverse_excursion_pct = @maxAdverseExcursionPct,
          daily_realized_pnl_sol_at_exit = @dailyRealizedPnlSolAtExit,
          status = 'closed', updated_at_ms = @updatedAtMs
        WHERE id = @tradeId`,
      )
      .run({
        tradeId,
        exitTimeMs: exit.exitTimeMs,
        exitPriceSol: exit.exitPriceSol,
        exitReason: exit.exitReason,
        exitFeesSol: exit.exitFeesSol,
        exitTxSignature: exit.exitTxSignature,
        exitSlippagePct: exit.exitSlippagePct,
        holdDurationMs: exit.holdDurationMs,
        pnlSol: exit.pnlSol,
        pnlPct: exit.pnlPct,
        maxFavorableExcursionPct: exit.maxFavorableExcursionPct,
        maxAdverseExcursionPct: exit.maxAdverseExcursionPct,
        dailyRealizedPnlSolAtExit: exit.dailyRealizedPnlSolAtExit,
        updatedAtMs: Date.now(),
      });
  }

  getOpenPositions(): OpenPositionSummary[] {
    const rows = this.db
      .prepare(`SELECT id, mint, entry_size_sol FROM trades WHERE status = 'open'`)
      .all() as unknown as TradeRow[];
    return rows.map((row) => ({ tradeId: row.id, mint: row.mint, entrySizeSol: row.entry_size_sol }));
  }

  getDailyRealizedPnl(dateIsoUtc: string): number {
    const row = this.db
      .prepare(`SELECT realized_pnl_sol FROM daily_risk_state WHERE trading_date_utc = ?`)
      .get(dateIsoUtc) as unknown as { realized_pnl_sol: number } | undefined;
    return row?.realized_pnl_sol ?? 0;
  }

  getOrInitDailyRiskState(dateIsoUtc: string, startingBalanceSol: number): {
    startingBalanceSol: number;
    realizedPnlSol: number;
    circuitBreakerTriggered: boolean;
  } {
    const existing = this.db
      .prepare(`SELECT * FROM daily_risk_state WHERE trading_date_utc = ?`)
      .get(dateIsoUtc) as unknown as DailyRiskRow | undefined;
    if (existing) {
      return {
        startingBalanceSol: existing.starting_balance_sol,
        realizedPnlSol: existing.realized_pnl_sol,
        circuitBreakerTriggered: existing.circuit_breaker_triggered === 1,
      };
    }
    this.db
      .prepare(
        `INSERT INTO daily_risk_state (trading_date_utc, starting_balance_sol, realized_pnl_sol, circuit_breaker_triggered)
         VALUES (?, ?, 0, 0)`,
      )
      .run(dateIsoUtc, startingBalanceSol);
    return { startingBalanceSol, realizedPnlSol: 0, circuitBreakerTriggered: false };
  }

  applyRealizedPnl(dateIsoUtc: string, pnlSol: number): void {
    this.db
      .prepare(
        `UPDATE daily_risk_state SET realized_pnl_sol = realized_pnl_sol + ? WHERE trading_date_utc = ?`,
      )
      .run(pnlSol, dateIsoUtc);
  }

  latchCircuitBreaker(dateIsoUtc: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE daily_risk_state
         SET circuit_breaker_triggered = 1, circuit_breaker_triggered_at_ms = COALESCE(circuit_breaker_triggered_at_ms, ?)
         WHERE trading_date_utc = ?`,
      )
      .run(nowMs, dateIsoUtc);
  }

  getTokenTradeHistory(mint: string): TokenTradeHistory {
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) as total_trades,
                SUM(COALESCE(pnl_sol, 0)) as cumulative_pnl_sol
         FROM trades WHERE mint = ?`,
      )
      .get(mint) as unknown as { total_trades: number; cumulative_pnl_sol: number | null };

    const lastClosed = this.db
      .prepare(
        `SELECT exit_time_ms, pnl_sol FROM trades WHERE mint = ? AND status = 'closed'
         ORDER BY exit_time_ms DESC LIMIT 1`,
      )
      .get(mint) as unknown as { exit_time_ms: number | null; pnl_sol: number | null } | undefined;

    const recentClosed = this.db
      .prepare(
        `SELECT pnl_sol FROM trades WHERE mint = ? AND status = 'closed'
         ORDER BY exit_time_ms DESC LIMIT 20`,
      )
      .all(mint) as unknown as { pnl_sol: number | null }[];

    let consecutiveLosses = 0;
    for (const row of recentClosed) {
      if (row.pnl_sol !== null && row.pnl_sol < 0) {
        consecutiveLosses += 1;
      } else {
        break;
      }
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
}

export { utcDateString };
