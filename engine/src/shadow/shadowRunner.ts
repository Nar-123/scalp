import { buildEntryContext, buildExitContext } from '../orchestrator/decisionContext.js';
import { snapshotCoherenceIssues } from '../orchestrator/snapshotCoherence.js';
import type { SimulationAssumptions } from '../backtest/types.js';
import { HARD_RISK_PARAMETERS, assertHardRiskUnmodified } from '../config/hardRisk.js';
import type { AppConfig } from '../config/schema.js';
import { isWithinAgeWindow } from '../discovery/tokenRegistry.js';
import { collectBaselineFilterFailures } from '../orchestrator/baselineFilters.js';
import { computeRecentMomentumPct, computeRecentVolatilityPct } from '../orchestrator/positionSignals.js';
import { computeEntryScore } from '../scoring/entryScorer.js';
import { computeExpectedNetEdge } from '../scoring/expectedNetEdge.js';
import { evaluateEntryRisk } from '../risk/riskEngine.js';
import { shouldLatchCircuitBreaker } from '../risk/dailyLossCircuitBreaker.js';
import { evaluateExit } from '../exit/exitEngine.js';
import { simulateBuyFill, simulateSellFill } from '../execution/fillSimulation.js';
import { genId, pctChange } from '../utils/math.js';
import { utcDateString } from '../utils/time.js';
import type { Position, PricePoint } from '../types/trade.js';
import { checkTickDataQuality, isBlockingSeverity } from './dataQualityMonitor.js';
import { computeLatencySample } from './latencyTracker.js';
import type { TrackedEntry, TrackedExit } from './pricePath.js';
import type { ShadowLedger } from './shadowLedger.js';
import { HealthCounters } from './shadowStatus.js';
import type { ShadowMarketTick, ShadowOutcome, ShadowTradeRecord } from './types.js';

/**
 * Realtime shadow trading (Phase 5). This is the live twin of
 * backtest/replayEngine.ts: it reuses the EXACT same production functions
 * -- isWithinAgeWindow, collectBaselineFilterFailures, computeEntryScore,
 * computeExpectedNetEdge, evaluateEntryRisk, evaluateExit,
 * shouldLatchCircuitBreaker, simulateBuyFill/simulateSellFill -- driven by ONE live tick at a
 * time instead of a historical batch, with state read from/written to
 * ShadowLedger (SQLite) instead of in-memory Maps, so shadow risk/position
 * state survives a process restart (spec task 9: "do not reset this limit
 * simply because the system restarts").
 *
 * NO WALLET, NO SIGNER: this file imports nothing from execution/signer/**
 * (enforced by eslint.config.js's shadow-isolation rule, mirroring the
 * existing hard-risk-isolation rule) and has no constructor parameter or
 * code path through which a Signer/SecretProvider could ever be supplied.
 * A BUY/SELL "fill" here is always simulateBuyFill()/simulateSellFill() -- pure arithmetic over
 * an already-observed price, never a transaction of any kind.
 */

export interface ShadowStrategyConfig {
  strategyVersion: string;
  config: Pick<AppConfig, 'discovery' | 'filters' | 'scoring' | 'exits' | 'reentry' | 'risk'>;
}

export interface ShadowRunnerOptions {
  ledger: ShadowLedger;
  strategies: ShadowStrategyConfig[];
  assumptions: SimulationAssumptions;
  /** Optional shared health counters (the live engine passes one persisted via the ledger). */
  health?: HealthCounters;
  /**
   * Optional OBSERVER of shadow trade lifecycle events (Phase 5.6H price-path instrumentation). It is called after the trade is
   * already recorded, receives copies of values the decision already used, is wrapped so it cannot throw into the runner, and
   * its result is never read: it cannot influence any entry, exit or risk decision.
   */
  lifecycle?: ShadowLifecycleListener;
}

export interface ShadowLifecycleListener {
  onEntry(entry: TrackedEntry): void;
  onExit(tradeId: string, exit: TrackedExit): void;
}

// After this many consecutive ticks rejected ONLY for impossible_price_change,
// the price is treated as a genuine re-pricing: the baseline moves (so the
// mint isn't blocked forever) although those ticks themselves stay rejected.
const IMPOSSIBLE_PRICE_REBASELINE_AFTER = 3;

export class ShadowRunner {
  private readonly priceHistories = new Map<string, PricePoint[]>();
  private readonly lastTickByMint = new Map<string, ShadowMarketTick>();
  private readonly impossibleStreak = new Map<string, number>();
  readonly health: HealthCounters;

  constructor(private readonly opts: ShadowRunnerOptions) {
    assertHardRiskUnmodified();
    this.health = opts.health ?? new HealthCounters();
  }

  /**
   * The one entry point. Called once per realtime tick with data the
   * caller ALREADY fetched this tick -- never issues its own RPC,
   * aggregator, or quote request, so feeding it ticks can never duplicate
   * a network call.
   *
   * Data-quality policy (every event is persisted, none silently dropped):
   *   block / reject severity -> the tick drives no strategy's entry or exit
   *   and does not become the baseline for the next comparison (one bad
   *   tick cannot make the following good tick look bad).
   *   warning severity -> recorded, tick still used.
   */
  onMarketTick(tick: ShadowMarketTick): ShadowOutcome[] {
    const started = performance.now();
    this.health.increment('shadow_ticks_received');
    // volume1mSol is deliberately not part of this check: it is systematically
    // unavailable (no real 1-minute source) and is handled by the baseline
    // filters as 'volume_1m_unavailable', not as missing market data.
    if (tick.priceSol === null || tick.liquiditySol === null || tick.buySellRatio === null) {
      this.health.increment('missing_market_data');
    }

    const previousTick = this.lastTickByMint.get(tick.mint) ?? null;
    const dqIssues = checkTickDataQuality(tick.mint, null, previousTick, tick);
    for (const issue of dqIssues) {
      this.opts.ledger.recordDataQualityEvent(genId('dq'), issue);
    }

    const blocking = dqIssues.filter((issue) => isBlockingSeverity(issue.severity));
    const onlyImpossiblePrice = blocking.length > 0 && blocking.every((i) => i.kind === 'impossible_price_change');
    if (onlyImpossiblePrice) {
      const streak = (this.impossibleStreak.get(tick.mint) ?? 0) + 1;
      this.impossibleStreak.set(tick.mint, streak);
      if (streak >= IMPOSSIBLE_PRICE_REBASELINE_AFTER) {
        this.lastTickByMint.set(tick.mint, tick);
        this.impossibleStreak.delete(tick.mint);
      }
    } else {
      this.impossibleStreak.delete(tick.mint);
      if (blocking.length === 0) this.lastTickByMint.set(tick.mint, tick);
    }

    let outcomes: ShadowOutcome[];
    if (blocking.length > 0) {
      this.health.increment('shadow_ticks_rejected_data_quality');
      outcomes = this.opts.strategies.map((strat) => ({ strategyVersion: strat.strategyVersion, mint: tick.mint, kind: 'skipped_data_quality' as const }));
    } else {
      outcomes = this.opts.strategies.map((strat) => this.processStrategyTick(strat, tick));
    }

    this.opts.ledger.recordLatencySample(genId('lat'), computeLatencySample(tick, performance.now() - started));
    return outcomes;
  }

  /** true when ANY shadow strategy holds an open position on this mint (lets the caller compute a sell impact for it). */
  hasOpenPosition(mint: string): boolean {
    return this.opts.strategies.some((strat) => this.opts.ledger.getOpenPosition(strat.strategyVersion, mint) !== null);
  }

  private recordMissed(strategyVersion: string, tick: ShadowMarketTick, reason: string, detail: string): void {
    this.opts.ledger.recordMissedSignal(genId('missed'), {
      mint: tick.mint,
      strategyVersion,
      observedAtMs: tick.observedAtMs,
      reason,
      detail,
    });
  }

  private processStrategyTick(strat: ShadowStrategyConfig, tick: ShadowMarketTick): ShadowOutcome {
    const open = this.opts.ledger.getOpenPosition(strat.strategyVersion, tick.mint);
    if (open) {
      return this.processExit(strat, tick, open);
    }
    return this.processEntry(strat, tick);
  }

  private processExit(strat: ShadowStrategyConfig, tick: ShadowMarketTick, open: ShadowTradeRecord): ShadowOutcome {
    if (tick.priceSol === null) {
      return { strategyVersion: strat.strategyVersion, mint: tick.mint, kind: 'no_action', detail: 'price_unavailable' };
    }

    const history =
      this.priceHistories.get(open.tradeId) ??
      [{ priceSol: open.entryPriceSol, liquiditySol: open.entryLiquiditySol ?? tick.liquiditySol ?? 0, timestampMs: open.entryTimeMs }];
    history.push({ priceSol: tick.priceSol, liquiditySol: tick.liquiditySol ?? history.at(-1)!.liquiditySol, timestampMs: tick.observedAtMs });
    this.priceHistories.set(open.tradeId, history);

    let peakPriceSol = -Infinity;
    let troughPriceSol = Infinity;
    for (const point of history) {
      peakPriceSol = Math.max(peakPriceSol, point.priceSol);
      troughPriceSol = Math.min(troughPriceSol, point.priceSol);
    }

    const recentMomentumPct = computeRecentMomentumPct(history, tick.priceSol, tick.observedAtMs);
    const recentVolatilityPct = computeRecentVolatilityPct(history, open.entryPriceSol);

    const position: Position = {
      tradeId: open.tradeId,
      mint: open.mint,
      poolAddress: null,
      entryTimeMs: open.entryTimeMs,
      entryPriceSol: open.entryPriceSol,
      entrySizeSol: open.entrySizeSol,
      entryFilledAmountSol: open.entryFilledAmountSol,
      reentryIndex: open.reentryIndex,
      strategyVersion: strat.strategyVersion,
      dryRun: true,
      priceHistory: history,
      peakPriceSol,
      troughPriceSol,
    };

    const decision = evaluateExit(
      {
        position,
        currentPriceSol: tick.priceSol,
        currentLiquiditySol: tick.liquiditySol ?? history.at(-1)!.liquiditySol,
        recentMomentumPct,
        recentVolatilityPct,
        nowMs: tick.observedAtMs,
        emergencyStopTriggered: false,
      },
      strat.config.exits,
    );

    if (!decision.shouldExit || !decision.reason) {
      return { strategyVersion: strat.strategyVersion, mint: tick.mint, kind: 'held' };
    }

    // The exit is a SELL: it is priced with the sell-direction impact only. The buy impact is never substituted and no
    // default is invented -- without a sell impact the exit is DEFERRED (the position stays open, retried next tick).
    const sellImpactPct = tick.estimatedSellPriceImpactPct;
    if (sellImpactPct === undefined || sellImpactPct === null || !Number.isFinite(sellImpactPct) || sellImpactPct < 0) {
      this.health.increment('exit_deferred_sell_impact_unavailable');
      return { strategyVersion: strat.strategyVersion, mint: tick.mint, kind: 'held', detail: 'exit_deferred_sell_impact_unavailable' };
    }
    const grossValueSol = open.entryFilledAmountSol * (tick.priceSol / open.entryPriceSol);
    // The SELL leg is priced at the tick's venue fee; a tick that carries none falls back to the fee model the ENTRY used, so
    // both legs of one trade always use the same fee assumption.
    const entryFeeBps = open.entryContext?.feeModel === 'pumpfun_curve' && typeof open.entryContext.feeBps === 'number' ? open.entryContext.feeBps : null;
    const sellFill = simulateSellFill(grossValueSol, sellImpactPct, this.opts.assumptions.latencySlippageBufferPct, this.opts.assumptions.edge, tick.venueFeeBps ?? entryFeeBps);
    const { feesSol, filledAmountSol } = sellFill;
    const pnlSol = filledAmountSol - open.entrySizeSol;

    this.opts.ledger.recordExit(open.tradeId, {
      exitTimeMs: tick.observedAtMs,
      exitPriceSol: tick.priceSol,
      exitReason: decision.reason,
      exitFeesSol: feesSol,
      pnlSol,
      pnlPct: (pnlSol / open.entrySizeSol) * 100,
      holdDurationMs: tick.observedAtMs - open.entryTimeMs,
      maxFavorableExcursionPct: pctChange(open.entryPriceSol, peakPriceSol),
      maxAdverseExcursionPct: pctChange(open.entryPriceSol, troughPriceSol),
      exitContext: buildExitContext({
        exitReason: decision.reason,
        exitObservedAtMs: tick.observedAtMs,
        entryPriceSol: open.entryPriceSol,
        exitPriceSol: tick.priceSol,
        entrySizeSol: open.entrySizeSol,
        entryFilledAmountSol: open.entryFilledAmountSol,
        exitFilledAmountSol: filledAmountSol,
        entryFeesSol: open.entryFeesSol,
        exitFeesSol: feesSol,
        sellPriceImpactPct: sellImpactPct,
        exitSlippagePct: this.opts.assumptions.latencySlippageBufferPct,
        holdDurationMs: tick.observedAtMs - open.entryTimeMs,
        feeModel: sellFill.breakdown.feeModel,
        feeBps: sellFill.breakdown.feeBps,
        sellVenueFeeSol: sellFill.breakdown.venueFeeSol,
        sellFixedCostSol: sellFill.breakdown.fixedSol,
        sellPriceImpactSol: sellFill.breakdown.priceImpactSol,
        sellLatencySlippageSol: sellFill.breakdown.latencySlippageSol,
      }),
    });
    this.priceHistories.delete(open.tradeId);
    this.notifyLifecycle(() =>
      this.opts.lifecycle?.onExit(open.tradeId, {
        exitTimeMs: tick.observedAtMs,
        exitPriceSol: tick.priceSol as number,
        exitFeesSol: feesSol,
        exitReason: decision.reason as string,
        netPnlSol: pnlSol,
        netPnlPct: (pnlSol / open.entrySizeSol) * 100,
      }),
    );

    const dateIsoUtc = utcDateString(tick.observedAtMs);
    const dailyState = this.opts.ledger.getOrInitDailyRiskState(strat.strategyVersion, dateIsoUtc, strat.config.risk.dailyStartingBalanceSol);
    this.opts.ledger.applyRealizedPnl(strat.strategyVersion, dateIsoUtc, pnlSol);
    const updatedPnl = dailyState.realizedPnlSol + pnlSol;
    if (shouldLatchCircuitBreaker(dailyState.circuitBreakerTriggered, updatedPnl, dailyState.startingBalanceSol, HARD_RISK_PARAMETERS.dailyLossLimitPct)) {
      this.opts.ledger.latchCircuitBreaker(strat.strategyVersion, dateIsoUtc, tick.observedAtMs);
    }

    return { strategyVersion: strat.strategyVersion, mint: tick.mint, kind: 'exited', exitReason: decision.reason };
  }

  private processEntry(strat: ShadowStrategyConfig, tick: ShadowMarketTick): ShadowOutcome {
    const { strategyVersion, config: cfg } = strat;
    const ledger = this.opts.ledger;

    if (!isWithinAgeWindow(tick.discoveredAtMs, tick.observedAtMs, cfg.discovery)) {
      return { strategyVersion, mint: tick.mint, kind: 'no_action', detail: 'outside_age_window' };
    }

    if (tick.priceSol === null || tick.liquiditySol === null || tick.buySellRatio === null) {
      this.recordMissed(strategyVersion, tick, 'missing_market_data', 'one or more required market fields were unavailable this tick');
      return { strategyVersion, mint: tick.mint, kind: 'missed_signal', detail: 'missing_market_data' };
    }

    // One observation must be one moment: parts stamped materially apart are not combined (fail closed).
    const coherence = snapshotCoherenceIssues({ observedAtMs: tick.observedAtMs, marketDataTimeMs: tick.timings.marketDataTimeMs ?? null, quoteTimeMs: tick.timings.quoteTimeMs });
    if (coherence.length > 0) {
      this.health.increment('snapshot_timestamps_inconsistent');
      this.recordMissed(strategyVersion, tick, 'snapshot_timestamps_inconsistent', coherence.join(','));
      return { strategyVersion, mint: tick.mint, kind: 'missed_signal', detail: `snapshot_timestamps_inconsistent:${coherence.join(',')}` };
    }

    if (tick.safetyPassedAtObservationTime !== true) {
      return {
        strategyVersion,
        mint: tick.mint,
        kind: 'rejected_safety',
        detail: tick.safetyReasonsAtObservationTime.join(',') || 'safety_not_passed',
      };
    }

    const priceVelocity = tick.priceVelocity5sPct ?? -Infinity;
    const volumeAccel = tick.volumeAccelerationX ?? 0;
    // null (never a made-up number) when no impact could be quoted: the baseline filter then fails closed as 'price_impact_unavailable'.
    const priceImpactOrNull = tick.quote?.estimatedPriceImpactPct ?? tick.estimatedPriceImpactPct ?? null;

    const baselineFailures = collectBaselineFilterFailures(
      { liquiditySol: tick.liquiditySol, volume1mSol: tick.volume1mSol, buySellRatio: tick.buySellRatio },
      priceVelocity,
      tick.volumeAccelerationX,
      priceImpactOrNull,
      cfg as AppConfig,
    );
    if (baselineFailures.length > 0) {
      return { strategyVersion, mint: tick.mint, kind: 'rejected_baseline', detail: baselineFailures.join(',') };
    }

    const priceImpact = priceImpactOrNull as number; // non-null: a null impact was rejected by the baseline filters above
    const estimatedSlippagePct = tick.quote?.estimatedSlippagePct ?? this.opts.assumptions.latencySlippageBufferPct;
    const txVelocityPerSec = (tick.txCount1m ?? 0) / 60;

    const entryScoreResult = computeEntryScore(
      {
        momentumPct5s: priceVelocity,
        volumeAccelerationX: volumeAccel,
        buySellRatio: tick.buySellRatio,
        txVelocityPerSec,
        liquiditySol: tick.liquiditySol,
        estimatedSlippagePct,
        estimatedPriceImpactPct: priceImpact,
      },
      cfg.scoring.weights,
      cfg.scoring.minEntryScore,
    );

    const edgeResult = computeExpectedNetEdge({
      expectedGrossMovePct: cfg.exits.quickTpMinPct,
      dexFeeBps: this.opts.assumptions.edge.dexFeeBps,
      swapFeeBps: this.opts.assumptions.edge.swapFeeBps,
      networkFeeSol: this.opts.assumptions.edge.networkFeeSol,
      priorityFeeSol: this.opts.assumptions.edge.priorityFeeSol,
      slippagePct: estimatedSlippagePct,
      priceImpactPct: priceImpact,
      sellPriceImpactPct: tick.estimatedSellPriceImpactPct ?? null,
      venueFeeBps: tick.venueFeeBps ?? null,
      safetyMarginBps: this.opts.assumptions.edge.safetyMarginBps,
      positionSizeSol: HARD_RISK_PARAMETERS.positionSizeSol,
    });

    if (!entryScoreResult.passesThreshold || !edgeResult.isFavorable) {
      return { strategyVersion, mint: tick.mint, kind: 'rejected_score_or_edge' };
    }

    const dateIsoUtc = utcDateString(tick.observedAtMs);
    const dailyState = ledger.getOrInitDailyRiskState(strategyVersion, dateIsoUtc, cfg.risk.dailyStartingBalanceSol);
    const tokenHistory = ledger.getTokenTradeHistory(strategyVersion, tick.mint);
    const riskDecision = evaluateEntryRisk(
      {
        mint: tick.mint,
        openPositions: ledger.getOpenPositions(strategyVersion),
        dailyRealizedPnlSol: dailyState.realizedPnlSol,
        dailyStartingBalanceSol: dailyState.startingBalanceSol,
        dailyCircuitBreakerAlreadyTriggered: dailyState.circuitBreakerTriggered,
        emergencyStopTriggered: false,
        tokenHistory,
        now: tick.observedAtMs,
      },
      HARD_RISK_PARAMETERS,
      cfg,
    );

    if (riskDecision.circuitBreakerTriggered) {
      ledger.latchCircuitBreaker(strategyVersion, dateIsoUtc, tick.observedAtMs);
    }

    if (!riskDecision.allowed) {
      this.recordMissed(strategyVersion, tick, riskDecision.reasons[0] ?? 'risk_blocked', riskDecision.reasons.join(','));
      return { strategyVersion, mint: tick.mint, kind: 'missed_signal', detail: riskDecision.reasons.join(',') };
    }

    const priceImpactForEntry = Number.isFinite(priceImpact) ? priceImpact : this.opts.assumptions.fallbackPriceImpactPct;
    const buyFill = simulateBuyFill(riskDecision.sizingSol, priceImpactForEntry, this.opts.assumptions.latencySlippageBufferPct, this.opts.assumptions.edge, tick.venueFeeBps ?? null);
    const { feesSol, filledAmountSol } = buyFill;
    if (filledAmountSol <= 0) {
      return { strategyVersion, mint: tick.mint, kind: 'no_action', detail: 'fill_would_be_zero' };
    }

    const tradeId = genId('shadow');
    ledger.recordEntry({
      tradeId,
      strategyVersion,
      executionMode: 'shadow',
      simulatorVersion: this.opts.assumptions.simulatorVersion,
      mint: tick.mint,
      reentryIndex: tokenHistory.totalTrades,
      entryTimeMs: tick.observedAtMs,
      entryPriceSol: tick.priceSol,
      entrySizeSol: riskDecision.sizingSol,
      entryFilledAmountSol: filledAmountSol,
      entryFeesSol: feesSol,
      entryScore: entryScoreResult.score,
      expectedNetEdgePct: edgeResult.netEdgePct,
      entryLiquiditySol: tick.liquiditySol,
      entryQuote: tick.quote,
      entryTokenAmountRaw: tick.buyTokenAmountRaw ?? tick.quote?.outAmountRaw ?? null,
      entryContext: buildEntryContext({
        strategyVersion,
        mint: tick.mint,
        discoveredAtMs: tick.discoveredAtMs,
        observedAtMs: tick.observedAtMs,
        tokenAgeSec: (tick.observedAtMs - tick.discoveredAtMs) / 1000,
        marketSource: tick.marketSource ?? null,
        marketDataTimeMs: tick.timings.marketDataTimeMs ?? null,
        marketDataAsOfSec: tick.marketDataAsOfSec ?? null,
        volumeWindowEndSec: tick.volumeWindowEndSec ?? null,
        stateEventSec: tick.stateEventSec ?? null,
        priceSol: tick.priceSol,
        liquiditySol: tick.liquiditySol,
        volume1mSol: tick.volume1mSol,
        buyVolume1mSol: tick.buyVolume1mSol ?? null,
        sellVolume1mSol: tick.sellVolume1mSol ?? null,
        buySellRatio: tick.buySellRatio,
        priceVelocity5sPct: tick.priceVelocity5sPct,
        volumeAccelerationX: tick.volumeAccelerationX,
        buyPriceImpactPct: priceImpact,
        sellPriceImpactPct: tick.estimatedSellPriceImpactPct ?? null,
        buyTokenAmountRaw: tick.buyTokenAmountRaw ?? tick.quote?.outAmountRaw ?? null,
        safetyPassed: tick.safetyPassedAtObservationTime,
        safetyReasons: tick.safetyReasonsAtObservationTime,
        entryScore: entryScoreResult.score,
        expectedNetEdgePct: edgeResult.netEdgePct,
        expectedNetEdgeBreakdown: edgeResult.breakdown,
        entryDecision: 'enter',
        feeModel: buyFill.breakdown.feeModel,
        feeBps: buyFill.breakdown.feeBps,
        entrySpendSol: riskDecision.sizingSol,
        buyVenueFeeSol: buyFill.breakdown.venueFeeSol,
        buyFixedCostSol: buyFill.breakdown.fixedSol,
        buyPriceImpactSol: buyFill.breakdown.priceImpactSol,
        buyLatencySlippageSol: buyFill.breakdown.latencySlippageSol,
        entryFilledAmountSol: filledAmountSol,
      }),
      exitTimeMs: null,
      exitPriceSol: null,
      exitReason: null,
      exitFeesSol: null,
      status: 'open',
      pnlSol: null,
      pnlPct: null,
      holdDurationMs: null,
      maxFavorableExcursionPct: null,
      maxAdverseExcursionPct: null,
    });

    this.notifyLifecycle(() =>
      this.opts.lifecycle?.onEntry({
        tradeId,
        tradeKind: 'shadow',
        strategyVersion,
        mint: tick.mint,
        entryTimeMs: tick.observedAtMs,
        entryPriceSol: tick.priceSol as number,
        entrySizeSol: riskDecision.sizingSol,
        entryFilledAmountSol: filledAmountSol,
        entryFeesSol: feesSol,
        entryTokenAmountRaw: tick.buyTokenAmountRaw ?? tick.quote?.outAmountRaw ?? null,
        entryLiquiditySol: tick.liquiditySol,
        entryVolume1mSol: tick.volume1mSol,
        entryFeeModel: buyFill.breakdown.feeModel,
        entryFeeBps: buyFill.breakdown.feeBps,
      }),
    );

    return { strategyVersion, mint: tick.mint, kind: 'entered' };
  }

  private notifyLifecycle(fn: () => void): void {
    try {
      fn();
    } catch {
      this.health.increment('lifecycle_listener_errors');
    }
  }
}
