import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { PositionMonitor } from '../../src/orchestrator/positionMonitor.js';
import { recoverOpenPositions } from '../../src/orchestrator/positionRecovery.js';
import { EmergencyStop } from '../../src/risk/emergencyStop.js';
import type { TradeEntryRecord } from '../../src/types/trade.js';

/**
 * P1 fix #1: PositionMonitor's `positions` Map is purely in-memory, so a process restart used to leave every
 * still-open ledger trade unmonitored -- still counted in exposure (TradeLedger.getOpenPositions), still counted by
 * the risk engine, but with no exit condition ever evaluated for it again. This is the regression suite for
 * `recoverOpenPositions` (orchestrator/positionRecovery.ts), which must run BEFORE PositionMonitor.start() -- see
 * orchestrator/loop.ts.
 */

const cfg = getDefaultConfig();
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;

function makeEntry(overrides: Partial<TradeEntryRecord> = {}): TradeEntryRecord {
  return {
    id: 't1',
    mint: 'MINT',
    poolAddress: 'POOL',
    strategyVersion: 'baseline-v1',
    dryRun: true,
    reentryIndex: 0,
    entryTimeMs: 1_000_000,
    entryPriceSol: 1,
    entrySizeSol: 0.3,
    entryTokenAgeSec: 45,
    entryLiquiditySol: 40,
    entryVolume1mSol: 10,
    entryBuySellRatio: 2,
    entryPriceVelocity5sPct: 1.5,
    entryVolumeAccelerationX: 2,
    entryScore: 3.5,
    entryScoreComponents: null,
    expectedNetEdgePct: 0.5,
    expectedNetEdgeBreakdown: null,
    entrySlippagePct: 0.3,
    entryPriceImpactPct: 0.5,
    entryFeesSol: 0.001,
    entryTxSignature: null,
    entrySafetyCheckId: null,
    dailyRealizedPnlSolAtEntry: 0,
    entryTokenAmountRaw: '5000000',
    entryFilledAmountSol: 0.29,
    ...overrides,
  };
}

function setup() {
  const db = openLedger(':memory:');
  const ledger = new TradeLedger(db);
  const executor = { buy: vi.fn(), sell: vi.fn() };
  const priceSource = { getPrice: vi.fn(), getEstimatedPriceImpactPct: vi.fn(), getBuyExecutionQuote: vi.fn(), getSellPriceImpactPct: vi.fn() };
  const aggregator = { getPrice: vi.fn(), getHolderConcentration: vi.fn(), getLiquidityAndVolume: vi.fn() };
  const emergencyStop = new EmergencyStop();
  const monitor = new PositionMonitor(
    { executor: executor as never, priceSource: priceSource as never, aggregator: aggregator as never, ledger, emergencyStop, logger },
    cfg,
    HARD_RISK_PARAMETERS,
  );
  return { db, ledger, monitor, emergencyStop };
}

describe('recoverOpenPositions', () => {
  it('A. restart with one open position: it is reconstructed and counted', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry());
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result).toEqual({ recovered: 1, skipped: 0, reconciliationFlagged: 0 });
    expect(monitor.hasPosition('t1')).toBe(true);
    expect(monitor.getOpenCount()).toBe(1);
    expect(emergencyStop.isTriggered()).toBe(false);
  });

  it('B. restart with multiple open positions: every one is reconstructed', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ id: 't1', mint: 'A' }));
    ledger.recordEntry(makeEntry({ id: 't2', mint: 'B', entryTimeMs: 2_000_000 }));
    ledger.recordEntry(makeEntry({ id: 't3', mint: 'C', entryTimeMs: 3_000_000 }));
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result.recovered).toBe(3);
    expect(monitor.getOpenCount()).toBe(3);
    for (const id of ['t1', 't2', 't3']) expect(monitor.hasPosition(id)).toBe(true);
  });

  it('C. a recovered position participates in exit monitoring (a real poll tick can close it)', async () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ entryPriceSol: 1, entrySizeSol: 0.3 }));
    recoverOpenPositions(ledger, monitor, emergencyStop, logger);

    type Poller = { pollAll(): Promise<void> };
    const deps = (monitor as unknown as { deps: { priceSource: { getPrice: ReturnType<typeof vi.fn> }; aggregator: { getLiquidityAndVolume: ReturnType<typeof vi.fn> }; executor: { sell: ReturnType<typeof vi.fn> } } }).deps;
    deps.priceSource.getPrice.mockResolvedValue(0.85); // -15%, below the -10% default stop loss
    deps.aggregator.getLiquidityAndVolume.mockResolvedValue({ liquiditySol: 40, volume1mSol: 1, buySellRatio: 1, txCount1m: 1 });
    deps.executor.sell.mockResolvedValue({
      success: true,
      filledPriceSol: 0.85,
      filledAmountSol: 0.25,
      feesSol: 0.001,
      txSignature: null,
      simulated: true,
      timestampMs: Date.now(),
      slippagePct: 0.3,
      priceImpactPct: 0.9,
    });

    await (monitor as unknown as Poller).pollAll();

    expect(deps.executor.sell).toHaveBeenCalledTimes(1);
    expect(monitor.getOpenCount()).toBe(0); // the recovered position was actually evaluated and closed
    const row = db_row(ledger, 't1');
    expect(row.status).toBe('closed');
  });

  it('D. recovered positions count toward exposure via the existing ledger-backed accounting', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ id: 't1', mint: 'A', entrySizeSol: 0.3 }));
    ledger.recordEntry(makeEntry({ id: 't2', mint: 'B', entrySizeSol: 0.3, entryTimeMs: 2_000_000 }));
    recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    // getOpenPositions() (risk/exposureManager.ts's input) is untouched by recovery: the ledger rows were already
    // 'open' before recovery ran, so exposure was never lost even for the instant before recovery executes.
    const open = ledger.getOpenPositions();
    expect(open).toHaveLength(2);
    expect(open.reduce((sum, p) => sum + p.entrySizeSol, 0)).toBeCloseTo(0.6, 10);
  });

  it('E. missing entryTokenAmountRaw => reconciliation-needed + emergency stop, never reconstructed, never auto-sold', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ entryTokenAmountRaw: null }));
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result).toEqual({ recovered: 0, skipped: 0, reconciliationFlagged: 1 });
    expect(monitor.hasPosition('t1')).toBe(false); // never constructed into a live Position
    expect(monitor.needsReconciliation('t1')).toBe(true);
    expect(emergencyStop.isTriggered()).toBe(true);
    expect(emergencyStop.getReason()).toContain('position_recovery_incomplete:t1');
    // the trade is left exactly as it was: still open in the ledger, no fabricated data
    expect(ledger.getOpenPositions()).toHaveLength(1);
  });

  it('E2. missing entryFilledAmountSol (a trade recorded before this column existed) is also refused, not defaulted to 0', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ entryFilledAmountSol: null }));
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result.reconciliationFlagged).toBe(1);
    expect(monitor.hasPosition('t1')).toBe(false);
    expect(emergencyStop.isTriggered()).toBe(true);
  });

  it('E3. an invalid entryPriceSol (defensive: the schema forbids it, but recovery must not trust blindly) is refused', () => {
    const { db, ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry());
    db.prepare(`UPDATE trades SET entry_price_sol = 0 WHERE id = 't1'`).run();
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result.reconciliationFlagged).toBe(1);
    expect(monitor.hasPosition('t1')).toBe(false);
  });

  it('E4. the missing-fields reason is persisted to the ledger, not only held in memory', () => {
    const { db, ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ entryTokenAmountRaw: null }));
    recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    const row = db_row(ledger, 't1');
    expect(row.reconciliation_reason).toContain('entryTokenAmountRaw');
    void db;
  });

  it('F. a trade already carrying a persisted reconciliation_reason (e.g. a prior exit-persistence failure) is never resumed, however complete its data looks', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry()); // otherwise fully recoverable data
    ledger.markReconciliationNeeded('t1', 'exit_persistence_failed:disk full');
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result).toEqual({ recovered: 0, skipped: 0, reconciliationFlagged: 1 });
    expect(monitor.hasPosition('t1')).toBe(false);
    expect(monitor.needsReconciliation('t1')).toBe(true);
    expect(emergencyStop.isTriggered()).toBe(true);
  });

  it('G. no duplicate recovered positions: running recovery twice never re-adds or resets an already-tracked position', async () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry());
    recoverOpenPositions(ledger, monitor, emergencyStop, logger);

    // Simulate real polling activity having accumulated price history since the first recovery.
    type Internal = { positions: Map<string, { priceHistory: unknown[] }> };
    const positions = (monitor as unknown as Internal).positions;
    const before = positions.get('t1')!;
    before.priceHistory.push({ priceSol: 1.05, liquiditySol: 40, timestampMs: Date.now() });
    expect(before.priceHistory).toHaveLength(2);

    const second = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(second).toEqual({ recovered: 0, skipped: 1, reconciliationFlagged: 0 });
    expect(monitor.getOpenCount()).toBe(1); // not duplicated
    expect(positions.get('t1')!.priceHistory).toHaveLength(2); // NOT reset back to a single entry-time point
  });

  it('G2. running recovery twice never re-flags (or re-trips the emergency stop from scratch) an already-flagged trade', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ entryTokenAmountRaw: null }));
    const first = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(first.reconciliationFlagged).toBe(1);
    const second = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(second).toEqual({ recovered: 0, skipped: 1, reconciliationFlagged: 0 });
  });

  it('H. closed trades are not recovered', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry());
    ledger.recordExit('t1', {
      exitTimeMs: 2_000_000,
      exitPriceSol: 1.02,
      exitReason: 'quick_tp',
      exitFeesSol: 0.001,
      exitTxSignature: null,
      exitSlippagePct: 0.3,
      holdDurationMs: 1000,
      pnlSol: 0.005,
      pnlPct: 1.7,
      maxFavorableExcursionPct: 2,
      maxAdverseExcursionPct: -0.5,
      dailyRealizedPnlSolAtExit: 0.005,
    });
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result).toEqual({ recovered: 0, skipped: 0, reconciliationFlagged: 0 });
    expect(monitor.hasPosition('t1')).toBe(false);
    expect(monitor.getOpenCount()).toBe(0);
  });

  it('a mix of recoverable and unrecoverable trades is handled independently, one bad trade does not block the others', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ id: 'good', mint: 'A' }));
    ledger.recordEntry(makeEntry({ id: 'bad', mint: 'B', entryTokenAmountRaw: null, entryTimeMs: 2_000_000 }));
    const result = recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    expect(result).toEqual({ recovered: 1, skipped: 0, reconciliationFlagged: 1 });
    expect(monitor.hasPosition('good')).toBe(true);
    expect(monitor.hasPosition('bad')).toBe(false);
    expect(monitor.needsReconciliation('bad')).toBe(true);
  });

  it('the recovered position seeds price history from the ENTRY tick only, never a fabricated "current" reading', () => {
    const { ledger, monitor, emergencyStop } = setup();
    ledger.recordEntry(makeEntry({ entryPriceSol: 0.7, entryLiquiditySol: 55, entryTimeMs: 12_345 }));
    recoverOpenPositions(ledger, monitor, emergencyStop, logger);
    type Internal = { positions: Map<string, { priceHistory: Array<{ priceSol: number; liquiditySol: number; timestampMs: number }>; peakPriceSol: number; troughPriceSol: number }> };
    const p = (monitor as unknown as Internal).positions.get('t1')!;
    expect(p.priceHistory).toEqual([{ priceSol: 0.7, liquiditySol: 55, timestampMs: 12_345 }]);
    expect(p.peakPriceSol).toBe(0.7);
    expect(p.troughPriceSol).toBe(0.7);
  });
});

function db_row(ledger: TradeLedger, id: string): { status: string; reconciliation_reason: string | null } {
  return ledger['db'].prepare('SELECT status, reconciliation_reason FROM trades WHERE id = ?').get(id) as {
    status: string;
    reconciliation_reason: string | null;
  };
}
