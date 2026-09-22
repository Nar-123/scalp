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
