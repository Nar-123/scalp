import type { Logger } from '../logging/logger.js';
import type { EmergencyStop } from '../risk/emergencyStop.js';
import type { TradeLedger } from '../ledger/tradeLedger.js';
import type { Position, RecoverableOpenTrade } from '../types/trade.js';
import type { PositionMonitor } from './positionMonitor.js';

/**
 * P1 fix: open-position recovery after a process restart (spec: PositionMonitor's `positions` Map is purely
 * in-memory, so a restart used to leave every still-open ledger trade unmonitored -- still counted in exposure,
 * still counted by the risk engine, but with no exit conditions ever evaluated for it again).
 *
 * Called once at startup, BEFORE `PositionMonitor.start()` -- see orchestrator/loop.ts -- so the poll loop can never
 * run even a single tick against a position set that should have had recovered positions in it but doesn't yet.
 *
 * For every ledger trade with `status = 'open'`:
 *   - if it is already tracked, or already flagged reconciliation-needed, in THIS monitor instance: skip (see
 *     "Idempotent" below);
 *   - if `reconciliation_reason` is already set (see TradeLedger.markReconciliationNeeded), or if critical sell-side
 *     data (entryFilledAmountSol, entryTokenAmountRaw, a valid entryPriceSol) is missing: the position is left open
 *     in the ledger exactly as-is, flagged reconciliation-needed, and the emergency stop is tripped -- it is NEVER
 *     reconstructed into a live Position and NEVER sold automatically;
 *   - otherwise: reconstructed into a Position (seeded with a single price-history point at the entry price/
 *     liquidity -- never a fabricated "current" market reading) and handed to `monitor.addPosition`.
 *
 * Idempotent: calling this more than once in the same process (or being handed a monitor some positions are already
 * tracked in) never duplicates or resets a position already being monitored -- which matters because blindly
 * re-adding an already-tracked position would reset its accumulated priceHistory/peak/trough back to a single
 * entry-time point, discarding everything observed since it was first recovered or opened.
 */
export interface PositionRecoveryResult {
  recovered: number;
  skipped: number;
  reconciliationFlagged: number;
}

export function recoverOpenPositions(
  ledger: TradeLedger,
  monitor: PositionMonitor,
  emergencyStop: EmergencyStop,
  logger: Logger,
  nowMs: number = Date.now(),
): PositionRecoveryResult {
  const result: PositionRecoveryResult = { recovered: 0, skipped: 0, reconciliationFlagged: 0 };

  for (const trade of ledger.getRecoverableOpenPositions()) {
    if (monitor.hasPosition(trade.tradeId) || monitor.needsReconciliation(trade.tradeId)) {
      result.skipped += 1;
      continue;
    }

    if (trade.reconciliationReason !== null) {
      flagForReconciliation(monitor, emergencyStop, logger, trade, trade.reconciliationReason, nowMs);
      result.reconciliationFlagged += 1;
      continue;
    }

    const missing = missingCriticalFields(trade);
    if (missing.length > 0) {
      const reason = `position_recovery_missing_fields:${missing.join(',')}`;
      // Persist it too: a trade recovery cannot safely resume today must never look resumable on the NEXT restart
      // either, and the ledger (not this process's memory) is the durable source of truth for that.
      ledger.markReconciliationNeeded(trade.tradeId, reason, nowMs);
      flagForReconciliation(monitor, emergencyStop, logger, trade, reason, nowMs);
      result.reconciliationFlagged += 1;
      continue;
    }

    const position: Position = {
      tradeId: trade.tradeId,
      mint: trade.mint,
      poolAddress: trade.poolAddress,
      entryTimeMs: trade.entryTimeMs,
      entryPriceSol: trade.entryPriceSol,
      entrySizeSol: trade.entrySizeSol,
      entryFilledAmountSol: trade.entryFilledAmountSol as number,
      entryTokenAmountRaw: trade.entryTokenAmountRaw,
      entryFeesSol: trade.entryFeesSol,
      reentryIndex: trade.reentryIndex,
      strategyVersion: trade.strategyVersion,
      dryRun: trade.dryRun,
      // Seeded from the recorded ENTRY tick only -- never a fabricated or reused "current" price/liquidity reading.
      // The next poll tick (see positionMonitor.pollOne) supplies the first real, live observation.
      priceHistory: [{ priceSol: trade.entryPriceSol, liquiditySol: trade.entryLiquiditySol ?? 0, timestampMs: trade.entryTimeMs }],
      peakPriceSol: trade.entryPriceSol,
      troughPriceSol: trade.entryPriceSol,
    };
    monitor.addPosition(position);
    logger.warn(
      { tradeId: trade.tradeId, mint: trade.mint, entryTimeMs: trade.entryTimeMs },
      'position recovery: reconstructed an open position from the ledger after a restart',
    );
    result.recovered += 1;
  }

  return result;
}

function missingCriticalFields(trade: RecoverableOpenTrade): string[] {
  const missing: string[] = [];
  if (!Number.isFinite(trade.entryPriceSol) || trade.entryPriceSol <= 0) missing.push('entryPriceSol');
  if (trade.entryFilledAmountSol === null || !Number.isFinite(trade.entryFilledAmountSol)) missing.push('entryFilledAmountSol');
  if (trade.entryTokenAmountRaw === null || trade.entryTokenAmountRaw.trim() === '') missing.push('entryTokenAmountRaw');
  return missing;
}

function flagForReconciliation(
  monitor: PositionMonitor,
  emergencyStop: EmergencyStop,
  logger: Logger,
  trade: RecoverableOpenTrade,
  reason: string,
  nowMs: number,
): void {
  monitor.markReconciliationNeeded(trade.tradeId, trade.mint, reason, nowMs);
  emergencyStop.trigger(`position_recovery_incomplete:${trade.tradeId}`, nowMs);
  logger.error(
    { tradeId: trade.tradeId, mint: trade.mint, reason },
    'position recovery: an open trade cannot be safely resumed -- left open in the ledger, automatic selling blocked, emergency stop tripped pending manual reconciliation',
  );
}
