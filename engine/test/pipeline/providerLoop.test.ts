import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { AggregatorClient, TokenDiscoverySource } from '../../src/discovery/types.js';
import { DryRunExecutor } from '../../src/execution/dryRunExecutor.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { NativeFirstAggregator, NativeFirstPriceSource } from '../../src/orchestrator/nativeFirst.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';
import type { FetchOutcome, SafetyDataSource } from '../../src/safety/dataSource.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';
import { deriveCurveAndVault } from '../../src/safety/bondingCurveVault.js';
import { PumpfunVolumeService } from '../../src/volume/pumpfunVolumeService.js';
import { CurveSim, LAG_MS, createPayload, mintId, notification, patchTrade, realTradePayload } from '../volume/helpers.js';

// PRODUCTION-LOOP INTEGRATION (Phase 5.6A). The REAL safety gate runs (it is NOT mocked here): only its external data
// providers are replaced by scripted ones, so what is exercised is exactly how the real gate + loop react to provider
// failures, stale data and healthy data. The market stream is a SYNTHETIC bonding curve (labelled as such): this proves
// the pipeline wiring, it is not a mainnet result.

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;
// Phase 5.6H: the edge gate prices a complete round trip at the curve's real 125 bps fee per leg, so the strategy's expected move (quick take-profit)
// must exceed the break-even move for an entry to be favorable. The exit levels are raised for THIS test only (production values are untouched).
const cfg = getDefaultConfig({ shadow: { enabled: false }, exits: { quickTpMinPct: 6, quickTpMaxPct: 8, momentumTpMinPct: 9, momentumTpMaxPct: 12 } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const healthyMint = { mint: 'm', mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000n, decimals: 6 };

function data(over: { holders: () => FetchOutcome<{ address: string; amount: bigint }[]>; mint?: () => FetchOutcome<typeof healthyMint> }): SafetyDataSource {
  return {
    getMintSummary: async () => (over.mint ? over.mint() : { value: healthyMint, failure: null, asOfMs: Date.now() }),
    getLargestHolders: async () => over.holders(),
    // Phase 5.6E: the scripted mints have no Pump.fun bonding curve on chain (both accounts missing)
    getBondingCurveAccounts: async (mint: string) => {
      const { curvePda, vaultAta } = deriveCurveAndVault(mint, 'spl-token');
      return { value: { curveAddress: curvePda.toBase58(), vaultAddress: vaultAta.toBase58(), curve: null, vault: null }, failure: null, asOfMs: Date.now() };
    },
    getTokenAccountOwners: async () => ({ value: {}, failure: null, asOfMs: Date.now() }),
  } as never;
}

const goodHolders = () => ({ value: [{ address: 'h1', amount: 1000n }], failure: null, asOfMs: Date.now() });

async function harness(mintN: number, safetyData: SafetyDataSource, roundTrip: () => Promise<unknown>) {
  const MINT = mintId(mintN);
  const db = openLedger(':memory:');
  const ledger = new TradeLedger(db);
  const service = new PumpfunVolumeService({ db, watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0, engine: { silenceMs: 3_600_000 } });
  const end = Math.floor(Date.now() / 1000) - 2;
  service.start((end - 300) * 1000);
  const send = (payload: Buffer): void => service.onLogNotification(notification([payload], { receivedAtMs: Date.now() - LAG_MS }));
  const sim = new CurveSim();
  const step = (s: ReturnType<CurveSim['buy']> | ReturnType<CurveSim['sell']>, ts: number): void =>
    send(patchTrade(realTradePayload(s.isBuy ? 'sol_buy' : 'sol_sell'), { mint: MINT, solLamports: s.solLamports, tokenAmount: s.tokenAmount, isBuy: s.isBuy, timestampSec: ts, curve: s.curve }));
  for (let t = end - 200; t <= end - 60; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  send(createPayload(MINT, end - 24));
  step(sim.buy(9_000_000_000n), end - 22);
  step(sim.buy(7_000_000_000n), end - 18);
  step(sim.buy(6_000_000_000n), end - 14);
  step(sim.sell(20_000_000_000_000n), end - 10);
  for (let t = end - 59; t <= end; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
  const fresh = () => Math.floor(Date.now() / 1000) - 1;

  const baseAgg: AggregatorClient = { getLiquidityAndVolume: async () => null, getHolderConcentration: async () => null, getPrice: async () => null };
  const basePrice: PriceSource = { getPrice: async () => null, getEstimatedPriceImpactPct: async () => null, getBuyExecutionQuote: async () => null, getSellPriceImpactPct: async () => null };
  const aggregator = new NativeFirstAggregator(baseAgg, service);
  const priceSource = new NativeFirstPriceSource(basePrice, service);
  const executor = new DryRunExecutor(priceSource, cfg, logger);
  const providerMetrics = new ProviderMetrics();
  let emit: (e: DiscoveredTokenEvent) => void = noop;
  const source: TokenDiscoverySource = { name: 'fake', async start(cb) { emit = cb; }, async stop() {} };
  const stop = await startOrchestrator(cfg, {
    discoverySources: [source],
    aggregator,
    connection: {} as never,
    executor,
    priceSource,
    jupiterClient: { getRoundTripQuote: roundTrip } as never,
    ledger,
    logger,
    volumeProvider: service,
    nativeMarket: service,
    safetyData,
    providerMetrics,
  });
  emit({ mint: MINT, poolAddress: null, source: 'pumpfun', createdAtSlot: 1, createdAtMs: Date.now() - 60_000, initialLiquiditySol: null });
  await sleep(1200);
  const feeder = setInterval(() => step(sim.buy(300_000_000n), fresh()), 1000);
  const finish = async () => {
    clearInterval(feeder);
    await stop();
    service.stop();
  };
  const trades = () => (db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c;
  const reasons = () => (db.prepare('SELECT safety_reasons r FROM token_evaluations WHERE safety_passed = 0').all() as Array<{ r: string }>).map((x) => x.r).join(' ');
  return { db, trades, reasons, providerMetrics, finish };
}

describe('production loop with the REAL safety gate and scripted providers (synthetic curve)', () => {
  it('provider failure (holders rate limited) => fail closed: no entry, holder_data_unavailable recorded, and the provider cause is observable', async () => {
    const h = await harness(701, data({ holders: () => ({ value: null, failure: { kind: 'provider', reason: 'rate_limited' }, asOfMs: Date.now() }) }), async () => ({ asOfMs: Date.now(), buyPriceImpactPct: 0.4, sellPriceImpactPct: 0.5 }));
    for (let i = 0; i < 40 && !h.reasons().includes('holder_data_unavailable'); i += 1) await sleep(250);
    const reasons = h.reasons();
    const trades = h.trades();
    const snap = h.providerMetrics.snapshot().safetyUnavailable;
    await h.finish();
    expect(reasons).toContain('holder_data_unavailable');
    expect(trades).toBe(0);
    expect(snap['holders:provider:rate_limited']).toBeGreaterThan(0);
  }, 30_000);

  it('quote provider unavailable => quote_unavailable (fail closed), never a default impact and never an entry', async () => {
    const h = await harness(702, data({ holders: goodHolders }), async () => null);
    for (let i = 0; i < 40 && !h.reasons().includes('quote_unavailable'); i += 1) await sleep(250);
    const reasons = h.reasons();
    const trades = h.trades();
    const snap = h.providerMetrics.snapshot().safetyUnavailable;
    await h.finish();
    expect(reasons).toContain('quote_unavailable');
    expect(trades).toBe(0);
    expect(Object.keys(snap).some((k) => k.startsWith('quote:'))).toBe(true);
  }, 30_000);

  it('a safety verdict built from data older than the 10 s decision bound is rejected (stale_safety_data_at_decision)', async () => {
    const stale = () => ({ value: [{ address: 'h1', amount: 1000n }], failure: null, asOfMs: Date.now() - 30_000 });
    const h = await harness(703, data({ holders: stale }), async () => ({ asOfMs: Date.now(), buyPriceImpactPct: 0.4, sellPriceImpactPct: 0.5 }));
    for (let i = 0; i < 40 && !h.reasons().includes('stale_safety_data_at_decision'); i += 1) await sleep(250);
    const reasons = h.reasons();
    const trades = h.trades();
    await h.finish();
    expect(reasons).toContain('stale_safety_data_at_decision');
    expect(trades).toBe(0);
  }, 30_000);

  it('healthy providers: the normal loop reaches safety PASS and a simulated entry (proves the wiring, on a synthetic curve)', async () => {
    const h = await harness(704, data({ holders: goodHolders }), async () => ({ asOfMs: Date.now(), buyPriceImpactPct: 0.4, sellPriceImpactPct: 0.5 }));
    for (let i = 0; i < 60 && h.trades() === 0; i += 1) await sleep(250);
    const trades = h.trades();
    const dry = (h.db.prepare('SELECT dry_run d FROM trades').get() as { d: number } | undefined)?.d;
    await h.finish();
    expect(trades).toBeGreaterThan(0);
    expect(dry).toBe(1);
  }, 40_000);
});
