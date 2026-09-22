import type { AppConfig } from '../config/schema.js';
import type { HardRiskParameters } from '../config/hardRisk.js';
import type { AggregatorClient } from '../discovery/types.js';
import { evaluateExit } from '../exit/exitEngine.js';
import { resolveExecutionOutcome, type ExecutionEngine, type FillResult, type PriceSource } from '../execution/types.js';
import type { Logger } from '../logging/logger.js';
import type { EmergencyStop } from '../risk/emergencyStop.js';
import { isDailyLossLimitBreached } from '../risk/dailyLossCircuitBreaker.js';
import type { TradeLedger } from '../ledger/tradeLedger.js';
import type { Position, PricePoint, TradeExitRecord } from '../types/trade.js';
import { pctChange } from '../utils/math.js';
import { utcDateString } from '../utils/time.js';
import { computeRecentMomentumPct, computeRecentVolatilityPct } from './positionSignals.js';
import { buildExitContext } from './decisionContext.js';

const POLL_INTERVAL_MS = 1000;
/**
 * A sell that could not even be PRICED (price / token amount / sell impact unavailable) executed nothing, so the
 * position is intact and the sell is retried on the next poll. If it stays unpriceable this long, automatic
 * retries stop and the position is flagged for reconciliation (see `handleUnexecutedSell`) -- it is NEVER closed
 * with a fabricated PnL just because it could not be priced. Data-quality bound, not a strategy parameter.
 */
const MAX_SELL_DEFERRAL_MS = 60_000;

export interface PositionMonitorDeps {
  executor: ExecutionEngine;
  priceSource: PriceSource;
  aggregator: AggregatorClient;
  ledger: TradeLedger;
  emergencyStop: EmergencyStop;
  logger: Logger;
}

/**
 * Polls every open position roughly once a second and applies the
 * deterministic exit engine. On a triggered exit it sells, records the exit
 * in the ledger, and updates the day's realized PnL / circuit-breaker latch.
 */
export class PositionMonitor {
  private readonly positions = new Map<string, Position>();
  private readonly closing = new Set<string>();
  private readonly deferredSince = new Map<string, number>();
  /**
   * Trade IDs whose sell outcome could not be confirmed as executed (a non-retryable "not executed" failure, an
   * `'unknown'` outcome, a retryable failure that never resolved within `MAX_SELL_DEFERRAL_MS`), OR whose ledger
   * row could not be safely recovered/persisted (see `markReconciliationNeeded`, orchestrator/positionRecovery.ts).
   * The position stays open (counted, in the ledger) but is never polled/sold again automatically: a human must
   * reconcile the real state before this trade can safely resume. This is what prevents a future live executor
   * from ever sending a DUPLICATE sell for a position whose real state is unknown or unconfirmed.
   */
  private readonly reconciliationNeeded = new Set<string>();
  /** Retryable sell attempts that did not execute because an input was unavailable (observability). */
  sellDeferrals = 0;
  /** Sells that could not be confirmed as executed and were escalated to `reconciliationNeeded` (observability/alerting). */
  sellReconciliationEvents = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: PositionMonitorDeps,
    private readonly cfg: Pick<AppConfig, 'exits' | 'risk'>,
    private readonly hard: HardRiskParameters,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollAll();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  addPosition(position: Position): void {
    this.positions.set(position.tradeId, position);
  }

  /** True once this trade is being actively monitored (used by positionRecovery.ts to stay idempotent). */
  hasPosition(tradeId: string): boolean {
    return this.positions.has(tradeId);
  }

  getOpenCount(): number {
    return this.positions.size;
  }

  /** true once a sell for this position could not be confirmed as executed: it is open but no longer traded automatically. */
  needsReconciliation(tradeId: string): boolean {
    return this.reconciliationNeeded.has(tradeId);
  }

  /**
   * Flags a trade so automatic selling is permanently blocked for it in this process, and trips the emergency stop.
   * Used by:
   *  - `handleUnexecutedSell` below, for a sell whose outcome could not be confirmed;
   *  - orchestrator/positionRecovery.ts, for a ledger-open trade that cannot be safely reconstructed at startup
   *    (missing critical data, or already carrying a persisted `reconciliation_reason`) -- called WITHOUT the
   *    position ever having been added to `positions`, so it is flagged without ever being polled or sold.
   * Idempotent: flagging an already-flagged trade only re-triggers the emergency stop (harmless -- `trigger` simply
   * overwrites reason/timestamp) and is otherwise a no-op.
   */
  markReconciliationNeeded(tradeId: string, mint: string, reason: string, nowMs: number = Date.now()): void {
    this.reconciliationNeeded.add(tradeId);
    this.sellReconciliationEvents += 1;
    this.deps.emergencyStop.trigger(reason, nowMs);
    this.deps.logger.error({ mint, tradeId, reason }, 'trade flagged for manual reconciliation: automatic selling blocked');
  }

  private async pollAll(): Promise<void> {
    const active = [...this.positions.values()];
    await Promise.all(active.map((position) => this.pollOne(position)));
  }

  private async pollOne(position: Position): Promise<void> {
    if (this.closing.has(position.tradeId)) return; // a sell for this position is already in flight
    // A prior sell for this position could not be confirmed as executed (or it could not be safely recovered at
    // startup): never attempt another sell for it automatically -- doing so risks a duplicate sell once a real
    // executor is wired in. It stays open/counted until a human reconciles the real state.
    if (this.reconciliationNeeded.has(position.tradeId)) return;
    try {
      const nowMs = Date.now();
      const [currentPriceSol, liquidityVolume] = await Promise.all([
        this.deps.priceSource.getPrice(position.mint),
        this.deps.aggregator.getLiquidityAndVolume(position.mint),
      ]);

      let recentMomentumPct = 0;
      let recentVolatilityPct = 0;

      if (currentPriceSol === null) {
        // Price unavailable: do NOT fabricate a price and do NOT reuse an old price as "current" -- but do NOT skip
        // evaluation altogether either. evaluateExit() is called below regardless: emergency-stop and max-hold-
        // timeout do not need a current price to begin with, and every condition that DOES need one is skipped
        // safely INSIDE evaluateExit (currentPriceSol === null there), not here. This is what fixes the bug where a
        // bare early `return` here used to skip emergency-stop and max-hold entirely whenever the price provider
        // was unavailable, leaving a position that should have been force-closed sitting open indefinitely.
        this.deps.logger.warn({ mint: position.mint, tradeId: position.tradeId }, 'position monitor: price unavailable; evaluating non-price exit conditions only');
      } else {
        // The liquidity value stored on the history point is a best-effort HISTORICAL annotation only (falls back
        // to the last known reading when the aggregator has none this tick, same as before this fix) -- it is
        // never read back as "current" anywhere. `currentLiquiditySol` below is sourced independently and honestly.
        const point: PricePoint = {
          priceSol: currentPriceSol,
          liquiditySol: liquidityVolume?.liquiditySol ?? position.priceHistory.at(-1)?.liquiditySol ?? 0,
          timestampMs: nowMs,
        };
        position.priceHistory.push(point);
        position.peakPriceSol = Math.max(position.peakPriceSol, currentPriceSol);
        position.troughPriceSol = Math.min(position.troughPriceSol, currentPriceSol);
        recentMomentumPct = computeRecentMomentumPct(position.priceHistory, currentPriceSol, nowMs);
        recentVolatilityPct = computeRecentVolatilityPct(position.priceHistory, position.entryPriceSol);
      }

      // Current liquidity: null means "unavailable this tick", full stop -- never backfilled from priceHistory or
      // any other stale reading. A stale substitution here could hide a real liquidity collapse from the
      // deterioration check (see exit/exitEngine.ts, which skips that ONE condition, and only that one, when this
      // is null). Independent of the price branch above: either can be available while the other is not.
      const currentLiquiditySol: number | null = liquidityVolume?.liquiditySol ?? null;
      if (currentLiquiditySol === null) {
        this.deps.logger.warn({ mint: position.mint, tradeId: position.tradeId }, 'position monitor: current liquidity unavailable; liquidity-deterioration exit not evaluated this tick');
      }

      const decision = evaluateExit(
        {
          position,
          currentPriceSol,
          currentLiquiditySol,
          recentMomentumPct,
          recentVolatilityPct,
          nowMs,
          emergencyStopTriggered: this.deps.emergencyStop.isTriggered(),
        },
        this.cfg.exits,
      );

      if (decision.shouldExit && decision.reason) {
        await this.closePosition(position, decision.reason);
      }
    } catch (err) {
      this.deps.logger.error({ err: String(err), tradeId: position.tradeId }, 'position monitor tick failed');
    }
  }

  private async closePosition(position: Position, reason: NonNullable<ReturnType<typeof evaluateExit>['reason']>): Promise<void> {
    this.closing.add(position.tradeId);
    let fill: FillResult;
    try {
      fill = await this.deps.executor.sell({
        mint: position.mint,
        entryPriceSol: position.entryPriceSol,
        entryFilledAmountSol: position.entryFilledAmountSol,
        tokenAmountRaw: position.entryTokenAmountRaw ?? null,
        maxSlippageBps: this.hard.maxSlippageBps,
      });
    } finally {
      this.closing.delete(position.tradeId);
    }

    // The ONLY question that decides whether this position may be closed: did the sell actually execute? A
    // `success:false` fill (or an explicit 'unknown' outcome) NEVER means a real sale happened, so it must never be
    // recorded as a realized exit, never given a realized PnL, and never removed from tracking -- see
    // `handleUnexecutedSell`. This is what the pre-fix code got wrong: it treated "the executor call failed" as
    // "the position is closed", fabricating a full-position realized loss for a sell that executed nothing.
    if (resolveExecutionOutcome(fill) !== 'executed') {
      this.handleUnexecutedSell(position, fill);
      return;
    }

    // From here the sell IS confirmed executed. Every write below is composed into ONE atomic ledger transaction
    // (TradeLedger.runExitTransaction) and -- critically -- the position is NOT removed from `this.positions` until
    // that transaction actually commits. The pre-fix code deleted it from tracking FIRST, then made three separate,
    // un-transacted ledger writes: a crash or a genuine SQLite failure between any of those steps used to leave the
    // ledger and in-memory state permanently inconsistent (exposure silently vanished from tracking while the
    // ledger row was still 'open' with none of this recorded anywhere), with nothing left indicating a real sale
    // had happened at all.
    const nowMs = fill.timestampMs;
    const pnlSol = fill.filledAmountSol - position.entrySizeSol;
    const pnlPct = (pnlSol / position.entrySizeSol) * 100;
    const mfePct = pctChange(position.entryPriceSol, position.peakPriceSol);
    const maePct = pctChange(position.entryPriceSol, position.troughPriceSol);
    const dateIsoUtc = utcDateString(nowMs);

    let persisted: { updatedRealizedPnlSol: number; circuitBreakerLatched: boolean };
    try {
      persisted = this.deps.ledger.runExitTransaction(() => {
        const dailyState = this.deps.ledger.getOrInitDailyRiskState(dateIsoUtc, this.cfg.risk.dailyStartingBalanceSol);
        const updatedRealizedPnlSol = dailyState.realizedPnlSol + pnlSol;
        this.deps.ledger.applyRealizedPnl(dateIsoUtc, pnlSol);

        const exit: TradeExitRecord = {
          exitTimeMs: nowMs,
          exitPriceSol: fill.filledPriceSol,
          exitReason: reason,
          exitFeesSol: fill.feesSol,
          exitTxSignature: fill.txSignature,
          exitSlippagePct: fill.slippagePct,
          holdDurationMs: nowMs - position.entryTimeMs,
          pnlSol,
          pnlPct,
          maxFavorableExcursionPct: mfePct,
          maxAdverseExcursionPct: maePct,
          dailyRealizedPnlSolAtExit: updatedRealizedPnlSol,
          exitContext: buildExitContext({
            exitReason: reason,
            exitObservedAtMs: nowMs,
            entryPriceSol: position.entryPriceSol,
            exitPriceSol: fill.filledPriceSol,
            entrySizeSol: position.entrySizeSol,
            entryFilledAmountSol: position.entryFilledAmountSol,
            exitFilledAmountSol: fill.filledAmountSol,
            entryFeesSol: position.entryFeesSol ?? null,
            exitFeesSol: fill.feesSol,
            sellPriceImpactPct: fill.priceImpactPct,
            exitSlippagePct: fill.slippagePct,
            holdDurationMs: nowMs - position.entryTimeMs,
          }),
        };
        this.deps.ledger.recordExit(position.tradeId, exit);

        const circuitBreakerLatched = isDailyLossLimitBreached(updatedRealizedPnlSol, dailyState.startingBalanceSol, this.hard.dailyLossLimitPct);
        if (circuitBreakerLatched) this.deps.ledger.latchCircuitBreaker(dateIsoUtc, nowMs);

        return { updatedRealizedPnlSol, circuitBreakerLatched };
      });
    } catch (err) {
      // The sell ALREADY executed (confirmed above), but committing that to the ledger failed. A real sale must
      // never look "still open and untouched" (the position stays tracked, exposure stays counted -- nothing about
      // its accounting is lost), and it must never be sold AGAIN automatically (that would risk a duplicate sell
      // against a position that no longer exists on-chain). `markReconciliationNeeded` persists a reason on the
      // ledger row too, so a restart never silently resumes trading this trade either (see positionRecovery.ts).
      const reasonText = `exit_persistence_failed:${String(err)}`;
      try {
        this.deps.ledger.markReconciliationNeeded(position.tradeId, reasonText, nowMs);
      } catch (markErr) {
        this.deps.logger.error({ tradeId: position.tradeId, err: String(markErr) }, 'position monitor: failed to persist the reconciliation marker itself after an exit-persistence failure');
      }
      this.markReconciliationNeeded(position.tradeId, position.mint, reasonText, nowMs);
      this.deps.logger.error(
        { mint: position.mint, tradeId: position.tradeId, err: String(err), fillTxSignature: fill.txSignature },
        'sell executed but the ledger exit write failed: position left tracked (never deleted, never fabricated) and blocked from further automatic selling pending manual reconciliation',
      );
      return; // this.positions still holds it -- nothing is removed on this path
    }

    this.deferredSince.delete(position.tradeId);
    this.positions.delete(position.tradeId);

    if (persisted.circuitBreakerLatched) {
      this.deps.logger.warn({ dateIsoUtc, updatedRealizedPnl: persisted.updatedRealizedPnlSol }, 'daily loss circuit breaker latched');
    }
    this.deps.logger.info(
      { mint: position.mint, tradeId: position.tradeId, reason, pnlSol, pnlPct },
      'position closed',
    );
  }

  /**
   * A sell that did NOT confirm as executed. The position is left exactly as it was -- open, in the ledger, in
   * `this.positions` -- with no exit recorded and no PnL applied, because nothing real happened to record. A
   * retryable, still-fresh "not executed" failure (a data-quality gap: price/impact/token-amount unavailable) is
   * simply retried on the next poll. Anything else -- a non-retryable "not executed" failure (retrying would not
   * help), an `'unknown'` outcome (retrying risks a DUPLICATE sell), or a retryable failure that never resolved
   * within `MAX_SELL_DEFERRAL_MS` -- escalates: automatic selling is permanently blocked for this position
   * (`reconciliationNeeded`, checked in `pollOne`) and the emergency stop is triggered so a human investigates.
   */
  private handleUnexecutedSell(position: Position, fill: FillResult): void {
    const outcome = resolveExecutionOutcome(fill);
    if (outcome === 'not_executed' && fill.retryable) {
      const since = this.deferredSince.get(position.tradeId) ?? fill.timestampMs;
      this.deferredSince.set(position.tradeId, since);
      if (fill.timestampMs - since < MAX_SELL_DEFERRAL_MS) {
        this.sellDeferrals += 1;
        this.deps.logger.warn({ mint: position.mint, tradeId: position.tradeId, error: fill.error }, 'sell deferred: not executed, an input was unavailable; will retry');
        return; // position stays open, untouched, retried next poll
      }
      // retryable but never resolved within the bound: fall through and escalate below.
    }

    this.deferredSince.delete(position.tradeId);
    this.reconciliationNeeded.add(position.tradeId);
    this.sellReconciliationEvents += 1;
    this.deps.emergencyStop.trigger(`sell_not_confirmed_executed:${position.mint}`, fill.timestampMs);
    this.deps.logger.error(
      { mint: position.mint, tradeId: position.tradeId, outcome, error: fill.error },
      'sell did not confirm as executed: position left open with no PnL applied; automatic selling blocked pending manual reconciliation',
    );
  }
}
