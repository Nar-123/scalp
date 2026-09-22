import 'dotenv/config';
import { assertHardRiskUnmodified, HARD_RISK_PARAMETERS } from './config/hardRisk.js';
import { loadConfig } from './config/loader.js';
import { createLogger } from './logging/logger.js';
import { DexscreenerBirdeyeAggregator } from './discovery/aggregatorFallbackClient.js';
import { RaydiumLogSubscriber } from './discovery/raydiumLogSubscriber.js';
import { PumpFunLogSubscriber } from './discovery/pumpFunLogSubscriber.js';
import { createProviderStack } from './providers/providerStack.js';
import { ProviderMetricsRecorder } from './providers/metricsRecorder.js';
import { runShutdown } from './lifecycle/shutdown.js';
import { MarketPriceSource } from './execution/marketPriceSource.js';
import { DryRunExecutor } from './execution/dryRunExecutor.js';
import { LiveExecutorStub } from './execution/liveExecutorStub.js';
import { NullSigner } from './execution/signer/nullSigner.js';
import { openLedger } from './ledger/db.js';
import { TradeLedger } from './ledger/tradeLedger.js';
import { EmergencyStop } from './risk/emergencyStop.js';
import { startOrchestrator } from './orchestrator/loop.js';
import { createShadowActivation } from './shadow/activation.js';
import { NativePathObserver } from './shadow/pricePath.js';
import { PumpfunVolumeService } from './volume/pumpfunVolumeService.js';
import { NativeFirstAggregator, NativeFirstPriceSource } from './orchestrator/nativeFirst.js';

async function main(): Promise<void> {
  assertHardRiskUnmodified();

  const cfg = loadConfig();
  const logger = createLogger(cfg.logging);

  logger.info(
    { dryRun: cfg.dryRun, strategyVersion: cfg.strategyVersion, hardRisk: HARD_RISK_PARAMETERS },
    'starting New-Token Ultra Scalper V1 (Phase 1: foundational core)',
  );

  if (!cfg.dryRun) {
    logger.fatal('DRY_RUN=false but live execution is not implemented in this pass. Refusing to start.');
    process.exit(1);
  }

  // Phase 5.6A: every RPC and quote request goes through the provider layer (limits, retries, timeouts, circuit
  // breaking, explicit fallbacks, shutdown abort). The safety gate itself is unchanged.
  const providers = createProviderStack(cfg, logger);
  const { connection, jupiter: jupiterClient } = providers;
  const dexAggregator = new DexscreenerBirdeyeAggregator(cfg.aggregators, logger);

  const db = openLedger(cfg.ledger.dbPath);
  const metricsRecorder = new ProviderMetricsRecorder(providers.metrics, db, logger, cfg.providers.metricsLogIntervalMs);
  metricsRecorder.start();
  const ledger = new TradeLedger(db);
  const emergencyStop = new EmergencyStop();

  // Phase 5.4B/5.5: native Pump.fun market data (volume, and -- when nativeMarketEnabled -- price, real-SOL liquidity
  // and exact price impact) from the ONE Pump.fun log subscription below: no second subscription, no per-trade or
  // per-token RPC. Read-only; disabled => exactly the previous behavior.
  const volumeService = cfg.volume.pumpfunNativeEnabled
    ? new PumpfunVolumeService({
        engine: { program: cfg.discovery.pumpFunProgramId, silenceMs: cfg.volume.streamSilenceMs, maxSnapshotSkewSec: cfg.volume.nativeMaxSnapshotSkewSec },
        db: cfg.volume.recordTradeEvents ? db : undefined,
        recordRetentionHours: cfg.volume.tradeEventRetentionHours,
        logger,
      })
    : null;
  const nativeMarket = volumeService && cfg.volume.nativeMarketEnabled ? volumeService : null;
  logger.info(
    {
      PUMPFUN_NATIVE_VOLUME: cfg.volume.pumpfunNativeEnabled,
      RECORD_TRADE_EVENTS: cfg.volume.pumpfunNativeEnabled && cfg.volume.recordTradeEvents,
      PUMPFUN_NATIVE_MARKET: nativeMarket !== null,
      DEXSCREENER_FALLBACK_FOR_CURVE_TOKENS: cfg.volume.dexscreenerFallbackForCurveTokens,
    },
    'native market source',
  );
  // null unless SHADOW_TRADING_ENABLED=true. The price-path recorder observes the native in-memory cache only.
  const shadow = createShadowActivation(cfg, db, logger, nativeMarket ? new NativePathObserver(nativeMarket) : undefined);
  volumeService?.attachConnectionHooks(connection);
  volumeService?.start();

  // Consumers other than the evaluation loop (dry-run executor, position monitor) follow the same source priority.
  const basePriceSource = new MarketPriceSource(dexAggregator, jupiterClient, { recordQuoteFetches: cfg.shadow.enabled });
  // recordQuoteFetches only when shadow is enabled: lets shadow observe the read-only quote the loop already requests (no extra request).
  const aggregator = nativeMarket ? new NativeFirstAggregator(dexAggregator, nativeMarket) : dexAggregator;
  const priceSource = nativeMarket ? new NativeFirstPriceSource(basePriceSource, nativeMarket) : basePriceSource;
  const executor = cfg.dryRun
    ? new DryRunExecutor(priceSource, cfg, logger)
    : new LiveExecutorStub(new NullSigner(), jupiterClient, connection);

  const discoverySources = [
    new RaydiumLogSubscriber(connection, { programId: cfg.discovery.raydiumProgramId }, logger),
    new PumpFunLogSubscriber(
      connection,
      { programId: cfg.discovery.pumpFunProgramId, logTap: volumeService ? (n) => volumeService.onLogNotification(n) : undefined },
      logger,
    ),
  ];

  const stopOrchestrator = await startOrchestrator(cfg, {
    discoverySources,
    aggregator,
    connection,
    executor,
    priceSource,
    jupiterClient,
    ledger,
    logger,
    emergencyStop,
    shadowRunner: shadow?.runner,
    volumeProvider: volumeService ?? undefined,
    nativeMarket: nativeMarket ?? undefined,
    allowDexscreenerFallback: cfg.volume.dexscreenerFallbackForCurveTokens,
    safetyData: providers.safetyData,
    providerMetrics: providers.metrics,
    shutdownStepTimeoutMs: cfg.providers.shutdownStepTimeoutMs,
  });

  logger.info('orchestrator running. Press Ctrl+C to stop.');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // Every step is bounded: a hung dependency is reported and skipped, never allowed to block termination.
    const reports = await runShutdown(
      [
        { name: 'stop_orchestrator', run: stopOrchestrator, timeoutMs: cfg.providers.shutdownStepTimeoutMs * 3 },
        { name: 'abort_provider_requests', run: () => providers.shutdown() },
        { name: 'stop_price_paths', run: () => shadow?.pathRecorder?.stop() },
        { name: 'stop_volume_service', run: () => volumeService?.stop() },
        { name: 'flush_provider_metrics', run: () => metricsRecorder.stop() },
        { name: 'close_ledger', run: () => db.close() },
      ],
      { stepTimeoutMs: cfg.providers.shutdownStepTimeoutMs },
    );
    logger.info({ reports }, 'shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal error during startup', err);
  process.exit(1);
});
