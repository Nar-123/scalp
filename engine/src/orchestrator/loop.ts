import type { Connection } from '@solana/web3.js';
import { HARD_RISK_PARAMETERS } from '../config/hardRisk.js';
import type { AppConfig } from '../config/schema.js';
import type { AggregatorClient, TokenDiscoverySource } from '../discovery/types.js';
import { isWithinAgeWindow, tokenAgeSeconds } from '../discovery/tokenRegistry.js';
import { runSafetyGate } from '../safety/safetyGate.js';
import { computeEntryScore } from '../scoring/entryScorer.js';
import { computeExpectedNetEdge } from '../scoring/expectedNetEdge.js';
import { evaluateEntryRisk } from '../risk/riskEngine.js';
import { EmergencyStop } from '../risk/emergencyStop.js';
import type { ExecutionEngine, PriceSource } from '../execution/types.js';
import type { JupiterQuoteClient } from '../execution/jupiterQuoteClient.js';
import type { TradeLedger } from '../ledger/tradeLedger.js';
import type { DiscoveredTokenEvent } from '../types/token.js';
import type { TokenEvaluationRecord, TradeEntryRecord, Position } from '../types/trade.js';
import type { Logger } from '../logging/logger.js';
import { genId } from '../utils/math.js';
import { utcDateString } from '../utils/time.js';
import { MarketHistoryTracker } from './marketHistory.js';
import { PositionMonitor } from './positionMonitor.js';

const EVAL_INTERVAL_MS = 2000;

export interface OrchestratorDeps {
  discoverySources: TokenDiscoverySource[];
  aggregator: AggregatorClient;
  connection: Connection;
  executor: ExecutionEngine;
  priceSource: PriceSource;
  jupiterClient: JupiterQuoteClient;
  ledger: TradeLedger;
  logger: Logger;
  emergencyStop?: EmergencyStop;
}

interface WatchHandle {
  timer: ReturnType<typeof setInterval>;
  event: DiscoveredTokenEvent;
}

export async function startOrchestrator(cfg: AppConfig, deps: OrchestratorDeps): Promise<() => Promise<void>> {
  const emergencyStop = deps.emergencyStop ?? new EmergencyStop();
  const history = new MarketHistoryTracker();
  const watched = new Map<string, WatchHandle>();

  const positionMonitor = new PositionMonitor(
    { executor: deps.executor, priceSource: deps.priceSource, aggregator: deps.aggregator, ledger: deps.ledger, emergencyStop, logger: deps.logger },
    cfg,
    HARD_RISK_PARAMETERS,
  );
  positionMonitor.start();

  function stopWatching(mint: string): void {
    const handle = watched.get(mint);
    if (handle) {
      clearInterval(handle.timer);
      watched.delete(mint);
      history.clear(mint);
    }
  }

  async function evaluateToken(event: DiscoveredTokenEvent): Promise<void> {
    try {
      await evaluateTokenInner(event);
    } catch (err) {
      deps.logger.error({ err: String(err), mint: event.mint }, 'token evaluation tick failed unexpectedly');
    }
  }

  async function evaluateTokenInner(event: DiscoveredTokenEvent): Promise<void> {
    const nowMs = Date.now();
    const ageSec = tokenAgeSeconds(event.createdAtMs, nowMs);

    if (ageSec >= cfg.discovery.maxTokenAgeSec) {
      stopWatching(event.mint);
      return;
    }
    if (!isWithinAgeWindow(event.createdAtMs, nowMs, cfg.discovery)) {
      return; // too young still; keep watching
    }

    if (emergencyStop.isTriggered()) {
      return; // no new evaluations while the kill switch is active
    }

    const evaluationId = genId('eval');
    const reasons: string[] = [];

    const [currentPriceSol, liquidityVolume] = await Promise.all([
      deps.priceSource.getPrice(event.mint),
      deps.aggregator.getLiquidityAndVolume(event.mint),
    ]);

    if (currentPriceSol === null || liquidityVolume === null) {
      reasons.push('market_data_unavailable');
      deps.ledger.recordEvaluation(
        buildEvaluation(evaluationId, event, nowMs, ageSec, false, reasons, null, null, cfg.strategyVersion),
      );
      return;
    }

    const priceVelocity5sPct = history.computeVelocityPct(event.mint, currentPriceSol, nowMs);
    const volumeAccelerationX = history.computeVolumeAccelerationX(event.mint, liquidityVolume.volume1mSol, nowMs);
    const txVelocityPerSec = liquidityVolume.txCount1m / 60;
    const estimatedPriceImpactPct =
      (await deps.priceSource.getEstimatedPriceImpactPct(event.mint, HARD_RISK_PARAMETERS.positionSizeSol)) ??
      cfg.execution.fallbackPriceImpactPct;
    const estimatedSlippagePct = cfg.execution.latencySlippageBufferPct;

    history.record({
      mint: event.mint,
      priceSol: currentPriceSol,
      liquiditySol: liquidityVolume.liquiditySol,
      volume1mSol: liquidityVolume.volume1mSol,
      buySellRatio: liquidityVolume.buySellRatio,
      priceVelocity5sPct,
      volumeAccelerationX,
      txVelocityPerSec,
      estimatedSlippagePct,
      estimatedPriceImpactPct,
      observedAtMs: nowMs,
    });

    const baselineFailures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, estimatedPriceImpactPct, cfg);
    if (baselineFailures.length > 0) {
      deps.ledger.recordEvaluation(
        buildEvaluation(evaluationId, event, nowMs, ageSec, false, baselineFailures, liquidityVolume.liquiditySol, null, cfg.strategyVersion),
      );
      return;
    }

    const safetyResult = await runSafetyGate(
      event.mint,
      {
        connection: deps.connection,
        aggregator: deps.aggregator,
        getRoundTripQuote: (mint, testAmountSol) => deps.jupiterClient.getRoundTripQuote(mint, testAmountSol, 100),
      },
      cfg,
    );

    if (!safetyResult.passed) {
      deps.ledger.recordEvaluation({
        id: evaluationId,
        mint: event.mint,
        poolAddress: event.poolAddress,
        discoverySource: event.source,
        discoveredAtMs: event.createdAtMs,
        evaluatedAtMs: nowMs,
        tokenAgeSec: ageSec,
        safetyPassed: false,
        safetyReasons: safetyResult.reasons,
        mintAuthorityRenounced: safetyResult.mintAuthorityRenounced,
        freezeAuthorityRenounced: safetyResult.freezeAuthorityRenounced,
        top10HolderPct: safetyResult.top10HolderPct,
        liquiditySol: safetyResult.liquiditySol,
        volume1mSol: liquidityVolume.volume1mSol,
        buySellRatio: liquidityVolume.buySellRatio,
        priceVelocity5sPct,
        volumeAccelerationX,
        estimatedPriceImpactPct,
        entryScore: null,
        entryScoreComponents: null,
        expectedNetEdgePct: null,
        expectedNetEdgeBreakdown: null,
        riskAllowed: null,
        riskRejectReasons: [],
        ledToTradeId: null,
        strategyVersion: cfg.strategyVersion,
      });
      return;
    }

    const entryScoreResult = computeEntryScore(
      {
        momentumPct5s: priceVelocity5sPct,
        volumeAccelerationX,
        buySellRatio: liquidityVolume.buySellRatio,
        txVelocityPerSec,
        liquiditySol: liquidityVolume.liquiditySol,
        estimatedSlippagePct,
        estimatedPriceImpactPct,
      },
      cfg.scoring.weights,
      cfg.scoring.minEntryScore,
    );

    const edgeResult = computeExpectedNetEdge({
      expectedGrossMovePct: cfg.exits.quickTpMinPct,
      dexFeeBps: cfg.edge.dexFeeBps,
      swapFeeBps: cfg.edge.swapFeeBps,
      networkFeeSol: cfg.edge.networkFeeSol,
      priorityFeeSol: cfg.edge.priorityFeeSol,
      slippagePct: estimatedSlippagePct,
      priceImpactPct: estimatedPriceImpactPct,
      safetyMarginBps: cfg.edge.safetyMarginBps,
      positionSizeSol: HARD_RISK_PARAMETERS.positionSizeSol,
    });

    const riskRejectReasons: string[] = [];
    if (!entryScoreResult.passesThreshold) riskRejectReasons.push('entry_score_below_threshold');
    if (!edgeResult.isFavorable) riskRejectReasons.push('unfavorable_net_edge');

    let riskAllowed = riskRejectReasons.length === 0;
    let ledToTradeId: string | null = null;

    if (riskAllowed) {
      const dateIsoUtc = utcDateString(nowMs);
      const dailyState = deps.ledger.getOrInitDailyRiskState(dateIsoUtc, cfg.risk.dailyStartingBalanceSol);
      const riskDecision = evaluateEntryRisk(
        {
          mint: event.mint,
          openPositions: deps.ledger.getOpenPositions(),
          dailyRealizedPnlSol: dailyState.realizedPnlSol,
          dailyStartingBalanceSol: dailyState.startingBalanceSol,
          dailyCircuitBreakerAlreadyTriggered: dailyState.circuitBreakerTriggered,
          emergencyStopTriggered: emergencyStop.isTriggered(),
          tokenHistory: deps.ledger.getTokenTradeHistory(event.mint),
          now: nowMs,
        },
        HARD_RISK_PARAMETERS,
        cfg,
      );

      riskAllowed = riskDecision.allowed;
      riskRejectReasons.push(...riskDecision.reasons);

      if (riskDecision.circuitBreakerTriggered) {
        deps.ledger.latchCircuitBreaker(dateIsoUtc, nowMs);
      }

      if (riskAllowed) {
        const fill = await deps.executor.buy({
          mint: event.mint,
          amountSol: riskDecision.sizingSol,
          maxSlippageBps: HARD_RISK_PARAMETERS.maxSlippageBps,
        });

        if (fill.success) {
          const tradeId = genId('trade');
          const tokenHistory = deps.ledger.getTokenTradeHistory(event.mint);
          const entry: TradeEntryRecord = {
            id: tradeId,
            mint: event.mint,
            poolAddress: event.poolAddress,
            strategyVersion: cfg.strategyVersion,
            dryRun: cfg.dryRun,
            reentryIndex: tokenHistory.totalTrades,
            entryTimeMs: fill.timestampMs,
            entryPriceSol: fill.filledPriceSol,
            entrySizeSol: riskDecision.sizingSol,
            entryTokenAgeSec: ageSec,
            entryLiquiditySol: liquidityVolume.liquiditySol,
            entryVolume1mSol: liquidityVolume.volume1mSol,
            entryBuySellRatio: liquidityVolume.buySellRatio,
            entryPriceVelocity5sPct: priceVelocity5sPct,
            entryVolumeAccelerationX: volumeAccelerationX,
            entryScore: entryScoreResult.score,
            entryScoreComponents: entryScoreResult.components,
            expectedNetEdgePct: edgeResult.netEdgePct,
            expectedNetEdgeBreakdown: edgeResult.breakdown,
            entrySlippagePct: fill.slippagePct,
            entryPriceImpactPct: fill.priceImpactPct,
            entryFeesSol: fill.feesSol,
            entryTxSignature: fill.txSignature,
            entrySafetyCheckId: evaluationId,
            dailyRealizedPnlSolAtEntry: dailyState.realizedPnlSol,
          };
          deps.ledger.recordEntry(entry);
          ledToTradeId = tradeId;

          const position: Position = {
            tradeId,
            mint: event.mint,
            poolAddress: event.poolAddress,
            entryTimeMs: fill.timestampMs,
            entryPriceSol: fill.filledPriceSol,
            entrySizeSol: riskDecision.sizingSol,
            entryFilledAmountSol: fill.filledAmountSol,
            reentryIndex: tokenHistory.totalTrades,
            strategyVersion: cfg.strategyVersion,
            dryRun: cfg.dryRun,
            priceHistory: [{ priceSol: fill.filledPriceSol, liquiditySol: liquidityVolume.liquiditySol, timestampMs: fill.timestampMs }],
            peakPriceSol: fill.filledPriceSol,
            troughPriceSol: fill.filledPriceSol,
          };
          positionMonitor.addPosition(position);

          deps.logger.info({ mint: event.mint, tradeId, sizingSol: riskDecision.sizingSol }, 'position opened');
        } else {
          deps.logger.warn({ mint: event.mint, error: fill.error }, 'buy execution failed after passing all gates');
        }
      }
    }

    deps.ledger.recordEvaluation({
      id: evaluationId,
      mint: event.mint,
      poolAddress: event.poolAddress,
      discoverySource: event.source,
      discoveredAtMs: event.createdAtMs,
      evaluatedAtMs: nowMs,
      tokenAgeSec: ageSec,
      safetyPassed: true,
      safetyReasons: [],
      mintAuthorityRenounced: safetyResult.mintAuthorityRenounced,
      freezeAuthorityRenounced: safetyResult.freezeAuthorityRenounced,
      top10HolderPct: safetyResult.top10HolderPct,
      liquiditySol: safetyResult.liquiditySol,
      volume1mSol: liquidityVolume.volume1mSol,
      buySellRatio: liquidityVolume.buySellRatio,
      priceVelocity5sPct,
      volumeAccelerationX,
      estimatedPriceImpactPct,
      entryScore: entryScoreResult.score,
      entryScoreComponents: entryScoreResult.components,
      expectedNetEdgePct: edgeResult.netEdgePct,
      expectedNetEdgeBreakdown: edgeResult.breakdown,
      riskAllowed,
      riskRejectReasons,
      ledToTradeId,
      strategyVersion: cfg.strategyVersion,
    });
  }

  function watchToken(event: DiscoveredTokenEvent): void {
    if (watched.has(event.mint)) return;
    const timer = setInterval(() => void evaluateToken(event), EVAL_INTERVAL_MS);
    watched.set(event.mint, { timer, event });
    void evaluateToken(event);
  }

  for (const source of deps.discoverySources) {
    await source.start((event) => watchToken(event));
  }

  return async function stopOrchestrator(): Promise<void> {
    for (const source of deps.discoverySources) {
      await source.stop();
    }
    for (const mint of [...watched.keys()]) {
      stopWatching(mint);
    }
    positionMonitor.stop();
  };
}

function collectBaselineFilterFailures(
  liquidityVolume: { liquiditySol: number; volume1mSol: number; buySellRatio: number },
  priceVelocity5sPct: number,
  volumeAccelerationX: number,
  estimatedPriceImpactPct: number,
  cfg: AppConfig,
): string[] {
  const failures: string[] = [];
  if (liquidityVolume.liquiditySol < cfg.filters.minLiquiditySol) failures.push('liquidity_below_minimum');
  if (liquidityVolume.volume1mSol < cfg.filters.minVolume1mSol) failures.push('volume_below_minimum');
  if (liquidityVolume.buySellRatio < cfg.filters.minBuySellRatio) failures.push('buy_sell_ratio_below_minimum');
  if (priceVelocity5sPct < cfg.filters.minPriceVelocity5sPct) failures.push('price_velocity_below_minimum');
  if (volumeAccelerationX < cfg.filters.minVolumeAccelerationX) failures.push('volume_acceleration_below_minimum');
  if (estimatedPriceImpactPct > cfg.filters.maxPriceImpactPct) failures.push('price_impact_above_maximum');
  return failures;
}

function buildEvaluation(
  id: string,
  event: DiscoveredTokenEvent,
  nowMs: number,
  ageSec: number,
  safetyPassed: boolean,
  reasons: string[],
  liquiditySol: number | null,
  entryScore: number | null,
  strategyVersion: string,
): TokenEvaluationRecord {
  return {
    id,
    mint: event.mint,
    poolAddress: event.poolAddress,
    discoverySource: event.source,
    discoveredAtMs: event.createdAtMs,
    evaluatedAtMs: nowMs,
    tokenAgeSec: ageSec,
    safetyPassed,
    safetyReasons: reasons,
    mintAuthorityRenounced: null,
    freezeAuthorityRenounced: null,
    top10HolderPct: null,
    liquiditySol,
    volume1mSol: null,
    buySellRatio: null,
    priceVelocity5sPct: null,
    volumeAccelerationX: null,
    estimatedPriceImpactPct: null,
    entryScore,
    entryScoreComponents: null,
    expectedNetEdgePct: null,
    expectedNetEdgeBreakdown: null,
    riskAllowed: null,
    riskRejectReasons: [],
    ledToTradeId: null,
    strategyVersion,
  };
}
