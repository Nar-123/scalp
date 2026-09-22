import type { DatabaseSync } from 'node:sqlite';
import type { SimulationAssumptions } from '../backtest/types.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { PricePathRecorder, PricePathStore, type PathObserver } from './pricePath.js';
import { ShadowLedger } from './shadowLedger.js';
import { ShadowRunner } from './shadowRunner.js';
import { HealthCounters } from './shadowStatus.js';

/** Recorded on every shadow trade so shadow results are never confused with a backtest's. */
export const SHADOW_SIMULATOR_VERSION = 'shadow-realtime-v2';

export interface ShadowActivation {
  runner: ShadowRunner;
  ledger: ShadowLedger;
  health: HealthCounters;
  strategyVersion: string;
  /** Phase 5.6H price-path recorder; null when no native market cache is available to observe from. */
  pathRecorder: PricePathRecorder | null;
}

/**
 * Builds the shadow runner ONLY when SHADOW_TRADING_ENABLED=true; otherwise
 * returns null and nothing shadow-related exists at runtime. Read-only by
 * construction: there is no wallet, signer, executor or transaction
 * dependency anywhere in this path, and only V1 (the configured production
 * strategy version) is shadowed -- no candidate strategy is enabled here.
 *
 * Logs exactly the three activation facts and nothing else (no config
 * dump, no URLs, no keys).
 */
export function createShadowActivation(
  cfg: Pick<AppConfig, 'shadow' | 'strategyVersion' | 'discovery' | 'filters' | 'scoring' | 'exits' | 'reentry' | 'risk' | 'edge' | 'execution'>,
  db: DatabaseSync,
  logger: Pick<Logger, 'info'> & Partial<Pick<Logger, 'warn'>>,
  /** Native (in-memory) market cache the price-path recorder observes; absent => no path instrumentation. */
  pathObserver?: PathObserver,
): ShadowActivation | null {
  logger.info(
    {
      SHADOW_ENABLED: cfg.shadow.enabled,
      SHADOW_STRATEGY_VERSION: cfg.shadow.enabled ? cfg.strategyVersion : null,
      SHADOW_MODE: 'READ_ONLY',
    },
    `SHADOW_ENABLED=${cfg.shadow.enabled} SHADOW_STRATEGY_VERSION=${cfg.shadow.enabled ? cfg.strategyVersion : 'none'} SHADOW_MODE=READ_ONLY`,
  );

  if (!cfg.shadow.enabled) return null;

  const ledger = new ShadowLedger(db);
  const health = new HealthCounters((name, by) => ledger.incrementCounter(name, by));
  const assumptions: SimulationAssumptions = {
    edge: cfg.edge,
    fallbackPriceImpactPct: cfg.execution.fallbackPriceImpactPct,
    latencySlippageBufferPct: cfg.execution.latencySlippageBufferPct,
    simulatorVersion: SHADOW_SIMULATOR_VERSION,
  };
  const pathRecorder = pathObserver
    ? new PricePathRecorder({
        store: new PricePathStore(db),
        observer: pathObserver,
        edge: cfg.edge,
        latencySlippageBufferPct: cfg.execution.latencySlippageBufferPct,
        onError: (message) => logger.warn?.({ message }, 'price path instrumentation error (observation only, decisions unaffected)'),
      })
    : null;
  logger.info({ SHADOW_PRICE_PATHS: pathRecorder !== null }, `SHADOW_PRICE_PATHS=${pathRecorder !== null}`);
  const runner = new ShadowRunner({
    ledger,
    strategies: [{ strategyVersion: cfg.strategyVersion, config: cfg }],
    assumptions,
    health,
    lifecycle: pathRecorder ? { onEntry: (e) => pathRecorder.startTrade(e), onExit: (id, x) => pathRecorder.recordExit(id, x) } : undefined,
  });
  return { runner, ledger, health, strategyVersion: cfg.strategyVersion, pathRecorder };
}
