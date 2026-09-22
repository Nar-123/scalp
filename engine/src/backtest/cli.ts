#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openLedger } from '../ledger/db.js';
import { TradeLedger } from '../ledger/tradeLedger.js';
import { ConfigSchema, type AppConfig } from '../config/schema.js';
import { getDefaultConfig } from '../config/defaults.js';
import { DEFAULT_SIMULATOR_VERSION } from './types.js';
import type { SimulationAssumptions } from './types.js';
import { groupSnapshotsByMint } from './snapshotAdapter.js';
import { runReplay } from './replayEngine.js';

/**
 * Subprocess bridge so the Python learning package (which owns the actual
 * scheduling/candidate-generation/promotion-gate logic -- see
 * python/learning/backtest_bridge.py) can run a backtest through THIS
 * project's real, single TypeScript replay engine instead of re-implementing
 * fee/risk/exit logic in Python (spec section 14/16: no separate
 * incompatible implementation). Reads everything from argv + stdin/files,
 * writes exactly one JSON object to stdout, and never touches the network
 * or prompts for input -- safe to call from a non-interactive subprocess.
 *
 * Usage:
 *   node dist/backtest/cli.js --db <ledger.sqlite path> --label <string>
 *     [--strategy-version <string>] [--config <path to tunable-overrides JSON>]
 *
 * The overrides file may set ONLY the six tunable groups (discovery,
 * filters, scoring, exits, reentry, risk) -- anything else (edge, execution,
 * rpc, or any hard-risk-parameter-shaped key) is rejected before a replay
 * ever runs, so a Python-generated candidate structurally cannot smuggle a
 * hard-parameter change through this bridge.
 */

const ALLOWED_OVERRIDE_GROUPS = new Set(['discovery', 'filters', 'scoring', 'exits', 'reentry', 'risk']);

interface CliArgs {
  dbPath: string;
  label: string;
  strategyVersion?: string;
  configPath?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--db') { args.dbPath = value; i += 1; }
    else if (flag === '--label') { args.label = value; i += 1; }
    else if (flag === '--strategy-version') { args.strategyVersion = value; i += 1; }
    else if (flag === '--config') { args.configPath = value; i += 1; }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.dbPath) throw new Error('--db is required');
  if (!args.label) throw new Error('--label is required');
  return args as CliArgs;
}

export function loadStrategyOverrides(configPath: string | undefined): Record<string, unknown> {
  if (!configPath) return {};
  const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('--config file must contain a JSON object');
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!ALLOWED_OVERRIDE_GROUPS.has(key)) {
      throw new Error(
        `--config may only override ${[...ALLOWED_OVERRIDE_GROUPS].join(', ')}; got disallowed key "${key}". ` +
          'Hard risk parameters and execution/edge/rpc settings can never be overridden through the backtest bridge.',
      );
    }
  }
  return raw as Record<string, unknown>;
}

export function buildStrategyConfig(overrides: Record<string, unknown>): Pick<AppConfig, 'discovery' | 'filters' | 'scoring' | 'exits' | 'reentry' | 'risk'> {
  const base = getDefaultConfig();
  const merged = ConfigSchema.parse({
    rpc: base.rpc,
    discovery: { ...base.discovery, ...(overrides.discovery as object | undefined) },
    filters: { ...base.filters, ...(overrides.filters as object | undefined) },
    scoring: {
      ...base.scoring,
      ...(overrides.scoring as object | undefined),
      weights: { ...base.scoring.weights, ...((overrides.scoring as { weights?: object } | undefined)?.weights) },
    },
    exits: { ...base.exits, ...(overrides.exits as object | undefined) },
    reentry: { ...base.reentry, ...(overrides.reentry as object | undefined) },
    risk: { ...base.risk, ...(overrides.risk as object | undefined) },
  });
  return {
    discovery: merged.discovery,
    filters: merged.filters,
    scoring: merged.scoring,
    exits: merged.exits,
    reentry: merged.reentry,
    risk: merged.risk,
  };
}

export function buildAssumptions(cfg: AppConfig): SimulationAssumptions {
  return {
    edge: cfg.edge,
    fallbackPriceImpactPct: cfg.execution.fallbackPriceImpactPct,
    latencySlippageBufferPct: cfg.execution.latencySlippageBufferPct,
    simulatorVersion: DEFAULT_SIMULATOR_VERSION,
  };
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const overrides = loadStrategyOverrides(args.configPath);
  const strategyConfig = buildStrategyConfig(overrides);
  const fullDefaultConfig = getDefaultConfig();

  const db = openLedger(args.dbPath);
  const ledger = new TradeLedger(db);
  const records = ledger.getEvaluationsForReplay(args.strategyVersion);
  const snapshotsByMint = groupSnapshotsByMint(records);

  const result = runReplay(snapshotsByMint, strategyConfig, buildAssumptions(fullDefaultConfig), args.label);
  process.stdout.write(JSON.stringify(result));
}

const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectlyExecuted) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`backtest-cli-error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
