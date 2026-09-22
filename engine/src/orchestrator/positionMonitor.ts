import type { AppConfig } from '../config/schema.js';
import type { HardRiskParameters } from '../config/hardRisk.js';
import type { AggregatorClient } from '../discovery/types.js';
import { evaluateExit } from '../exit/exitEngine.js';
import type { ExecutionEngine, PriceSource } from '../execution/types.js';
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
 * position is intact and the sell is retried on the next poll. If it stays unpriceable this long the existing
 * fail-closed path takes over (execution_safety_failure + emergency stop). Data-quality bound, not a strategy parameter.
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
  /** Retryable sell attempts that did not execute because an input was unavailable (observability). */
  sellDeferrals = 0;
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

  private async pollAll(): Promise<void> {
    const active = [...this.positions.values()];
    await Promise.all(active.map((position) => this.pollOne(position)));
  }

  private async pollOne(position: Position): Promise<void> {
    if (this.closing.has(position.tradeId)) return; // a sell for this position is already in flight
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
    let fill;
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

    if (!fill.success && fill.retryable) {
      const since = this.deferredSince.get(position.tradeId) ?? fill.timestampMs;
      this.deferredSince.set(position.tradeId, since);
      if (fill.timestampMs - since < MAX_SELL_DEFERRAL_MS) {
        this.sellDeferrals += 1;
        this.deps.logger.warn({ mint: position.mint, tradeId: position.tradeId, error: fill.error }, 'sell deferred: not executed, an input was unavailable; will retry');
        return; // position stays open
      }
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
      exitReason: fill.success ? reason : 'execution_safety_failure',
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
        exitReason: fill.success ? reason : 'execution_safety_failure',
        exitObservedAtMs: nowMs,
        entryPriceSol: position.entryPriceSol,
        exitPriceSol: fill.filledPriceSol,
        entrySizeSol: position.entrySizeSol,
        entryFilledAmountSol: position.entryFilledAmountSol,
        exitFilledAmountSol: fill.filledAmountSol,
        entryFeesSol: position.entryFeesSol ?? null,
        exitFeesSol: fill.feesSol,
        sellPriceImpactPct: fill.success ? fill.priceImpactPct : null,
        exitSlippagePct: fill.slippagePct,
        holdDurationMs: nowMs - position.entryTimeMs,
      }),
    });

    if (isDailyLossLimitBreached(updatedRealizedPnl, dailyState.startingBalanceSol, this.hard.dailyLossLimitPct)) {
      this.deps.ledger.latchCircuitBreaker(dateIsoUtc, nowMs);
      this.deps.logger.warn({ dateIsoUtc, updatedRealizedPnl }, 'daily loss circuit breaker latched');
    }

    if (!fill.success) {
      this.deps.emergencyStop.trigger(`sell_execution_failed:${position.mint}`, nowMs);
      this.deps.logger.error({ mint: position.mint, tradeId: position.tradeId, error: fill.error }, 'sell execution failed');
    }

    this.deps.logger.info(
      { mint: position.mint, tradeId: position.tradeId, reason, pnlSol, pnlPct },
      'position closed',
    );
  }
}
