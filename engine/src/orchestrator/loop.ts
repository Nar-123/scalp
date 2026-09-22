import type { Connection } from '@solana/web3.js';
import { HARD_RISK_PARAMETERS } from '../config/hardRisk.js';
import type { AppConfig } from '../config/schema.js';
import type { AggregatorClient, TokenDiscoverySource } from '../discovery/types.js';
import { isWithinAgeWindow, tokenAgeSeconds } from '../discovery/tokenRegistry.js';
import { collectBaselineFilterFailures } from './baselineFilters.js';
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
import type { ShadowRunner } from '../shadow/shadowRunner.js';
import type { QuoteObservation, ShadowMarketTick } from '../shadow/types.js';
import type { NativeMarketProvider, NativeMarketSnapshot, OneMinuteVolumeProvider } from '../volume/types.js';
import type { SafetyDataSource } from '../safety/dataSource.js';
import type { ProviderMetrics } from '../providers/providerMetrics.js';
import { MAX_QUOTE_AGE_MS } from '../execution/jupiterQuoteClient.js';
import { runShutdown } from '../lifecycle/shutdown.js';
import { EntryReservations, EvaluationGuard, type EvaluationLease } from './evaluationGuard.js';
import { EvaluationScheduler } from './evaluationScheduler.js';
import { decideMarketSource } from './marketSourcePolicy.js';
import { nativeVenueFeeBps } from './nativeFirst.js';
import { buildEntryContext } from './decisionContext.js';
import { isStaleAtDecision, snapshotCoherenceIssues } from './snapshotCoherence.js';
import type { EvaluationMarketData } from '../types/trade.js';

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
  /**
   * Optional (Phase 5). When present, every already-computed tick this
   * loop produces is ALSO forwarded to shadow trading -- no extra RPC/
   * aggregator call is made for this (see shadow/types.ts's
   * ShadowMarketTick doc). Entirely additive: omitting this changes
   * nothing about production behavior, and a failure inside shadow
   * processing is caught and logged, never allowed to affect a real
   * evaluation tick.
   */
  shadowRunner?: ShadowRunner;
  /**
   * Optional (Phase 5.4B). Source of the REAL 1-minute SOL volume and the
   * volume acceleration (native Pump.fun trade events). When present it is
   * authoritative for both fields -- including when it answers null (coverage
   * not proven, graduated, unknown token): a null is never replaced by any
   * aggregator-derived number. When absent, behavior is exactly as before
   * (volume1mSol null from the aggregator, acceleration from snapshot history).
   */
  volumeProvider?: OneMinuteVolumeProvider;
  /**
   * Optional (Phase 5.5). Native Pump.fun bonding-curve market data. For a token discovered on Pump.fun it is the
   * PRIMARY source (see orchestrator/marketSourcePolicy.ts): when its snapshot is VALID, price, liquidity, volume,
   * acceleration, buy/sell ratio and price impact all come from that one snapshot and DexScreener/Jupiter are not
   * consulted. When it is not VALID the token is `market_data_unavailable` (fail closed) -- DexScreener is used
   * only for graduated tokens, non-Pump.fun tokens, or if `allowDexscreenerFallback` is explicitly enabled.
   */
  nativeMarket?: NativeMarketProvider;
  allowDexscreenerFallback?: boolean;
  /** Phase 5.6A: cached/deduplicated/failure-classified safety data (defaults to direct RPC reads). */
  safetyData?: SafetyDataSource;
  /** Phase 5.6A: provider observability (safety-unavailable reasons, provider used, as-of time). */
  providerMetrics?: ProviderMetrics;
  /** Phase 5.6A: bound for each shutdown step (default 4000 ms). */
  shutdownStepTimeoutMs?: number;
  /** A token's in-flight evaluation older than this is treated as stuck and taken over by the next tick (default 30000 ms). */
  evaluationTimeoutMs?: number;
}

interface LoopMarketValues {
  liquiditySol: number;
  volume1mSol: number | null;
  buySellRatio: number | null;
  txCount1m: number | null;
}

interface WatchHandle {
  timer: ReturnType<typeof setInterval>;
  event: DiscoveredTokenEvent;
}

export async function startOrchestrator(cfg: AppConfig, deps: OrchestratorDeps): Promise<() => Promise<void>> {
  const emergencyStop = deps.emergencyStop ?? new EmergencyStop();
  const history = new MarketHistoryTracker();
  const watched = new Map<string, WatchHandle>();
  let stopping = false;
  // Per-token in-flight guard + entry reservations (see evaluationGuard.ts): one live evaluation per token, entries counted
  // against the existing limits from the moment risk allows them, not from the moment they are recorded.
  const guard = new EvaluationGuard(deps.evaluationTimeoutMs ?? 30_000);
  const reservations = new EntryReservations();
  // Phase 5.6O: global evaluation backpressure, derived from ProviderGate's own RPC concurrency (see
  // evaluationScheduler.ts and docs/PHASE_5_6N_PROVIDERGATE_SATURATION_INVESTIGATION.md). Each safety-gate-reaching
  // evaluation makes its RPC calls SEQUENTIALLY (never more than one in flight at a time for that evaluation), so
  // bounding concurrent evaluations at the gate's own maxConcurrent guarantees the orchestrator never offers the
  // gate more simultaneous RPC demand than it can service without queueing -- no evaluation ever needs to wait in
  // ProviderGate's own waiter queue for a slot. Never below 1.
  const scheduler = new EvaluationScheduler({ maxConcurrent: Math.max(1, cfg.providers.rpc.maxConcurrent) });

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
      scheduler.forget(mint); // a token no longer watched must never consume a future global evaluation slot
    }
  }

  async function evaluateToken(event: DiscoveredTokenEvent): Promise<void> {
    if (stopping) return; // no new provider request may start once shutdown has begun
    // Acquired synchronously, BEFORE any asynchronous work: a tick that finds the token still being evaluated is skipped.
    const acquired = guard.tryAcquire(event.mint);
    if (!acquired) {
      deps.logger.debug({ mint: event.mint, skippedTicks: guard.skipped }, 'evaluation still in flight for this token: tick skipped');
      return;
    }
    if (acquired.tookOverStale) deps.logger.warn({ mint: event.mint, takeovers: guard.takeovers }, 'previous evaluation of this token exceeded its time limit: superseded');
    const lease = acquired.lease;
    try {
      await evaluateTokenInner(event, lease);
    } catch (err) {
      deps.logger.error({ err: String(err), mint: event.mint }, 'token evaluation tick failed unexpectedly');
    } finally {
      guard.release(lease); // every completion path: entry, rejection, failed safety, quote failure, exception
    }
  }

  async function evaluateTokenInner(event: DiscoveredTokenEvent, lease: EvaluationLease): Promise<void> {
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

    // Source selection (one authoritative source per evaluation; see marketSourcePolicy.ts).
    const nativeSnapshot: NativeMarketSnapshot | null = deps.nativeMarket
      ? deps.nativeMarket.getNativeMarketSnapshot(event.mint, HARD_RISK_PARAMETERS.positionSizeSol)
      : null;
    const decision = decideMarketSource(nativeSnapshot, { discoverySource: event.source, allowDexscreenerFallback: deps.allowDexscreenerFallback });
    const useNative = decision.route === 'native' && nativeSnapshot !== null && nativeSnapshot.priceSol !== null && nativeSnapshot.liquiditySol !== null;

    let currentPriceSol: number | null = null;
    let aggregatorLiquidityVolume: LoopMarketValues | null = null;
    if (useNative && nativeSnapshot) {
      currentPriceSol = nativeSnapshot.priceSol;
      aggregatorLiquidityVolume = {
        liquiditySol: nativeSnapshot.liquiditySol as number,
        volume1mSol: nativeSnapshot.volume1mSol,
        buySellRatio: nativeSnapshot.buySellRatio,
        txCount1m: nativeSnapshot.txCount1m,
      };
    } else if (decision.route !== 'unavailable') {
      const [price, agg] = await Promise.all([deps.priceSource.getPrice(event.mint), deps.aggregator.getLiquidityAndVolume(event.mint)]);
      currentPriceSol = price;
      aggregatorLiquidityVolume = agg ? { liquiditySol: agg.liquiditySol, volume1mSol: agg.volume1mSol, buySellRatio: agg.buySellRatio, txCount1m: agg.txCount1m } : null;
    }
    const marketData: EvaluationMarketData | null =
      useNative && nativeSnapshot
        ? { source: 'pumpfun_native', asOfSec: nativeSnapshot.marketDataAsOfSec, volumeWindowEndSec: nativeSnapshot.volumeWindowEndSec, stateEventSec: nativeSnapshot.stateEventSec }
        : decision.route === 'dexscreener'
          ? { source: 'dexscreener', asOfSec: null, volumeWindowEndSec: null, stateEventSec: null }
          : null;

    const marketDataTimeMs = Date.now();
    const health = deps.shadowRunner?.health;
    if (health) {
      if (useNative) {
        health.recordMarketDataResult(true);
      } else if (decision.route === 'unavailable') {
        health.recordMarketDataResult(false);
      } else {
        health.recordAggregatorResult(currentPriceSol !== null);
        health.recordAggregatorResult(aggregatorLiquidityVolume !== null);
        health.recordMarketDataResult(currentPriceSol !== null && aggregatorLiquidityVolume !== null);
      }
    }

    if (currentPriceSol === null || aggregatorLiquidityVolume === null) {
      reasons.push('market_data_unavailable');
      if (decision.route === 'unavailable') reasons.push(decision.reason);
      deps.ledger.recordEvaluation(
        buildEvaluation(evaluationId, event, nowMs, ageSec, false, reasons, null, null, cfg.strategyVersion, null, null, null, decision.route === 'unavailable' ? { source: 'pumpfun_native', asOfSec: nativeSnapshot?.marketDataAsOfSec ?? null, volumeWindowEndSec: nativeSnapshot?.volumeWindowEndSec ?? null, stateEventSec: null } : null),
      );
      if (deps.shadowRunner) {
        try {
          deps.shadowRunner.onMarketTick({
            mint: event.mint,
            discoveredAtMs: event.createdAtMs,
            observedAtMs: nowMs,
            priceSol: null,
            liquiditySol: null,
            volume1mSol: null,
            buySellRatio: null,
            priceVelocity5sPct: null,
            volumeAccelerationX: null,
            txCount1m: null,
            estimatedPriceImpactPct: null,
            safetyPassedAtObservationTime: null,
            safetyReasonsAtObservationTime: [],
            quote: null,
            timings: {
              discoveryTimeMs: event.createdAtMs,
              detectedAtMs: event.detectedAtMs ?? null,
              signalTimeMs: nowMs,
              marketDataTimeMs,
              quoteTimeMs: null,
              simulationTimeMs: Date.now(),
              exitSignalTimeMs: null,
            },
            fetchError: { source: 'aggregator', message: decision.route === 'unavailable' ? `native_market_unavailable:${decision.reason}` : currentPriceSol === null ? 'price_unavailable' : 'liquidity_volume_unavailable' },
          });
        } catch (err) {
          deps.logger.error({ err: String(err), mint: event.mint }, 'shadow tick processing failed unexpectedly');
        }
      }
      return;
    }

    // Native volume (when configured) replaces BOTH volume fields, null included.
    // (On the native route the snapshot already carries the same provider's volume; only the DexScreener route needs the override.)
    const nativeVolume = !useNative && deps.volumeProvider ? deps.volumeProvider.getOneMinuteVolume(event.mint) : null;
    const liquidityVolume: LoopMarketValues = nativeVolume ? { ...aggregatorLiquidityVolume, volume1mSol: nativeVolume.volume1mSol } : aggregatorLiquidityVolume;
    if (nativeVolume && nativeVolume.volume1mSol === null) {
      deps.logger.debug({ mint: event.mint, coverage: nativeVolume.coverage }, 'native 1m volume unavailable');
    }

    const priceVelocity5sPct = history.computeVelocityPct(event.mint, currentPriceSol, nowMs);
    const volumeAccelerationX =
      useNative && nativeSnapshot
        ? nativeSnapshot.volumeAccelerationX
        : nativeVolume
          ? nativeVolume.volumeAccelerationX
          : history.computeVolumeAccelerationX(event.mint, liquidityVolume.volume1mSol, nowMs);
    const txVelocityPerSec = (liquidityVolume.txCount1m ?? 0) / 60;
    // Native route: the exact bonding-curve impact for the entry size, or null (=> fail closed). Other routes: unchanged.
    // No default is ever substituted: an impact that cannot be quoted is null and the price-impact filter fails closed.
    let estimatedPriceImpactPct: number | null;
    let buyTokenAmountRaw: string | null = null;
    let estimatedSellPriceImpactPct: number | null = null;
    // The venue's own per-leg fee (Pump.fun protocol + creator bps of the curve); null => the configured generic fee model.
    let venueFeeBps: number | null = null;
    if (useNative && nativeSnapshot) {
      venueFeeBps = nativeVenueFeeBps(nativeSnapshot);
      estimatedPriceImpactPct = nativeSnapshot.priceImpactPct;
      buyTokenAmountRaw = nativeSnapshot.buyTokenAmountRaw;
      estimatedSellPriceImpactPct = nativeSnapshot.sellPriceImpactPct; // exact curve SELL formula (a different quantity from the buy impact)
    } else {
      const buyQuote = await deps.priceSource.getBuyExecutionQuote(event.mint, HARD_RISK_PARAMETERS.positionSizeSol);
      estimatedPriceImpactPct = buyQuote?.priceImpactPct ?? null;
      buyTokenAmountRaw = buyQuote?.tokenAmountRaw ?? null;
      venueFeeBps = buyQuote?.venueFeeBps ?? null;
    }
    // SELL-direction impact of the entry-sized position: needed while a position is open (its exit is priced with it)
    // and recorded for the entry decision. It is a SELL quote against the real market -- never the buy impact.
    let sellImpactComputed = useNative;
    async function ensureSellImpact(): Promise<void> {
      if (sellImpactComputed) return;
      sellImpactComputed = true;
      if (buyTokenAmountRaw) estimatedSellPriceImpactPct = await deps.priceSource.getSellPriceImpactPct(event.mint, buyTokenAmountRaw);
    }
    const holdsPosition = deps.ledger.getOpenPositions().some((p) => p.mint === event.mint) || (deps.shadowRunner?.hasOpenPosition(event.mint) ?? false);
    if (holdsPosition) await ensureSellImpact();
    const estimatedSlippagePct = cfg.execution.latencySlippageBufferPct;

    // Phase 5.1: the read-only quote request made just above (for price
    // impact) is observed, never repeated. `quote` is data about an
    // indicative quote, not an executable transaction.
    const quoteFetch = health && !useNative ? (deps.priceSource.takeLastQuoteFetch?.(event.mint) ?? null) : null;
    if (quoteFetch) health?.recordQuoteResult(quoteFetch.ok);
    const quoteObservation: QuoteObservation | null =
      quoteFetch && quoteFetch.ok && quoteFetch.priceImpactPct !== null
        ? {
            quotedPriceSol: null,
            quoteTimestampMs: quoteFetch.completedAtMs,
            route: quoteFetch.route ?? '',
            expectedOutputSol: null,
            outAmountRaw: quoteFetch.outAmountRaw,
            estimatedPriceImpactPct: quoteFetch.priceImpactPct,
            estimatedSlippagePct: null,
            quoteRequestLatencyMs: quoteFetch.requestLatencyMs,
          }
        : null;

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

    // Phase 5: forwards the signals ALREADY computed above to shadow
    // trading, exactly once per tick, with whatever safety verdict this
    // tick actually reached -- never an extra RPC/aggregator call. A
    // failure here is caught and logged, never allowed to affect this
    // (real) evaluation.
    const liquidityVolumeForShadow = liquidityVolume;
    function notifyShadow(safetyPassed: boolean | null, safetyReasons: string[]): void {
      if (!deps.shadowRunner) return;
      try {
        const tick: ShadowMarketTick = {
          mint: event.mint,
          discoveredAtMs: event.createdAtMs,
          observedAtMs: nowMs,
          priceSol: currentPriceSol,
          liquiditySol: liquidityVolumeForShadow.liquiditySol,
          volume1mSol: liquidityVolumeForShadow.volume1mSol,
          buySellRatio: liquidityVolumeForShadow.buySellRatio,
          priceVelocity5sPct,
          volumeAccelerationX,
          txCount1m: liquidityVolumeForShadow.txCount1m,
          estimatedPriceImpactPct,
          estimatedSellPriceImpactPct,
          venueFeeBps,
          buyTokenAmountRaw,
          buyVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.buyVolume1mSol : null,
          sellVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.sellVolume1mSol : null,
          marketSource: marketData?.source ?? null,
          marketDataAsOfSec: marketData?.asOfSec ?? null,
          volumeWindowEndSec: marketData?.volumeWindowEndSec ?? null,
          stateEventSec: marketData?.stateEventSec ?? null,
          safetyPassedAtObservationTime: safetyPassed,
          safetyReasonsAtObservationTime: safetyReasons,
          quote: quoteObservation,
          timings: {
            discoveryTimeMs: event.createdAtMs,
            detectedAtMs: event.detectedAtMs ?? null,
            signalTimeMs: nowMs,
            marketDataTimeMs,
            quoteTimeMs: quoteFetch ? quoteFetch.completedAtMs : null,
            simulationTimeMs: Date.now(),
            exitSignalTimeMs: null,
          },
          fetchError: quoteFetch && !quoteFetch.ok ? { source: 'quote', message: 'read-only quote request failed or was malformed' } : null,
        };
        deps.shadowRunner.onMarketTick(tick);
      } catch (err) {
        deps.logger.error({ err: String(err), mint: event.mint }, 'shadow tick processing failed unexpectedly');
      }
    }

    const coherenceIssues = snapshotCoherenceIssues({ observedAtMs: nowMs, marketDataTimeMs, quoteTimeMs: quoteFetch?.completedAtMs ?? null });
    const baselineFailures = [
      ...collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, estimatedPriceImpactPct, cfg),
      ...(coherenceIssues.length > 0 ? ['snapshot_timestamps_inconsistent', ...coherenceIssues] : []),
    ];
    if (baselineFailures.length > 0) {
      notifyShadow(null, []);
      deps.ledger.recordEvaluation(
        buildEvaluation(
          evaluationId,
          event,
          nowMs,
          ageSec,
          false,
          baselineFailures,
          liquidityVolume.liquiditySol,
          null,
          cfg.strategyVersion,
          currentPriceSol,
          liquidityVolume.txCount1m,
          // Record the observed market values too, so a baseline-rejected evaluation keeps the (real, possibly null) volume it was judged on.
          {
            volume1mSol: liquidityVolume.volume1mSol,
            buySellRatio: liquidityVolume.buySellRatio,
            priceVelocity5sPct,
            volumeAccelerationX,
            estimatedPriceImpactPct,
            estimatedSellPriceImpactPct,
            buyVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.buyVolume1mSol : null,
            sellVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.sellVolume1mSol : null,
          },
          marketData,
        ),
      );
      return;
    }

    // Unreachable in practice: an unavailable acceleration is already a baseline
    // failure above. Kept so the type narrows to number for scoring below.
    if (volumeAccelerationX === null || liquidityVolume.buySellRatio === null || estimatedPriceImpactPct === null) return;

    await ensureSellImpact(); // recorded with the entry decision; the exit of any position opened below is priced with the sell direction

    const safetyResult = await runSafetyGate(
      event.mint,
      {
        connection: deps.connection,
        aggregator: deps.aggregator,
        getRoundTripQuote: (mint, testAmountSol) => deps.jupiterClient.getRoundTripQuote(mint, testAmountSol, 100),
        ...(deps.safetyData ? { data: deps.safetyData } : {}),
        ...(deps.providerMetrics ? { onUnavailable: (source, reason) => deps.providerMetrics?.recordSafetyUnavailable(source, reason) } : {}),
      },
      cfg,
    );
    // Data-quality bound (not a strategy parameter): a safety verdict built from data older than the decision bound
    // is never acted on. Reason strings of the gate itself are unchanged; this only ADDS a fail-closed reason.
    if (safetyResult.passed && safetyResult.dataAsOfMs != null && Date.now() - safetyResult.dataAsOfMs > MAX_QUOTE_AGE_MS) {
      safetyResult.passed = false;
      safetyResult.reasons.push('stale_safety_data_at_decision');
      deps.providerMetrics?.recordSafetyUnavailable('quote', 'stale_safety_data_at_decision');
    }

    // Phase 5.6E: how the holder-concentration decision was made (vault verification, circulating supply, creator share). Diagnostic only.
    if (safetyResult.holderPolicy) deps.logger[safetyResult.passed ? 'info' : 'debug']({ mint: event.mint, holderPolicy: safetyResult.holderPolicy }, 'holder policy diagnostics');

    // The safety gate's RPC reads (mint account etc.): a null authority flag means the account could not be read.
    health?.recordRpcResult(safetyResult.mintAuthorityRenounced !== null);

    if (!safetyResult.passed) {
      notifyShadow(false, safetyResult.reasons);
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
        priceSol: currentPriceSol,
        liquiditySol: safetyResult.liquiditySol,
        volume1mSol: liquidityVolume.volume1mSol,
        buySellRatio: liquidityVolume.buySellRatio,
        priceVelocity5sPct,
        volumeAccelerationX,
        txCount1m: liquidityVolume.txCount1m,
        estimatedPriceImpactPct,
        estimatedSellPriceImpactPct,
        buyVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.buyVolume1mSol : null,
        sellVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.sellVolume1mSol : null,
        entryScore: null,
        entryScoreComponents: null,
        expectedNetEdgePct: null,
        expectedNetEdgeBreakdown: null,
        riskAllowed: null,
        riskRejectReasons: [],
        ledToTradeId: null,
        strategyVersion: cfg.strategyVersion,
        marketData,
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

    // The expected net edge is a COMPLETE round trip: it needs the SELL impact of the held tokens. Native tokens already have it;
    // for other routes it is fetched once here (cached for the rest of this evaluation) and only for a token that scored well enough to matter.
    if (entryScoreResult.passesThreshold) await ensureSellImpact();
    const edgeResult = computeExpectedNetEdge({
      expectedGrossMovePct: cfg.exits.quickTpMinPct,
      dexFeeBps: cfg.edge.dexFeeBps,
      swapFeeBps: cfg.edge.swapFeeBps,
      networkFeeSol: cfg.edge.networkFeeSol,
      priorityFeeSol: cfg.edge.priorityFeeSol,
      slippagePct: estimatedSlippagePct,
      priceImpactPct: estimatedPriceImpactPct,
      sellPriceImpactPct: estimatedSellPriceImpactPct,
      venueFeeBps,
      safetyMarginBps: cfg.edge.safetyMarginBps,
      positionSizeSol: HARD_RISK_PARAMETERS.positionSizeSol,
    });

    const riskRejectReasons: string[] = [];
    // Slow safety RPCs may have sat between the market fetch and this decision: do not act on an observation that is now stale.
    if (isStaleAtDecision(marketDataTimeMs, Date.now())) riskRejectReasons.push('stale_market_data_at_decision');
    if (!entryScoreResult.passesThreshold) riskRejectReasons.push('entry_score_below_threshold');
    if (!edgeResult.isFavorable) riskRejectReasons.push('unfavorable_net_edge');

    let riskAllowed = riskRejectReasons.length === 0;
    let ledToTradeId: string | null = null;

    // The evaluation row must exist BEFORE an entry is recorded (trades.entry_safety_check_id references it with a foreign
    // key). Writing it once, lazily, from here keeps that order for both the entering and the non-entering path.
    let evaluationWritten = false;
    function writeEvaluation(): void {
      if (evaluationWritten) return;
      evaluationWritten = true;
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
        priceSol: currentPriceSol,
        liquiditySol: safetyResult.liquiditySol,
        volume1mSol: liquidityVolume.volume1mSol,
        buySellRatio: liquidityVolume.buySellRatio,
        priceVelocity5sPct,
        volumeAccelerationX,
        txCount1m: liquidityVolume.txCount1m,
        estimatedPriceImpactPct,
        estimatedSellPriceImpactPct,
        buyVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.buyVolume1mSol : null,
        sellVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.sellVolume1mSol : null,
        entryScore: entryScoreResult.score,
        entryScoreComponents: entryScoreResult.components,
        expectedNetEdgePct: edgeResult.netEdgePct,
        expectedNetEdgeBreakdown: edgeResult.breakdown,
        riskAllowed,
        riskRejectReasons,
        ledToTradeId,
        strategyVersion: cfg.strategyVersion,
        marketData,
      });
    }


    if (riskAllowed) {
      const dateIsoUtc = utcDateString(nowMs);
      const dailyState = deps.ledger.getOrInitDailyRiskState(dateIsoUtc, cfg.risk.dailyStartingBalanceSol);
      const riskDecision = evaluateEntryRisk(
        {
          mint: event.mint,
          // recorded positions PLUS entries other tokens have already been allowed to make but not yet recorded
          openPositions: [...deps.ledger.getOpenPositions(), ...reservations.asOpenPositions()],
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

      // Entry commit. Everything from the risk decision above to this reservation is synchronous (no await), so it is atomic.
      // A superseded (timed-out) evaluation must not enter, and a second entry for a mint whose buy is still in flight is refused.
      let reserved = false;
      if (riskAllowed) {
        if (!guard.isCurrent(lease)) {
          riskAllowed = false;
          riskRejectReasons.push('evaluation_superseded');
        } else if (deps.ledger.getOpenPositions().some((p) => p.mint === event.mint)) {
          // Not a re-entry: the previous position on this token is still open. A second concurrent position on one token would
          // double its exposure. (Re-entry after the position CLOSES is unchanged and stays governed by the re-entry policy.)
          riskAllowed = false;
          riskRejectReasons.push('position_already_open');
        } else if (!reservations.reserve(event.mint, riskDecision.sizingSol)) {
          riskAllowed = false;
          riskRejectReasons.push('entry_in_progress');
        } else {
          reserved = true;
        }
      }

      if (riskAllowed) {
       try {
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
            entryTokenAmountRaw: fill.tokenAmountRaw ?? null,
            entryContext: buildEntryContext({
              strategyVersion: cfg.strategyVersion,
              mint: event.mint,
              discoveredAtMs: event.createdAtMs,
              observedAtMs: nowMs,
              tokenAgeSec: ageSec,
              marketSource: marketData?.source ?? null,
              marketDataTimeMs,
              marketDataAsOfSec: marketData?.asOfSec ?? null,
              volumeWindowEndSec: marketData?.volumeWindowEndSec ?? null,
              stateEventSec: marketData?.stateEventSec ?? null,
              priceSol: currentPriceSol,
              liquiditySol: liquidityVolume.liquiditySol,
              volume1mSol: liquidityVolume.volume1mSol,
              buyVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.buyVolume1mSol : null,
              sellVolume1mSol: nativeSnapshot && useNative ? nativeSnapshot.sellVolume1mSol : null,
              buySellRatio: liquidityVolume.buySellRatio,
              priceVelocity5sPct,
              volumeAccelerationX,
              buyPriceImpactPct: estimatedPriceImpactPct,
              sellPriceImpactPct: estimatedSellPriceImpactPct,
              buyTokenAmountRaw,
              safetyPassed: true,
              safetyReasons: [],
              entryScore: entryScoreResult.score,
              expectedNetEdgePct: edgeResult.netEdgePct,
              expectedNetEdgeBreakdown: edgeResult.breakdown,
              entryDecision: 'enter',
            }),
          };
          writeEvaluation(); // parent row first (foreign key), then the trade, then the link
          deps.ledger.recordEntry(entry);
          deps.ledger.linkEvaluationToTrade(evaluationId, tradeId);
          ledToTradeId = tradeId;

          const position: Position = {
            tradeId,
            mint: event.mint,
            poolAddress: event.poolAddress,
            entryTimeMs: fill.timestampMs,
            entryPriceSol: fill.filledPriceSol,
            entrySizeSol: riskDecision.sizingSol,
            entryFilledAmountSol: fill.filledAmountSol,
            entryTokenAmountRaw: fill.tokenAmountRaw ?? null,
            entryFeesSol: fill.feesSol,
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
       } finally {
        // released only after the position is recorded (or the buy failed/threw), never before
        if (reserved) reservations.release(event.mint);
       }
      }
    }

    notifyShadow(true, []);

    writeEvaluation();
  }

  function watchToken(event: DiscoveredTokenEvent): void {
    if (stopping || watched.has(event.mint)) return;
    // Every tick goes through the global scheduler first (Phase 5.6O), never straight into evaluateToken(): under
    // normal load this is transparent (a free slot is always available so the tick runs immediately, identical to
    // before); only under sustained overload does it coalesce/defer rather than adding to ProviderGate's own queue.
    const timer = setInterval(() => scheduler.requestTick(event.mint, () => evaluateToken(event)), EVAL_INTERVAL_MS);
    watched.set(event.mint, { timer, event });
    scheduler.requestTick(event.mint, () => evaluateToken(event));
  }

  for (const source of deps.discoverySources) {
    await source.start((event) => watchToken(event));
  }

  /**
   * Bounded shutdown (Phase 5.6A). Order matters: first stop everything that STARTS provider requests (evaluation
   * timers, position monitor, discovery sources), each step bounded so a hung unsubscribe cannot block termination.
   * Evaluations already in flight are cut by the provider layer's own shutdown (called by the caller afterwards).
   */
  return async function stopOrchestrator(): Promise<void> {
    stopping = true;
    for (const mint of [...watched.keys()]) {
      stopWatching(mint);
    }
    scheduler.stop(); // refuses any further dispatch; already-active evaluations are left to finish (bounded by their own timeouts)
    positionMonitor.stop();
    const stepMs = deps.shutdownStepTimeoutMs ?? 4000;
    const reports = await runShutdown(
      deps.discoverySources.map((source) => ({ name: `stop_${source.name}`, run: () => source.stop() })),
      { stepTimeoutMs: stepMs },
    );
    for (const r of reports) if (r.outcome !== 'ok') deps.logger.warn(r, 'shutdown step did not complete cleanly');
  };
}

export { collectBaselineFilterFailures };

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
  priceSol: number | null = null,
  txCount1m: number | null = null,
  market: {
    volume1mSol: number | null;
    buySellRatio: number | null;
    priceVelocity5sPct: number | null;
    volumeAccelerationX: number | null;
    estimatedPriceImpactPct: number | null;
    estimatedSellPriceImpactPct?: number | null;
    buyVolume1mSol?: number | null;
    sellVolume1mSol?: number | null;
  } | null = null,
  marketData: EvaluationMarketData | null = null,
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
    priceSol,
    liquiditySol,
    volume1mSol: market?.volume1mSol ?? null,
    buySellRatio: market?.buySellRatio ?? null,
    priceVelocity5sPct: market?.priceVelocity5sPct ?? null,
    volumeAccelerationX: market?.volumeAccelerationX ?? null,
    txCount1m,
    estimatedPriceImpactPct: market?.estimatedPriceImpactPct ?? null,
    ...(market?.estimatedSellPriceImpactPct != null ? { estimatedSellPriceImpactPct: market.estimatedSellPriceImpactPct } : {}),
    ...(market?.buyVolume1mSol != null ? { buyVolume1mSol: market.buyVolume1mSol } : {}),
    ...(market?.sellVolume1mSol != null ? { sellVolume1mSol: market.sellVolume1mSol } : {}),
    entryScore,
    entryScoreComponents: null,
    expectedNetEdgePct: null,
    expectedNetEdgeBreakdown: null,
    riskAllowed: null,
    riskRejectReasons: [],
    ledToTradeId: null,
    strategyVersion,
    ...(marketData ? { marketData } : {}),
  };
}
