import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { AggregatorClient, TokenDiscoverySource } from '../../src/discovery/types.js';
import { DryRunExecutor } from '../../src/execution/dryRunExecutor.js';
import type { PriceSource } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { NativeFirstAggregator, NativeFirstPriceSource } from '../../src/orchestrator/nativeFirst.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';
import { PumpfunVolumeService } from '../../src/volume/pumpfunVolumeService.js';
import { CurveSim, LAG_MS, createPayload, mintId, notification, patchTrade, realTradePayload } from '../volume/helpers.js';

// ONLY the safety gate is replaced (it needs live RPC + Jupiter, which a unit-level integration test cannot have).
// Everything else is the real production wiring: native market data, filters, edge, risk, dry-run executor, position
// monitor, ledger and shadow runner. This proves the deterministic pipeline downstream of safety; it does NOT prove the
// safety gate itself (covered by its own tests and by the live run, where it rejected tokens).
vi.mock('../../src/safety/safetyGate.js', () => ({
  runSafetyGate: vi.fn(async () => ({ passed: true, reasons: [], details: {}, mintAuthorityRenounced: true, freezeAuthorityRenounced: true, top10HolderPct: 12, liquiditySol: 30 })),
}));

const noop = () => undefined;
const logged: string[] = [];
const logger = { info: noop, warn: (...a: unknown[]) => logged.push('W ' + JSON.stringify(a)), error: (...a: unknown[]) => logged.push('E ' + JSON.stringify(a)), debug: noop, fatal: noop, trace: noop, child: () => logger } as never;
// Phase 5.6H: the edge gate prices a complete round trip at the curve's real 125 bps fee per leg, so the strategy's expected move (quick take-profit)
// must exceed the break-even move for an entry to be favorable. The exit levels are raised for THIS test only (production values are untouched).
const cfg = getDefaultConfig({ shadow: { enabled: true }, exits: { quickTpMinPct: 6, quickTpMaxPct: 8, momentumTpMinPct: 9, momentumTpMaxPct: 12 } });
const MINT = mintId(555);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('real loop, real native market data, real dry-run executor and position monitor (safety gate stubbed)', () => {
  it('a token passing V1 goes discovery -> filters -> edge -> entry -> position -> exit -> ledger, with reproducible context and a SELL-priced exit', async () => {
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
    // The token's own history is recent, so it stays inside the current 60 s window for the whole test and the previous window is empty.
    send(createPayload(MINT, end - 24));
    step(sim.buy(9_000_000_000n), end - 22);
    step(sim.buy(7_000_000_000n), end - 18);
    step(sim.buy(6_000_000_000n), end - 14);
    step(sim.sell(20_000_000_000_000n), end - 10);
    for (let t = end - 59; t <= end; t += 1) send(patchTrade(realTradePayload('sol_buy'), { mint: mintId(9999), solLamports: 1_000_000, timestampSec: t }));
    const fresh = () => Math.floor(Date.now() / 1000) - 1;

    // Base (DexScreener/Jupiter) sources must never be consulted for a valid curve token.
    const baseCalls = { n: 0 };
    const baseAgg: AggregatorClient = { getLiquidityAndVolume: async () => (baseCalls.n++, null), getHolderConcentration: async () => null, getPrice: async () => (baseCalls.n++, null) };
    const basePrice: PriceSource = {
      getPrice: async () => (baseCalls.n++, null),
      getEstimatedPriceImpactPct: async () => (baseCalls.n++, null),
      getBuyExecutionQuote: async () => (baseCalls.n++, null),
      getSellPriceImpactPct: async () => (baseCalls.n++, null),
    };
    const aggregator = new NativeFirstAggregator(baseAgg, service);
    const priceSource = new NativeFirstPriceSource(basePrice, service);
    const executor = new DryRunExecutor(priceSource, cfg, logger);
    const activation = createShadowActivation(cfg, db, logger)!;

    let emit: (e: DiscoveredTokenEvent) => void = noop;
    const source: TokenDiscoverySource = { name: 'fake', async start(cb) { emit = cb; }, async stop() {} };
    const stop = await startOrchestrator(cfg, {
      discoverySources: [source],
      aggregator,
      connection: { getAccountInfo: async () => null } as never,
      executor,
      priceSource,
      jupiterClient: { getRoundTripQuote: async () => null } as never,
      ledger,
      logger,
      shadowRunner: activation.runner,
      volumeProvider: service,
      nativeMarket: service,
    });
    emit({ mint: MINT, poolAddress: null, source: 'pumpfun', createdAtSlot: 1, createdAtMs: Date.now() - 60_000, initialLiquiditySol: null });

    // The 5 s velocity compares the price now with the price at the newest evaluation that is >= 5 s old, so the price must keep
    // rising: a real stream of small buys arrives once a second (each ~ +1 %).
    await sleep(1200);
    const priceBefore = service.getNativeMarketSnapshot(MINT, 0.3).priceSol as number;
    const feeder = setInterval(() => step(sim.buy(300_000_000n), fresh()), 1000);
    let entered = false;
    for (let i = 0; i < 100 && !entered; i += 1) {
      await sleep(200);
      entered = (db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c > 0;
    }
    const why = () => JSON.stringify((db.prepare('SELECT evaluated_at_ms t, price_sol p, price_velocity_5s_pct v, safety_reasons r FROM token_evaluations ORDER BY evaluated_at_ms LIMIT 12').all() as unknown[]));
    if (!entered) clearInterval(feeder);
    expect(entered, `the token should have been entered; last evaluations: ${why()} LOG: ${logged.slice(0, 4).join(' | ')}`).toBe(true);
    const trade = db.prepare('SELECT * FROM trades').get() as Record<string, unknown>;
    expect(trade.dry_run).toBe(1);
    // regression (found by this test): the evaluation row must be written BEFORE the trade that references it (foreign key),
    // and then linked to it
    const linked = db.prepare('SELECT id, led_to_trade_id FROM token_evaluations WHERE id = ?').get(trade.entry_safety_check_id as string) as { id: string; led_to_trade_id: string } | undefined;
    expect(linked?.led_to_trade_id).toBe(trade.id);

    // reproducible decision context, all sourced from the native snapshot the decision used
    const ctx = JSON.parse(trade.entry_context_json as string);
    expect(ctx).toMatchObject({ mint: MINT, marketSource: 'pumpfun_native', entryDecision: 'enter', safetyPassed: true, strategyVersion: cfg.strategyVersion });
    for (const k of ['priceSol', 'liquiditySol', 'volume1mSol', 'buyVolume1mSol', 'sellVolume1mSol', 'buySellRatio', 'priceVelocity5sPct', 'volumeAccelerationX', 'buyPriceImpactPct', 'sellPriceImpactPct', 'expectedNetEdgePct', 'entryScore', 'marketDataAsOfSec', 'volumeWindowEndSec', 'stateEventSec', 'discoveredAtMs']) expect(ctx[k], k).not.toBeUndefined();
    expect(ctx.liquiditySol).toBeGreaterThanOrEqual(20);
    expect(ctx.volume1mSol).toBeGreaterThanOrEqual(5);
    expect(ctx.priceVelocity5sPct).toBeGreaterThanOrEqual(1);
    expect(ctx.buyPriceImpactPct).toBeLessThanOrEqual(1);
    expect(ctx.expectedNetEdgePct).toBeGreaterThan(0); // the fee-aware edge was computed and favorable
    expect(ctx.sellPriceImpactPct).not.toBe(ctx.buyPriceImpactPct);
    expect(Math.abs((ctx.marketDataAsOfSec as number) - (ctx.volumeWindowEndSec as number))).toBeLessThanOrEqual(5);
    expect(trade.entry_token_amount_raw).toBeTruthy();
    expect(trade.entry_price_sol as number).toBeGreaterThan(priceBefore * 0.99);
    expect(trade.expected_net_edge_pct as number).toBeGreaterThan(0);

    // price rises past the quick take-profit: the monitor sells with the SELL-direction curve impact
    const entryPrice = trade.entry_price_sol as number; // the feeder keeps buying, so the price climbs past the quick take-profit
    let closed: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && !closed; i += 1) {
      await sleep(200);
      const row = db.prepare("SELECT * FROM trades WHERE status = 'closed'").get() as Record<string, unknown> | undefined;
      closed = row;
    }
    clearInterval(feeder);
    expect(closed, 'the position should have been closed').toBeDefined();
    expect(closed!.exit_reason).toBe('quick_tp');
    const ex = JSON.parse(closed!.exit_context_json as string);
    expect(ex.exitReason).toBe('quick_tp');
    expect(ex.sellPriceImpactPct).toBeGreaterThan(0);
    expect(ex.sellPriceImpactPct).not.toBe(ctx.buyPriceImpactPct);
    expect(ex.exitPriceSol).toBeGreaterThanOrEqual(entryPrice * 1.02);
    expect(ex.grossPnlSol).toBeGreaterThan(0);
    expect(ex.netPnlSol).toBeCloseTo(closed!.pnl_sol as number, 10);
    expect(ex.netPnlSol).toBeLessThan(ex.grossPnlSol); // fees + impact + slippage cost something
    expect(ex.exitFeesSol).toBeGreaterThan(0);
    expect(closed!.hold_duration_ms as number).toBeGreaterThan(0);
    expect(baseCalls.n).toBe(0); // never a DexScreener/Jupiter call for a valid Pump.fun curve token, on entry OR exit

    // shadow saw the same entry (same decision context) and its ledger is separate from production
    const sh = db.prepare('SELECT * FROM shadow_trades').all() as Array<Record<string, unknown>>;
    expect(sh.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(sh[0]!.entry_context_json as string)).toMatchObject({ marketSource: 'pumpfun_native', entryDecision: 'enter' });
    expect(sh[0]!.entry_token_amount_raw).toBeTruthy();

    await stop();
    service.stop();
  }, 60_000);
});
