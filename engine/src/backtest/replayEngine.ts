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
import { pctChange } from '../utils/math.js';
import { utcDateString } from '../utils/time.js';
import type { Position, PricePoint } from '../types/trade.js';
import { detectDataQualityIssuesAcrossMints } from './dataQuality.js';
import type { BacktestResult, BacktestTrade, HistoricalMarketSnapshot, SimulationAssumptions } from './types.js';

/**
 * Historical replay engine (Phase 3-alt). Reuses the EXACT same
 * deterministic functions the live orchestrator calls -- isWithinAgeWindow,
 * collectBaselineFilterFailures, computeEntryScore, computeExpectedNetEdge,
 * evaluateEntryRisk, evaluateExit, shouldLatchCircuitBreaker, simulateBuyFill/simulateSellFill
 * -- rather than a parallel reimplementation, so a backtest result reflects
 * the SAME rules that would run live, not a "close enough" approximation
 * (spec section 14/16). The only new code here is bookkeeping: replaying a
 * multi-mint stream needs its own open-positions/daily-state/token-history
 * maps, since the live versions of those live in TradeLedger/PositionMonitor
 * (I/O-bound, not reusable for a pure in-memory replay).
 *
 * NO LOOK-AHEAD (spec section 4): every mint's snapshots are appended to a
 * per-mint "seen so far" history ONE AT A TIME, in strict global
 * chronological order (see mergeGlobally below); nothing in this file ever
 * reads index `i+1` while deciding what happens at index `i`. See
 * test/backtest/replayEngine.test.ts's truncation test for a concrete,
 * general proof of this property (not just a code-review claim).
 */

type StrategyConfig = Pick<AppConfig, 'discovery' | 'filters' | 'scoring' | 'exits' | 'reentry' | 'risk'>;

interface ReplayDailyState {
  startingBalanceSol: number;
  realizedPnlSol: number;
  circuitBreakerTriggered: boolean;
}

interface ReplayTokenHistory {
  totalTrades: number;
  lastTradeExitTimeMs: number | null;
  consecutiveLosses: number;
}

interface OpenReplayPosition {
  mint: string;
  tradeId: string;
  reentryIndex: number;
  entryTimeMs: number;
  entryPriceSol: number;
  entrySizeSol: number;
  entryFilledAmountSol: number;
  entryFeesSol: number;
  /** Fee rate the BUY leg was priced with when the venue's own fee was known (the SELL leg reuses it if its snapshot carries none). */
  entryVenueFeeBps: number | null;
  entryScore: number;
  expectedNetEdgePct: number;
  priceHistory: PricePoint[];
  peakPriceSol: number;
  troughPriceSol: number;
}

interface StreamEvent {
  mint: string;
  snapshot: HistoricalMarketSnapshot;
}

function mergeGlobally(byMint: Map<string, HistoricalMarketSnapshot[]>): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const [mint, snapshots] of byMint) {
    for (const snapshot of snapshots) events.push({ mint, snapshot });
  }
  // Stable sort by observedAtMs, tie-broken by mint name -- deterministic
  // regardless of Map iteration order (spec section 25).
  events.sort((a, b) => a.snapshot.observedAtMs - b.snapshot.observedAtMs || a.mint.localeCompare(b.mint));
  return events;
}

function toPositionShape(open: OpenReplayPosition, strategyLabel: string): Position {
  return {
    tradeId: open.tradeId,
    mint: open.mint,
    poolAddress: null,
    entryTimeMs: open.entryTimeMs,
    entryPriceSol: open.entryPriceSol,
    entrySizeSol: open.entrySizeSol,
    entryFilledAmountSol: open.entryFilledAmountSol,
    reentryIndex: open.reentryIndex,
    strategyVersion: strategyLabel,
    dryRun: true,
    priceHistory: open.priceHistory,
    peakPriceSol: open.peakPriceSol,
    troughPriceSol: open.troughPriceSol,
  };
}

function closedTradeFrom(open: OpenReplayPosition, exit: { timeMs: number; priceSol: number; reason: BacktestTrade['exitReason']; feesSol: number; filledAmountSol: number }): BacktestTrade {
  const pnlSol = exit.filledAmountSol - open.entrySizeSol;
  return {
    mint: open.mint,
    reentryIndex: open.reentryIndex,
    entryTimeMs: open.entryTimeMs,
    entryPriceSol: open.entryPriceSol,
    entrySizeSol: open.entrySizeSol,
    entryFilledAmountSol: open.entryFilledAmountSol,
    entryFeesSol: open.entryFeesSol,
    entryScore: open.entryScore,
    expectedNetEdgePct: open.expectedNetEdgePct,
    exitTimeMs: exit.timeMs,
    exitPriceSol: exit.priceSol,
    exitReason: exit.reason,
    exitFeesSol: exit.feesSol,
    status: 'closed',
    pnlSol,
    pnlPct: (pnlSol / open.entrySizeSol) * 100,
    holdDurationMs: exit.timeMs - open.entryTimeMs,
    maxFavorableExcursionPct: pctChange(open.entryPriceSol, open.peakPriceSol),
    maxAdverseExcursionPct: pctChange(open.entryPriceSol, open.troughPriceSol),
  };
}

function stillOpenTradeFrom(open: OpenReplayPosition): BacktestTrade {
  return {
    mint: open.mint,
    reentryIndex: open.reentryIndex,
    entryTimeMs: open.entryTimeMs,
    entryPriceSol: open.entryPriceSol,
    entrySizeSol: open.entrySizeSol,
    entryFilledAmountSol: open.entryFilledAmountSol,
    entryFeesSol: open.entryFeesSol,
    entryScore: open.entryScore,
    expectedNetEdgePct: open.expectedNetEdgePct,
    exitTimeMs: null,
    exitPriceSol: null,
    exitReason: null,
    exitFeesSol: null,
    status: 'still_open_at_end_of_data',
    pnlSol: null,
    pnlPct: null,
    holdDurationMs: null,
    maxFavorableExcursionPct: pctChange(open.entryPriceSol, open.peakPriceSol),
    maxAdverseExcursionPct: pctChange(open.entryPriceSol, open.troughPriceSol),
  };
}

export function runReplay(
  snapshotsByMint: Map<string, HistoricalMarketSnapshot[]>,
  cfg: StrategyConfig,
  assumptions: SimulationAssumptions,
  strategyLabel: string,
): BacktestResult {
  assertHardRiskUnmodified();

  const dataQualityIssues = detectDataQualityIssuesAcrossMints(snapshotsByMint);
  const events = mergeGlobally(snapshotsByMint);

  if (events.length === 0) {
    return {
      status: 'insufficient_data',
      simulatorVersion: assumptions.simulatorVersion,
      strategyLabel,
      sampleSizeSnapshots: 0,
      trades: [],
      dataQualityIssues,
      notes:
        'No historical snapshots were available to replay. This is not a strategy result of any kind -- ' +
        'no conclusion, positive or negative, can be drawn from an empty sample.',
    };
  }

  const seenSoFar = new Map<string, HistoricalMarketSnapshot[]>();
  const openPositions = new Map<string, OpenReplayPosition>();
  const dailyState = new Map<string, ReplayDailyState>();
  const tokenHistory = new Map<string, ReplayTokenHistory>();
  const trades: BacktestTrade[] = [];
  let tradeCounter = 0;
  let exitsDeferred = 0;

  const getDailyState = (ms: number): ReplayDailyState => {
    const key = utcDateString(ms);
    let state = dailyState.get(key);
    if (!state) {
      state = { startingBalanceSol: cfg.risk.dailyStartingBalanceSol, realizedPnlSol: 0, circuitBreakerTriggered: false };
      dailyState.set(key, state);
    }
    return state;
  };

  const getTokenHistory = (mint: string): ReplayTokenHistory => {
    let h = tokenHistory.get(mint);
    if (!h) {
      h = { totalTrades: 0, lastTradeExitTimeMs: null, consecutiveLosses: 0 };
      tokenHistory.set(mint, h);
    }
    return h;
  };

  for (const { mint, snapshot } of events) {
    // Anti-look-ahead boundary: this mint's visible history grows by
    // exactly one element, right here, before anything below reads it.
    const history = seenSoFar.get(mint) ?? [];
    history.push(snapshot);
    seenSoFar.set(mint, history);

    const open = openPositions.get(mint);
    if (open) {
      if (snapshot.priceSol !== null) {
        open.priceHistory.push({
          priceSol: snapshot.priceSol,
          liquiditySol: snapshot.liquiditySol ?? open.priceHistory.at(-1)?.liquiditySol ?? 0,
          timestampMs: snapshot.observedAtMs,
        });
        open.peakPriceSol = Math.max(open.peakPriceSol, snapshot.priceSol);
        open.troughPriceSol = Math.min(open.troughPriceSol, snapshot.priceSol);

        const recentMomentumPct = computeRecentMomentumPct(open.priceHistory, snapshot.priceSol, snapshot.observedAtMs);
        const recentVolatilityPct = computeRecentVolatilityPct(open.priceHistory, open.entryPriceSol);

        const decision = evaluateExit(
          {
            position: toPositionShape(open, strategyLabel),
            currentPriceSol: snapshot.priceSol,
            currentLiquiditySol: snapshot.liquiditySol ?? open.priceHistory[0]!.liquiditySol,
            recentMomentumPct,
            recentVolatilityPct,
            nowMs: snapshot.observedAtMs,
            emergencyStopTriggered: false, // no emergency-stop concept in offline replay
          },
          cfg.exits,
        );

        const sellImpactPct = snapshot.estimatedSellPriceImpactPct;
        if (decision.shouldExit && decision.reason && (sellImpactPct === undefined || sellImpactPct === null || !Number.isFinite(sellImpactPct) || sellImpactPct < 0)) {
          // A SELL is priced with the sell-direction impact recorded at this snapshot; without it the exit is deferred (fail closed),
          // never filled with the buy impact or a default.
          exitsDeferred += 1;
        } else if (decision.shouldExit && decision.reason) {
          const grossValueSol = open.entryFilledAmountSol * (snapshot.priceSol / open.entryPriceSol);
          const { feesSol, filledAmountSol } = simulateSellFill(grossValueSol, sellImpactPct as number, assumptions.latencySlippageBufferPct, assumptions.edge, snapshot.venueFeeBps ?? open.entryVenueFeeBps);

          trades.push(
            closedTradeFrom(open, { timeMs: snapshot.observedAtMs, priceSol: snapshot.priceSol, reason: decision.reason, feesSol, filledAmountSol }),
          );
          openPositions.delete(mint);

          const pnlSol = filledAmountSol - open.entrySizeSol;
          const ds = getDailyState(snapshot.observedAtMs);
          ds.realizedPnlSol += pnlSol;
          ds.circuitBreakerTriggered = shouldLatchCircuitBreaker(
            ds.circuitBreakerTriggered,
            ds.realizedPnlSol,
            ds.startingBalanceSol,
            HARD_RISK_PARAMETERS.dailyLossLimitPct,
          );

          const th = getTokenHistory(mint);
          th.totalTrades += 1;
          th.lastTradeExitTimeMs = snapshot.observedAtMs;
          th.consecutiveLosses = pnlSol < 0 ? th.consecutiveLosses + 1 : 0;
        }
      }
      continue; // never average down: no new-entry consideration while a position on this mint is open
    }

    // --- entry consideration (only reached with no open position on this mint) ---
    if (!isWithinAgeWindow(snapshot.discoveredAtMs, snapshot.observedAtMs, cfg.discovery)) continue;
    if (snapshot.priceSol === null) continue; // cannot simulate a fill without an observed price
    if (!snapshot.safetyPassedAtObservationTime) continue; // replays the ORIGINALLY recorded safety-gate outcome; on-chain state at a past slot cannot be re-queried

    const priceVelocity = snapshot.priceVelocity5sPct ?? -Infinity;
    const volumeAccel = snapshot.volumeAccelerationX ?? 0;
    const priceImpactOrNull = snapshot.estimatedPriceImpactPct; // null => 'price_impact_unavailable' (fail closed, same contract as production)
    const baselineFailures = collectBaselineFilterFailures(
      {
        liquiditySol: snapshot.liquiditySol ?? -Infinity,
        volume1mSol: snapshot.volume1mSol, // null => 'volume_1m_unavailable' (same contract as production)
        buySellRatio: snapshot.buySellRatio ?? -Infinity,
      },
      priceVelocity,
      snapshot.volumeAccelerationX, // null => 'volume_acceleration_unavailable'
      priceImpactOrNull,
      cfg as AppConfig,
    );
    if (baselineFailures.length > 0) continue;
    const priceImpact = priceImpactOrNull as number; // non-null: a null impact was rejected above

    const txVelocityPerSec = (snapshot.txCount1m ?? 0) / 60;
    const entryScoreResult = computeEntryScore(
      {
        momentumPct5s: priceVelocity,
        volumeAccelerationX: volumeAccel,
        buySellRatio: snapshot.buySellRatio ?? 0,
        txVelocityPerSec,
        liquiditySol: snapshot.liquiditySol ?? 0,
        estimatedSlippagePct: assumptions.latencySlippageBufferPct,
        estimatedPriceImpactPct: priceImpact,
      },
      cfg.scoring.weights,
      cfg.scoring.minEntryScore,
    );

    const edgeResult = computeExpectedNetEdge({
      expectedGrossMovePct: cfg.exits.quickTpMinPct,
      dexFeeBps: assumptions.edge.dexFeeBps,
      swapFeeBps: assumptions.edge.swapFeeBps,
      networkFeeSol: assumptions.edge.networkFeeSol,
      priorityFeeSol: assumptions.edge.priorityFeeSol,
      slippagePct: assumptions.latencySlippageBufferPct,
      priceImpactPct: priceImpact,
      sellPriceImpactPct: snapshot.estimatedSellPriceImpactPct ?? null,
      venueFeeBps: snapshot.venueFeeBps ?? null,
      safetyMarginBps: assumptions.edge.safetyMarginBps,
      positionSizeSol: HARD_RISK_PARAMETERS.positionSizeSol,
    });

    if (!entryScoreResult.passesThreshold || !edgeResult.isFavorable) continue;

    const ds = getDailyState(snapshot.observedAtMs);
    const th = getTokenHistory(mint);
    const riskDecision = evaluateEntryRisk(
      {
        mint,
        openPositions: [...openPositions.values()].map((p) => ({ tradeId: p.tradeId, mint: p.mint, entrySizeSol: p.entrySizeSol })),
        dailyRealizedPnlSol: ds.realizedPnlSol,
        dailyStartingBalanceSol: ds.startingBalanceSol,
        dailyCircuitBreakerAlreadyTriggered: ds.circuitBreakerTriggered,
        emergencyStopTriggered: false,
        tokenHistory: {
          mint,
          totalTrades: th.totalTrades,
          lastTradeExitTimeMs: th.lastTradeExitTimeMs,
          lastTradeWasLoss: null,
          consecutiveLosses: th.consecutiveLosses,
          cumulativePnlSol: 0,
        },
        now: snapshot.observedAtMs,
      },
      HARD_RISK_PARAMETERS,
      cfg,
    );

    if (riskDecision.circuitBreakerTriggered) ds.circuitBreakerTriggered = true;
    if (!riskDecision.allowed) continue;

    const priceImpactForEntry = snapshot.estimatedPriceImpactPct ?? assumptions.fallbackPriceImpactPct;
    const { feesSol, filledAmountSol, breakdown } = simulateBuyFill(riskDecision.sizingSol, priceImpactForEntry, assumptions.latencySlippageBufferPct, assumptions.edge, snapshot.venueFeeBps ?? null);
    if (filledAmountSol <= 0) continue; // fees/impact would have consumed the entire position

    tradeCounter += 1;
    openPositions.set(mint, {
      mint,
      tradeId: `bt_${tradeCounter}`,
      reentryIndex: th.totalTrades,
      entryTimeMs: snapshot.observedAtMs,
      entryPriceSol: snapshot.priceSol,
      entrySizeSol: riskDecision.sizingSol,
      entryFilledAmountSol: filledAmountSol,
      entryFeesSol: feesSol,
      entryVenueFeeBps: breakdown.feeModel === 'pumpfun_curve' ? breakdown.feeBps : null,
      entryScore: entryScoreResult.score,
      expectedNetEdgePct: edgeResult.netEdgePct,
      priceHistory: [{ priceSol: snapshot.priceSol, liquiditySol: snapshot.liquiditySol ?? 0, timestampMs: snapshot.observedAtMs }],
      peakPriceSol: snapshot.priceSol,
      troughPriceSol: snapshot.priceSol,
    });
  }

  for (const open of openPositions.values()) {
    trades.push(stillOpenTradeFrom(open));
  }

  return {
    status: 'completed',
    simulatorVersion: assumptions.simulatorVersion,
    strategyLabel,
    sampleSizeSnapshots: events.length,
    trades,
    dataQualityIssues,
    exitsDeferredSellImpactUnavailable: exitsDeferred,
    notes:
      'Simulation under configured assumptions (fees, latency-slippage buffer, fallback price impact) replayed against ' +
      'this project\'s own recorded evaluation-tick snapshots, NOT a full historical order-book replay. A positive ' +
      'result is not a claim that this strategy would have been profitable live -- see docs/PHASE_3_ALT_BACKTEST_LEARNING.md.',
  };
}
