import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';
import type { FillResult } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { PositionMonitor } from '../../src/orchestrator/positionMonitor.js';
import { utcDateString } from '../../src/utils/time.js';

/**
 * Regression suite for a bug found while auditing `positionMonitor.closePosition()`: a sell that FAILED WITHOUT
 * EXECUTING ANYTHING (price/impact/token-amount unavailable, or any other "nothing was sent" failure) was still
 * unconditionally recorded as a closed position with a fabricated realized loss (`filledAmountSol` defaults to 0 on
 * failure, so `pnlSol = 0 - entrySizeSol` books a full-position loss that never happened), the ledger got a fake
 * `execution_safety_failure` exit, realized PnL was applied, and the position was deleted from tracking -- even
 * though nothing was ever sold. The fix: `FillResult.executionOutcome` (see execution/types.ts) is now the single
 * authoritative signal for whether a sell actually happened; only `'executed'` may ever produce a realized exit.
 */

const cfg = getDefaultConfig();
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;

const failed = (error: string, over: Partial<FillResult> = {}, ts = Date.now()): FillResult => ({
  success: false,
  filledPriceSol: 0,
  filledAmountSol: 0,
  feesSol: 0,
  txSignature: null,
  simulated: true,
  timestampMs: ts,
  slippagePct: 0,
  priceImpactPct: 0,
  error,
  ...over,
});
const ok = (over: Partial<FillResult> = {}): FillResult => ({
  success: true,
  filledPriceSol: 1,
  filledAmountSol: 0.28,
  feesSol: 0.001,
  txSignature: null,
  simulated: true,
  timestampMs: Date.now(),
  slippagePct: 0.3,
  priceImpactPct: 0.9,
  ...over,
});

function setup(sellResults: FillResult[]) {
  const db = openLedger(':memory:');
  const ledger = new TradeLedger(db);
  const sells: unknown[] = [];
  const executor = {
    buy: async () => {
      throw new Error('no');
    },
    sell: async (p: unknown) => {
      sells.push(p);
      return sellResults.shift() ?? sellResults.at(-1)!;
    },
  };
  const priceSource = { getPrice: vi.fn().mockResolvedValue(1), getEstimatedPriceImpactPct: vi.fn(), getBuyExecutionQuote: vi.fn(), getSellPriceImpactPct: vi.fn() };
  const aggregator = { getPrice: async () => 1, getHolderConcentration: async () => null, getLiquidityAndVolume: async () => ({ liquiditySol: 40, volume1mSol: 1, buySellRatio: 1, txCount1m: 1 }) };
  const emergencyStop = { isTriggered: () => false, trigger: vi.fn() };
  const monitor = new PositionMonitor(
    { executor, priceSource: priceSource as never, aggregator: aggregator as never, ledger, emergencyStop: emergencyStop as never, logger },
    cfg,
    HARD_RISK_PARAMETERS,
  );
  const now = Date.now();
  ledger.recordEntry({
    id: 't1',
    mint: 'M',
    poolAddress: null,
    strategyVersion: 'v',
    dryRun: true,
    reentryIndex: 0,
    entryTimeMs: now - 60_000,
    entryPriceSol: 1,
    entrySizeSol: 0.3,
    entryTokenAgeSec: 100,
    entryLiquiditySol: 40,
    entryVolume1mSol: 6,
    entryBuySellRatio: 2,
    entryPriceVelocity5sPct: 2,
    entryVolumeAccelerationX: 2,
    entryScore: 5,
    entryScoreComponents: null,
    expectedNetEdgePct: 0.5,
    expectedNetEdgeBreakdown: null,
    entrySlippagePct: 0.3,
    entryPriceImpactPct: 0.4,
    entryFeesSol: 0.001,
    entryTxSignature: null,
    entrySafetyCheckId: null,
    dailyRealizedPnlSolAtEntry: 0,
    entryTokenAmountRaw: '5000000',
  });
  const position = {
    tradeId: 't1',
    mint: 'M',
    poolAddress: null,
    entryTimeMs: now - 60_000,
    entryPriceSol: 1,
    entrySizeSol: 0.3,
    entryFilledAmountSol: 0.29,
    entryTokenAmountRaw: '5000000',
    entryFeesSol: 0.001,
    reentryIndex: 0,
    strategyVersion: 'v',
    dryRun: true,
    priceHistory: [{ priceSol: 1, liquiditySol: 40, timestampMs: now - 60_000 }],
    peakPriceSol: 1,
    troughPriceSol: 1,
  };
  monitor.addPosition(position);
  return { monitor, db, ledger, sells, emergencyStop };
}

type Poller = { pollAll(): Promise<void> };
const poll = (m: PositionMonitor) => (m as unknown as Poller).pollAll();

function tradeRow(ledger: TradeLedger, id = 't1') {
  return ledger['db'].prepare('SELECT * FROM trades WHERE id = ?').get(id) as {
    status: string;
    exit_reason: string | null;
    pnl_sol: number | null;
    exit_context_json: string | null;
  };
}

describe('PositionMonitor: sell that did not execute must never be treated as a realized exit', () => {
  it('successful sell: closes normally with a real exit, real PnL, and the exit context reflects the fill', async () => {
    const { monitor, ledger, emergencyStop } = setup([ok()]);
    await poll(monitor);
    expect(monitor.getOpenCount()).toBe(0);
    expect(emergencyStop.trigger).not.toHaveBeenCalled();
    const row = tradeRow(ledger);
    expect(row.status).toBe('closed');
    expect(row.pnl_sol).toBeCloseTo(0.28 - 0.3, 12);
    const ctx = JSON.parse(row.exit_context_json!);
    expect(ctx.sellPriceImpactPct).toBe(0.9);
    expect(ctx.exitFeesSol).toBe(0.001);
  });

  it('retryable sell failure (data unavailable): position stays open, no exit, no PnL, retried and eventually filled', async () => {
    const { monitor, ledger, sells, emergencyStop } = setup([failed('sell_price_impact_unavailable', { retryable: true }), ok()]);
    await poll(monitor);
    expect(monitor.getOpenCount()).toBe(1); // NOT removed
    expect(monitor.sellDeferrals).toBe(1);
    expect(monitor.needsReconciliation('t1')).toBe(false);
    expect(ledger.getOpenPositions()).toHaveLength(1); // NO false ledger exit
    expect(tradeRow(ledger).status).toBe('open');
    expect(tradeRow(ledger).pnl_sol).toBeNull(); // NO false realized PnL
    expect(emergencyStop.trigger).not.toHaveBeenCalled();

    await poll(monitor); // retried -- this time it fills
    expect(monitor.getOpenCount()).toBe(0);
    expect(sells).toHaveLength(2);
    expect(tradeRow(ledger).status).toBe('closed');
  });

  it('retryable sell failure that never resolves: escalates after the bound, still NO exit and NO PnL, selling stops', async () => {
    const stale = Date.now() - 120_000;
    const { monitor, ledger, sells, emergencyStop } = setup([
      failed('sell_price_impact_unavailable', { retryable: true }, stale),
      failed('sell_price_impact_unavailable', { retryable: true }),
      ok(), // would fill if the monitor wrongly kept retrying -- it must not be called
    ]);
    await poll(monitor); // first deferral, stamped 120s ago
    await poll(monitor); // second: past the 60s bound -> escalate
    expect(monitor.getOpenCount()).toBe(1); // still open: nothing was ever sold
    expect(monitor.needsReconciliation('t1')).toBe(true);
    expect(monitor.sellReconciliationEvents).toBe(1);
    expect(ledger.getOpenPositions()).toHaveLength(1);
    expect(tradeRow(ledger).status).toBe('open');
    expect(tradeRow(ledger).pnl_sol).toBeNull();
    expect(emergencyStop.trigger).toHaveBeenCalledTimes(1);
    expect((emergencyStop.trigger as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('sell_not_confirmed_executed:M');

    // no further automatic sell attempts: prevents a duplicate sell once state is reconciled by a human
    const callsBefore = sells.length;
    await poll(monitor);
    await poll(monitor);
    expect(sells).toHaveLength(callsBefore);
    expect(monitor.getOpenCount()).toBe(1);
  });

  it('non-retryable, not-executed sell failure (e.g. sell_token_amount_unknown): escalates immediately, no retry wait, no exit, no PnL', async () => {
    const { monitor, ledger, sells, emergencyStop } = setup([failed('sell_token_amount_unknown'), ok()]);
    await poll(monitor);
    expect(monitor.getOpenCount()).toBe(1); // NOT removed, NOT treated as closed
    expect(monitor.needsReconciliation('t1')).toBe(true);
    expect(monitor.sellReconciliationEvents).toBe(1);
    expect(ledger.getOpenPositions()).toHaveLength(1);
    const row = tradeRow(ledger);
    expect(row.status).toBe('open'); // NO false ledger exit
    expect(row.pnl_sol).toBeNull(); // NO fabricated PnL
    expect(row.exit_reason).toBeNull();
    expect(emergencyStop.trigger).toHaveBeenCalledTimes(1);

    // blocked from further automatic sells even though a later attempt in the queue would succeed
    await poll(monitor);
    expect(sells).toHaveLength(1);
    expect(monitor.getOpenCount()).toBe(1);
  });

  it("unknown execution outcome (executionOutcome: 'unknown'): never retried even once, escalates immediately, no exit, no PnL", async () => {
    // Represents a future live executor whose broadcast outcome could not be confirmed. retryable is irrelevant here:
    // retrying an unknown outcome risks a DUPLICATE sell, so it must never be attempted again automatically.
    const { monitor, ledger, sells, emergencyStop } = setup([
      { ...failed('broadcast_confirmation_timeout', { retryable: true }), executionOutcome: 'unknown', success: false },
      ok(),
    ]);
    await poll(monitor);
    expect(monitor.getOpenCount()).toBe(1);
    expect(monitor.needsReconciliation('t1')).toBe(true);
    const row = tradeRow(ledger);
    expect(row.status).toBe('open');
    expect(row.pnl_sol).toBeNull();
    expect(emergencyStop.trigger).toHaveBeenCalledTimes(1);

    await poll(monitor); // must NOT attempt the queued successful sell -- that would risk a double sell
    expect(sells).toHaveLength(1);
    expect(monitor.getOpenCount()).toBe(1);
  });

  it('position count and exposure stay correct across every non-executed outcome (never silently drops exposure)', async () => {
    for (const fill of [
      failed('sell_price_impact_unavailable', { retryable: true }),
      failed('sell_token_amount_unknown'),
      { ...failed('unknown_outcome'), executionOutcome: 'unknown' as const },
    ]) {
      const { monitor, ledger } = setup([fill]);
      expect(monitor.getOpenCount()).toBe(1);
      await poll(monitor);
      expect(monitor.getOpenCount()).toBe(1); // still counted: real (or shadow) exposure is still deployed
      expect(ledger.getOpenPositions()).toHaveLength(1);
    }
  });

  it('no realized PnL is ever applied to the daily risk state for a non-executed sell', async () => {
    const { monitor, ledger } = setup([failed('sell_token_amount_unknown')]);
    const dateIsoUtc = utcDateString(Date.now());
    const before = ledger.getOrInitDailyRiskState(dateIsoUtc, cfg.risk.dailyStartingBalanceSol);
    expect(before.realizedPnlSol).toBe(0);
    await poll(monitor);
    const after = ledger.getOrInitDailyRiskState(dateIsoUtc, cfg.risk.dailyStartingBalanceSol);
    expect(after.realizedPnlSol).toBe(0); // unchanged: no fabricated loss was ever booked
    expect(after.circuitBreakerTriggered).toBe(false);
  });
});

describe('PositionMonitor: hasPosition / markReconciliationNeeded', () => {
  it('hasPosition reflects addPosition / a successful close', async () => {
    const { monitor } = setup([ok()]);
    expect(monitor.hasPosition('t1')).toBe(true);
    await poll(monitor);
    expect(monitor.hasPosition('t1')).toBe(false);
  });

  it('markReconciliationNeeded flags the trade, trips the emergency stop, and is idempotent', () => {
    const { monitor, emergencyStop } = setup([ok()]);
    monitor.markReconciliationNeeded('t1', 'M', 'some_reason', 12345);
    expect(monitor.needsReconciliation('t1')).toBe(true);
    expect(emergencyStop.trigger).toHaveBeenCalledWith('some_reason', 12345);
    expect(monitor.sellReconciliationEvents).toBe(1);
    monitor.markReconciliationNeeded('t1', 'M', 'some_reason', 99999);
    expect(monitor.sellReconciliationEvents).toBe(2); // trigger is called again (harmless), but see the position-recovery test for the persisted-reason idempotency
  });

  it('a position flagged via markReconciliationNeeded (without ever being addPosition-ed) is never polled', async () => {
    const { monitor, sells } = setup([ok()]);
    monitor.markReconciliationNeeded('never-added', 'M', 'reason');
    // pollAll() only ever iterates `this.positions`, so a trade flagged without being added is trivially never
    // polled -- this just documents that guarantee explicitly.
    await poll(monitor);
    expect(sells).toHaveLength(1); // only the ONE addPosition-ed fixture position (t1) was ever polled
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P1 fix #2 (Phase 3): emergency-stop / max-hold-timeout must not depend on price availability. The pre-fix code
// returned from pollOne() immediately when the price provider answered null, BEFORE evaluateExit() ever ran -- so an
// emergency stop, or an expired max-hold timeout, could never force-close a position simply because the price feed
// happened to be down at that moment. See exit/exitEngine.ts (the actual gating logic) and exit/types.ts
// (currentPriceSol/currentLiquiditySol are now independently nullable).
// ---------------------------------------------------------------------------------------------------------------------
describe('PositionMonitor: exits that do not need price must still fire when price is unavailable', () => {
  function setupNoPrice(overrides: { emergencyStopTriggered?: boolean; entryTimeMs?: number } = {}) {
    const db = openLedger(':memory:');
    const ledger = new TradeLedger(db);
    const sells: unknown[] = [];
    const executor = {
      buy: async () => {
        throw new Error('no');
      },
      sell: async (p: unknown) => {
        sells.push(p);
        return ok();
      },
    };
    const priceSource = { getPrice: vi.fn().mockResolvedValue(null), getEstimatedPriceImpactPct: vi.fn(), getBuyExecutionQuote: vi.fn(), getSellPriceImpactPct: vi.fn() };
    const aggregator = { getPrice: async () => null, getHolderConcentration: async () => null, getLiquidityAndVolume: async () => null };
    const emergencyStop = { isTriggered: () => overrides.emergencyStopTriggered ?? false, trigger: vi.fn() };
    const monitor = new PositionMonitor(
      { executor, priceSource: priceSource as never, aggregator: aggregator as never, ledger, emergencyStop: emergencyStop as never, logger },
      cfg,
      HARD_RISK_PARAMETERS,
    );
    const now = Date.now();
    ledger.recordEntry({
      id: 't1',
      mint: 'M',
      poolAddress: null,
      strategyVersion: 'v',
      dryRun: true,
      reentryIndex: 0,
      entryTimeMs: overrides.entryTimeMs ?? now,
      entryPriceSol: 1,
      entrySizeSol: 0.3,
      entryTokenAgeSec: 100,
      entryLiquiditySol: 40,
      entryVolume1mSol: 6,
      entryBuySellRatio: 2,
      entryPriceVelocity5sPct: 2,
      entryVolumeAccelerationX: 2,
      entryScore: 5,
      entryScoreComponents: null,
      expectedNetEdgePct: 0.5,
      expectedNetEdgeBreakdown: null,
      entrySlippagePct: 0.3,
      entryPriceImpactPct: 0.4,
      entryFeesSol: 0.001,
      entryTxSignature: null,
      entrySafetyCheckId: null,
      dailyRealizedPnlSolAtEntry: 0,
      entryTokenAmountRaw: '5000000',
      entryFilledAmountSol: 0.29,
    });
    monitor.addPosition({
      tradeId: 't1',
      mint: 'M',
      poolAddress: null,
      entryTimeMs: overrides.entryTimeMs ?? now,
      entryPriceSol: 1,
      entrySizeSol: 0.3,
      entryFilledAmountSol: 0.29,
      entryTokenAmountRaw: '5000000',
      entryFeesSol: 0.001,
      reentryIndex: 0,
      strategyVersion: 'v',
      dryRun: true,
      priceHistory: [{ priceSol: 1, liquiditySol: 40, timestampMs: overrides.entryTimeMs ?? now }],
      peakPriceSol: 1,
      troughPriceSol: 1,
    });
    return { monitor, ledger, sells };
  }

  it('price unavailable + emergency stop triggered => the exit attempt still happens (a sell is attempted)', async () => {
    const { monitor, sells } = setupNoPrice({ emergencyStopTriggered: true });
    await poll(monitor);
    expect(sells).toHaveLength(1);
    expect(monitor.getOpenCount()).toBe(0); // the sell in this fixture succeeds -> closed
  });

  it('price unavailable + max-hold time already expired => the exit attempt still happens', async () => {
    const staleEntry = Date.now() - (cfg.exits.maxHoldTimeSec + 60) * 1000;
    const { monitor, sells } = setupNoPrice({ entryTimeMs: staleEntry });
    await poll(monitor);
    expect(sells).toHaveLength(1);
    expect(monitor.getOpenCount()).toBe(0);
  });

  it('price unavailable + no non-price exit condition applies => the position remains open, no sell attempted', async () => {
    const { monitor, sells } = setupNoPrice(); // emergencyStopTriggered: false, entry just now (max-hold not reached)
    await poll(monitor);
    expect(sells).toHaveLength(0);
    expect(monitor.getOpenCount()).toBe(1);
  });

  it('price unavailable never fabricates a price or a PnL: peak/trough/priceHistory are untouched when nothing else exits', async () => {
    const { monitor } = setupNoPrice();
    type Internal = { positions: Map<string, { priceHistory: unknown[]; peakPriceSol: number; troughPriceSol: number }> };
    const before = { ...(monitor as unknown as Internal).positions.get('t1')! };
    await poll(monitor);
    const after = (monitor as unknown as Internal).positions.get('t1')!;
    expect(after.priceHistory).toHaveLength(1); // no fabricated point pushed
    expect(after.peakPriceSol).toBe(before.peakPriceSol);
    expect(after.troughPriceSol).toBe(before.troughPriceSol);
  });

  it('current price available => existing price-dependent behavior is unchanged (dynamic_sl still fires on a real drop)', async () => {
    const db = openLedger(':memory:');
    const ledger = new TradeLedger(db);
    const sells: unknown[] = [];
    const executor = { buy: async () => { throw new Error('no'); }, sell: async (p: unknown) => { sells.push(p); return ok(); } };
    const priceSource = { getPrice: vi.fn().mockResolvedValue(0.85), getEstimatedPriceImpactPct: vi.fn(), getBuyExecutionQuote: vi.fn(), getSellPriceImpactPct: vi.fn() };
    const aggregator = { getPrice: async () => 0.85, getHolderConcentration: async () => null, getLiquidityAndVolume: async () => ({ liquiditySol: 40, volume1mSol: 1, buySellRatio: 1, txCount1m: 1 }) };
    const emergencyStop = { isTriggered: () => false, trigger: vi.fn() };
    const monitor = new PositionMonitor({ executor, priceSource: priceSource as never, aggregator: aggregator as never, ledger, emergencyStop: emergencyStop as never, logger }, cfg, HARD_RISK_PARAMETERS);
    const now = Date.now();
    ledger.recordEntry({
      id: 't1', mint: 'M', poolAddress: null, strategyVersion: 'v', dryRun: true, reentryIndex: 0,
      entryTimeMs: now, entryPriceSol: 1, entrySizeSol: 0.3, entryTokenAgeSec: 100, entryLiquiditySol: 40,
      entryVolume1mSol: 6, entryBuySellRatio: 2, entryPriceVelocity5sPct: 2, entryVolumeAccelerationX: 2,
      entryScore: 5, entryScoreComponents: null, expectedNetEdgePct: 0.5, expectedNetEdgeBreakdown: null,
      entrySlippagePct: 0.3, entryPriceImpactPct: 0.4, entryFeesSol: 0.001, entryTxSignature: null,
      entrySafetyCheckId: null, dailyRealizedPnlSolAtEntry: 0, entryTokenAmountRaw: '5000000', entryFilledAmountSol: 0.29,
    });
    monitor.addPosition({
      tradeId: 't1', mint: 'M', poolAddress: null, entryTimeMs: now, entryPriceSol: 1, entrySizeSol: 0.3,
      entryFilledAmountSol: 0.29, entryTokenAmountRaw: '5000000', entryFeesSol: 0.001, reentryIndex: 0,
      strategyVersion: 'v', dryRun: true, priceHistory: [{ priceSol: 1, liquiditySol: 40, timestampMs: now }],
      peakPriceSol: 1, troughPriceSol: 1,
    });
    await poll(monitor);
    expect(sells).toHaveLength(1); // -15% pnl breaches the -10% default dynamic stop loss, exactly as before this fix
    expect(monitor.getOpenCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P2 fix: atomic exit persistence. A successful close used to (1) delete the position from in-memory tracking, THEN
// (2) apply the daily PnL delta, record the exit, and (conditionally) latch the circuit breaker as three SEPARATE,
// un-transacted ledger writes. A crash or genuine DB failure between any of those steps could leave the ledger and
// the in-memory state permanently inconsistent. See TradeLedger.runExitTransaction / markReconciliationNeeded and
// positionMonitor.ts:closePosition.
// ---------------------------------------------------------------------------------------------------------------------
describe('PositionMonitor: atomic exit persistence', () => {
  it('a normal successful exit commits the trade exit, the daily PnL delta, and removes the position -- together', async () => {
    const { monitor, ledger, emergencyStop } = setup([ok()]);
    await poll(monitor);
    expect(monitor.getOpenCount()).toBe(0);
    expect(tradeRow(ledger).status).toBe('closed');
    const dateIsoUtc = utcDateString(Date.now());
    expect(ledger.getDailyRealizedPnl(dateIsoUtc)).toBeCloseTo(0.28 - 0.3, 12);
    expect(emergencyStop.trigger).not.toHaveBeenCalled();
  });

  it('a DB failure during the atomic write leaves the position tracked (never deleted), the trade row still open, and no partial daily PnL', async () => {
    const { monitor, ledger, emergencyStop } = setup([ok()]);
    const dateIsoUtc = utcDateString(Date.now());
    const before = ledger.getDailyRealizedPnl(dateIsoUtc);
    const spy = vi.spyOn(ledger, 'runExitTransaction').mockImplementation(() => {
      throw new Error('simulated disk full');
    });

    await poll(monitor);

    expect(monitor.getOpenCount()).toBe(1); // NEVER deleted from tracking
    expect(tradeRow(ledger).status).toBe('open'); // the write rolled back / never happened
    expect(ledger.getDailyRealizedPnl(dateIsoUtc)).toBe(before); // no partial PnL update
    expect(monitor.needsReconciliation('t1')).toBe(true);
    expect(emergencyStop.trigger).toHaveBeenCalledTimes(1);
    expect((emergencyStop.trigger as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('exit_persistence_failed');
    spy.mockRestore();
  });

  it('executed sell + DB failure => reconciliation-needed, and NEVER a duplicate sell on the next poll', async () => {
    const { monitor, ledger, sells } = setup([ok(), ok()]); // a second, distinct successful fill queued -- must never be reached
    vi.spyOn(ledger, 'runExitTransaction').mockImplementation(() => {
      throw new Error('simulated disk full');
    });
    await poll(monitor);
    expect(sells).toHaveLength(1);
    await poll(monitor); // if reconciliationNeeded did not block this, the second queued fill would execute
    await poll(monitor);
    expect(sells).toHaveLength(1); // still exactly one sell attempt, ever
    expect(monitor.getOpenCount()).toBe(1);
  });

  it('the ledger row itself is marked with a reconciliation reason, surviving a restart (see positionRecovery.ts)', async () => {
    const { monitor, ledger } = setup([ok()]);
    vi.spyOn(ledger, 'runExitTransaction').mockImplementation(() => {
      throw new Error('simulated disk full');
    });
    await poll(monitor);
    const row = ledger['db'].prepare(`SELECT reconciliation_reason FROM trades WHERE id = 't1'`).get() as { reconciliation_reason: string | null };
    expect(row.reconciliation_reason).toContain('exit_persistence_failed');
  });

  it('circuit-breaker state stays consistent: a DB failure never latches it (nothing was committed to latch it against)', async () => {
    const { monitor, ledger } = setup([ok({ filledAmountSol: 0 })]); // a large simulated loss, would breach the daily loss limit if committed
    vi.spyOn(ledger, 'runExitTransaction').mockImplementation(() => {
      throw new Error('simulated disk full');
    });
    await poll(monitor);
    const dateIsoUtc = utcDateString(Date.now());
    const state = ledger.getOrInitDailyRiskState(dateIsoUtc, cfg.risk.dailyStartingBalanceSol);
    expect(state.circuitBreakerTriggered).toBe(false);
  });

  it('a restarted process reconciles safely: recovery sees the persisted reason and refuses to resume the trade automatically', async () => {
    const { monitor, ledger, emergencyStop } = setup([ok()]);
    vi.spyOn(ledger, 'runExitTransaction').mockImplementation(() => {
      throw new Error('simulated disk full');
    });
    await poll(monitor);

    // Simulate a fresh process: a brand-new PositionMonitor, wired to the SAME ledger.
    const { recoverOpenPositions } = await import('../../src/orchestrator/positionRecovery.js');
    const freshEmergencyStop = { isTriggered: () => false, trigger: vi.fn() } as never;
    const executor = { buy: async () => { throw new Error('no'); }, sell: vi.fn() };
    const priceSource = { getPrice: vi.fn(), getEstimatedPriceImpactPct: vi.fn(), getBuyExecutionQuote: vi.fn(), getSellPriceImpactPct: vi.fn() };
    const aggregator = { getPrice: vi.fn(), getHolderConcentration: vi.fn(), getLiquidityAndVolume: vi.fn() };
    const freshMonitor = new PositionMonitor(
      { executor, priceSource: priceSource as never, aggregator: aggregator as never, ledger, emergencyStop: freshEmergencyStop, logger },
      cfg,
      HARD_RISK_PARAMETERS,
    );
    const result = recoverOpenPositions(ledger, freshMonitor, freshEmergencyStop, logger);
    expect(result.reconciliationFlagged).toBe(1);
    expect(freshMonitor.hasPosition('t1')).toBe(false); // never resumed as a live, tradeable position
    expect(freshMonitor.needsReconciliation('t1')).toBe(true);
    void emergencyStop;
  });
});
