import type { AppConfig } from '../config/schema.js';
import type { HardRiskParameters } from '../config/hardRisk.js';
import type { AggregatorClient } from '../discovery/types.js';
import { evaluateExit } from '../exit/exitEngine.js';
import { resolveExecutionOutcome, type ExecutionEngine, type FillResult, type PriceSource } from '../execution/types.js';
import type { Logger } from '../logging/logger.js';
import type { EmergencyStop } from '../risk/emergencyStop.js';
import { isDailyLossLimitBreached } from '../risk/dailyLossCircuitBreaker.js';
import type { TradeLedger } from '../ledger/tradeLedger.js';
import type { Position, PricePoint } from '../types/trade.js';
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
   * `'unknown'` outcome, or a retryable failure that never resolved within `MAX_SELL_DEFERRAL_MS`). The position
   * stays open (counted, in the ledger, in `positions`) but is never polled/sold again automatically: a human must
   * reconcile the real state before this trade can safely resume. This is what prevents a future live executor
   * from ever sending a DUPLICATE sell for a position whose first attempt's outcome is unknown.
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

  getOpenCount(): number {
    return this.positions.size;
  }

  /** true once a sell for this position could not be confirmed as executed: it is open but no longer traded automatically. */
  needsReconciliation(tradeId: string): boolean {
    return this.reconciliationNeeded.has(tradeId);
  }

  private async pollAll(): Promise<void> {
    const active = [...this.positions.values()];
    await Promise.all(active.map((position) => this.pollOne(position)));
  }

  private async pollOne(position: Position): Promise<void> {
    if (this.closing.has(position.tradeId)) return; // a sell for this position is already in flight
    // A prior sell for this position could not be confirmed as executed: never attempt another sell for it
    // automatically -- doing so risks a duplicate sell once a real executor is wired in. It stays open/counted
    // until a human reconciles the real state (see `handleUnexecutedSell`).
    if (this.reconciliationNeeded.has(position.tradeId)) return;
    try {
      const nowMs = Date.now();
      const [currentPriceSol, liquidityVolume] = await Promise.all([
        this.deps.priceSource.getPrice(position.mint),
        this.deps.aggregator.getLiquidityAndVolume(position.mint),
      ]);

      if (currentPriceSol === null) {
        this.deps.logger.warn({ mint: position.mint, tradeId: position.tradeId }, 'position monitor: price unavailable');
        return;
      }

      const point: PricePoint = {
        priceSol: currentPriceSol,
        liquiditySol: liquidityVolume?.liquiditySol ?? position.priceHistory.at(-1)?.liquiditySol ?? 0,
        timestampMs: nowMs,
      };
      position.priceHistory.push(point);
      position.peakPriceSol = Math.max(position.peakPriceSol, currentPriceSol);
      position.troughPriceSol = Math.min(position.troughPriceSol, currentPriceSol);

      const recentMomentumPct = computeRecentMomentumPct(position.priceHistory, currentPriceSol, nowMs);
      const recentVolatilityPct = computeRecentVolatilityPct(position.priceHistory, position.entryPriceSol);

      const decision = evaluateExit(
        {
          position,
          currentPriceSol,
          currentLiquiditySol: point.liquiditySol,
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

    this.deferredSince.delete(position.tradeId);
    this.positions.delete(position.tradeId);

    const nowMs = fill.timestampMs;
    const pnlSol = fill.filledAmountSol - position.entrySizeSol;
    const pnlPct = (pnlSol / position.entrySizeSol) * 100;
    const mfePct = pctChange(position.entryPriceSol, position.peakPriceSol);
    const maePct = pctChange(position.entryPriceSol, position.troughPriceSol);
    const dateIsoUtc = utcDateString(nowMs);

    const dailyState = this.deps.ledger.getOrInitDailyRiskState(dateIsoUtc, this.cfg.risk.dailyStartingBalanceSol);
    this.deps.ledger.applyRealizedPnl(dateIsoUtc, pnlSol);
    const updatedRealizedPnl = dailyState.realizedPnlSol + pnlSol;

    this.deps.ledger.recordExit(position.tradeId, {
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
      dailyRealizedPnlSolAtExit: updatedRealizedPnl,
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
    });

    if (isDailyLossLimitBreached(updatedRealizedPnl, dailyState.startingBalanceSol, this.hard.dailyLossLimitPct)) {
      this.deps.ledger.latchCircuitBreaker(dateIsoUtc, nowMs);
      this.deps.logger.warn({ dateIsoUtc, updatedRealizedPnl }, 'daily loss circuit breaker latched');
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
