import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAssumptions, buildStrategyConfig, loadStrategyOverrides, main, parseArgs } from '../../src/backtest/cli.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import type { TokenEvaluationRecord } from '../../src/types/trade.js';

function makeEvaluation(overrides: Partial<TokenEvaluationRecord>): TokenEvaluationRecord {
  return {
    id: `eval_${Math.random().toString(36).slice(2)}`,
    mint: 'MINT_A',
    poolAddress: null,
    discoverySource: 'raydium',
    discoveredAtMs: 0,
    evaluatedAtMs: 40_000,
    tokenAgeSec: 40,
    safetyPassed: true,
    safetyReasons: [],
    mintAuthorityRenounced: true,
    freezeAuthorityRenounced: true,
    top10HolderPct: 20,
    priceSol: 1,
    liquiditySol: 40,
    volume1mSol: 10,
    buySellRatio: 2,
    priceVelocity5sPct: 5,
    volumeAccelerationX: 2,
    txCount1m: 30,
    estimatedPriceImpactPct: 0.2,
    estimatedSellPriceImpactPct: 0.2,
    entryScore: 5,
    entryScoreComponents: null,
    expectedNetEdgePct: 1,
    expectedNetEdgeBreakdown: null,
    riskAllowed: true,
    riskRejectReasons: [],
    ledToTradeId: null,
    strategyVersion: 'baseline-v1',
    ...overrides,
  };
}

describe('backtest CLI helpers', () => {
  it('parseArgs reads required and optional flags', () => {
    const args = parseArgs(['--db', 'ledger.sqlite', '--label', 'baseline-v1', '--strategy-version', 'v2', '--config', 'overrides.json']);
    expect(args).toEqual({ dbPath: 'ledger.sqlite', label: 'baseline-v1', strategyVersion: 'v2', configPath: 'overrides.json' });
  });

  it('parseArgs throws when a required flag is missing', () => {
    expect(() => parseArgs(['--label', 'x'])).toThrow('--db is required');
    expect(() => parseArgs(['--db', 'x'])).toThrow('--label is required');
  });

  it('parseArgs throws on an unknown flag', () => {
    expect(() => parseArgs(['--db', 'x', '--label', 'y', '--bogus', 'z'])).toThrow('Unknown argument');
  });

  it('loadStrategyOverrides returns {} when no --config path is given', () => {
    expect(loadStrategyOverrides(undefined)).toEqual({});
  });

  it('loadStrategyOverrides rejects a disallowed top-level key (structural hard-parameter protection)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scalp-cli-test-'));
    const path = join(dir, 'overrides.json');
    writeFileSync(path, JSON.stringify({ risk: { dailyStartingBalanceSol: 5 }, edge: { dexFeeBps: 0 } }));
    expect(() => loadStrategyOverrides(path)).toThrow(/disallowed key "edge"/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildStrategyConfig merges only the requested overrides on top of defaults', () => {
    const cfg = buildStrategyConfig({ filters: { minLiquiditySol: 999 } });
    expect(cfg.filters.minLiquiditySol).toBe(999);
    expect(cfg.filters.minVolume1mSol).toBe(getDefaultConfig().filters.minVolume1mSol); // untouched fields keep their default
    expect(cfg.discovery).toEqual(getDefaultConfig().discovery);
  });

  it('buildAssumptions derives simulation assumptions from the app config', () => {
    const assumptions = buildAssumptions(getDefaultConfig());
    expect(assumptions.edge).toEqual(getDefaultConfig().edge);
    expect(assumptions.fallbackPriceImpactPct).toBe(getDefaultConfig().execution.fallbackPriceImpactPct);
    expect(assumptions.latencySlippageBufferPct).toBe(getDefaultConfig().execution.latencySlippageBufferPct);
  });
});

describe('backtest CLI end-to-end (real ledger file, no subprocess)', () => {
  let dir: string;
  let dbPath: string;
  let originalArgv: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-cli-e2e-'));
    dbPath = join(dir, 'ledger.sqlite');
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    try {
      // main() opens its own node:sqlite handle on dbPath and this test never
      // gets a reference to close it -- on Windows the file (and thus its
      // parent temp dir) can stay locked briefly after the test body returns.
      // Harmless to leave behind (OS temp cleanup reclaims it eventually);
      // never let that racy cleanup fail the test itself.
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  });

  it('reads evaluations from the ledger, replays them, and prints one JSON result to stdout', () => {
    const db = openLedger(dbPath);
    const ledger = new TradeLedger(db);
    ledger.recordEvaluation(makeEvaluation({ evaluatedAtMs: 40_000, priceSol: 1 }));
    ledger.recordEvaluation(makeEvaluation({ id: 'eval_2', evaluatedAtMs: 42_000, priceSol: 1.06 }));
    db.close();

    // Phase 5.6H: the edge gate now prices a complete round trip, so a 2 % expected move does not clear the production cost schedule (the
    // `edge` block cannot be overridden through the bridge). This test is about the CLI plumbing, so the strategy's expected move is raised.
    const configPath = join(dir, 'overrides.json');
    writeFileSync(configPath, JSON.stringify({ exits: { quickTpMinPct: 5, quickTpMaxPct: 6 } }));
    process.argv = [process.argv[0]!, process.argv[1]!, '--db', dbPath, '--label', 'baseline-v1', '--config', configPath];
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    main();

    expect(writes).toHaveLength(1);
    const result = JSON.parse(writes[0]!);
    expect(result.status).toBe('completed');
    expect(result.strategyLabel).toBe('baseline-v1');
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('quick_tp');
  });

  it('applies a --config override so a candidate with tighter filters takes no trades', () => {
    const db = openLedger(dbPath);
    const ledger = new TradeLedger(db);
    ledger.recordEvaluation(makeEvaluation({ evaluatedAtMs: 40_000, priceSol: 1 }));
    ledger.recordEvaluation(makeEvaluation({ id: 'eval_2', evaluatedAtMs: 42_000, priceSol: 1.03 }));
    db.close();

    const overridesPath = join(dir, 'overrides.json');
    writeFileSync(overridesPath, JSON.stringify({ filters: { minLiquiditySol: 1000 } }));

    process.argv = [process.argv[0]!, process.argv[1]!, '--db', dbPath, '--label', 'candidate-tight', '--config', overridesPath];
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    main();

    const result = JSON.parse(writes[0]!);
    expect(result.trades).toHaveLength(0);
  });
});
