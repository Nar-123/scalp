import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { assertHardRiskUnmodified, HARD_RISK_PARAMETERS } from './config/hardRisk.js';
import { loadConfig } from './config/loader.js';
import { createLogger } from './logging/logger.js';
import { DexscreenerBirdeyeAggregator } from './discovery/aggregatorFallbackClient.js';
import { RaydiumLogSubscriber } from './discovery/raydiumLogSubscriber.js';
import { PumpFunLogSubscriber } from './discovery/pumpFunLogSubscriber.js';
import { JupiterQuoteClient } from './execution/jupiterQuoteClient.js';
import { MarketPriceSource } from './execution/marketPriceSource.js';
import { DryRunExecutor } from './execution/dryRunExecutor.js';
import { LiveExecutorStub } from './execution/liveExecutorStub.js';
import { NullSigner } from './execution/signer/nullSigner.js';
import { openLedger } from './ledger/db.js';
import { TradeLedger } from './ledger/tradeLedger.js';
import { EmergencyStop } from './risk/emergencyStop.js';
import { startOrchestrator } from './orchestrator/loop.js';

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

  const connection = new Connection(cfg.rpc.httpUrl, { wsEndpoint: cfg.rpc.wsUrl, commitment: 'confirmed' });
  const aggregator = new DexscreenerBirdeyeAggregator(cfg.aggregators, logger);
  const jupiterClient = new JupiterQuoteClient(cfg.aggregators, logger);
  const priceSource = new MarketPriceSource(aggregator, jupiterClient);
  const executor = cfg.dryRun
    ? new DryRunExecutor(priceSource, cfg, logger)
    : new LiveExecutorStub(new NullSigner(), jupiterClient, connection);

  const db = openLedger(cfg.ledger.dbPath);
  const ledger = new TradeLedger(db);
  const emergencyStop = new EmergencyStop();

  const discoverySources = [
    new RaydiumLogSubscriber(connection, { programId: cfg.discovery.raydiumProgramId }, logger),
    new PumpFunLogSubscriber(connection, { programId: cfg.discovery.pumpFunProgramId }, logger),
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
  });

  logger.info('orchestrator running. Press Ctrl+C to stop.');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await stopOrchestrator();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal error during startup', err);
  process.exit(1);
});
