import { describe, expect, it } from 'vitest';
import { runReplay } from '../../src/backtest/replayEngine.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { HistoricalMarketSnapshot } from '../../src/backtest/types.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleSnapshot, snapshotsByMint } from './fixtures.js';

function replay(snapshots: HistoricalMarketSnapshot[], label = 'baseline-v1') {
  return runReplay(snapshotsByMint(snapshots), DEFAULT_CONFIG, DEFAULT_ASSUMPTIONS, label);
}

function winningRoundTrip(mint: string, entryAtMs: number): HistoricalMarketSnapshot[] {
  return [
    entryEligibleSnapshot({ mint, observedAtMs: entryAtMs }),
    entryEligibleSnapshot({ mint, observedAtMs: entryAtMs + 2_000, priceSol: 1.03 }),
  ];
}

function losingRoundTrip(mint: string, entryAtMs: number): HistoricalMarketSnapshot[] {
  return [
    entryEligibleSnapshot({ mint, observedAtMs: entryAtMs }),
    entryEligibleSnapshot({ mint, observedAtMs: entryAtMs + 2_000, priceSol: 0.0001 }),
  ];
}

describe('runReplay: basic entry/exit replay', () => {
  it('opens on an entry-eligible snapshot and exits via quick_tp once the price rises enough', () => {
    const result = replay(winningRoundTrip('MINT_A', 40_000));
    expect(result.status).toBe('completed');
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.status).toBe('closed');
    expect(trade.exitReason).toBe('quick_tp');
    expect(trade.entryPriceSol).toBe(1);
    expect(trade.exitPriceSol).toBe(1.03);
    expect(trade.pnlSol).toBeGreaterThan(0);
  });

  it('never reports gross PnL as final: a flat-price hold-to-timeout trade still nets negative due to fees', () => {
    // This test needs the production cost schedule (the shared fixtures are cost-free), and under the complete-round-trip edge a 2 % expected
    // move cannot clear it -- so the strategy's expected move (quick take-profit) is set high enough for the entry gate to open.
    const costly = { ...DEFAULT_ASSUMPTIONS, edge: getDefaultConfig().edge };
    const cfg = { ...DEFAULT_CONFIG, exits: { ...DEFAULT_CONFIG.exits, quickTpMinPct: 6, quickTpMaxPct: 8 } };
    const result = runReplay(snapshotsByMint([entryEligibleSnapshot({ observedAtMs: 40_000 }), entryEligibleSnapshot({ observedAtMs: 70_000 })]), cfg, costly, 'test');
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('max_hold_timeout');
    expect(trade.entryPriceSol).toBe(trade.exitPriceSol); // gross price move was exactly 0%...
    expect(trade.pnlSol).toBeLessThan(0); // ...yet the reported net PnL is still negative, from fees/costs alone
    expect(trade.entryFeesSol).toBeGreaterThan(0);
    expect(trade.exitFeesSol ?? 0).toBeGreaterThan(0);
  });

  it('exits via liquidity_deterioration when liquidity collapses even though price is flat', () => {
    const result = replay([
      entryEligibleSnapshot({ observedAtMs: 40_000, liquiditySol: 40 }),
      entryEligibleSnapshot({ observedAtMs: 42_000, liquiditySol: 25 }), // 37.5% drop >= 30% threshold
    ]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitReason).toBe('liquidity_deterioration');
  });

  it('rejects entry outright when estimated price impact exceeds the configured maximum (task D)', () => {
    const result = replay([entryEligibleSnapshot({ observedAtMs: 40_000, estimatedPriceImpactPct: 1.5 })]);
    expect(result.trades).toHaveLength(0);
  });

  it('rejects entry when the token is outside its age window', () => {
    const tooYoung = replay([entryEligibleSnapshot({ observedAtMs: 10_000 })]); // age 10s < min 30s
    expect(tooYoung.trades).toHaveLength(0);

    const tooOld = replay([entryEligibleSnapshot({ observedAtMs: 1_000_000 })]); // age > 900s max
    expect(tooOld.trades).toHaveLength(0);
  });

  it('rejects entry when the recorded safety check failed at observation time (never re-queries on-chain state for the past)', () => {
    const result = replay([
      entryEligibleSnapshot({ observedAtMs: 40_000, safetyPassedAtObservationTime: false, safetyReasonsAtObservationTime: ['top10_holder_pct_exceeded'] }),
    ]);
    expect(result.trades).toHaveLength(0);
  });

  it('skips entry when price is null (never invents a price to simulate a fill)', () => {
    const result = replay([entryEligibleSnapshot({ observedAtMs: 40_000, priceSol: null })]);
    expect(result.trades).toHaveLength(0);
  });
});

describe('runReplay: no averaging down / re-entry replay', () => {
  it('never opens a second position on a mint while one is already open', () => {
    const result = replay([
      entryEligibleSnapshot({ observedAtMs: 40_000 }),
      entryEligibleSnapshot({ observedAtMs: 41_000 }), // still entry-eligible, but a position is already open
      entryEligibleSnapshot({ observedAtMs: 42_000, priceSol: 1.03 }), // closes via quick_tp
    ]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryTimeMs).toBe(40_000);
  });

  it('blocks a re-entry attempt during the cooldown window, then allows it once cooldown elapses, with the correct reentryIndex', () => {
    const snapshots = [
      ...winningRoundTrip('MINT_A', 40_000), // closes at 42_000
      entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: 72_000 }), // only 30s after exit -- cooldown is 60s
      entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: 102_001 }), // 60_001ms after exit -- cooldown elapsed
      entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: 104_001, priceSol: 1.03 }),
    ];
    const result = replay(snapshots);
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]!.reentryIndex).toBe(0);
    expect(result.trades[1]!.reentryIndex).toBe(1);
    expect(result.trades[1]!.entryTimeMs).toBe(102_001);
  });

  it('blocks re-entry once the per-token consecutive-loss limit is reached, even after cooldown has elapsed', () => {
    const snapshots = [
      ...losingRoundTrip('MINT_A', 40_000), // loss 1
      ...losingRoundTrip('MINT_A', 40_000 + 2_000 + 60_001), // loss 2 -> consecutiveLosses reaches 2
      entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: 40_000 + 2_000 + 60_001 + 2_000 + 60_001 }), // well past cooldown
    ];
    const result = replay(snapshots);
    expect(result.trades).toHaveLength(2);
    expect(result.trades.every((t) => (t.pnlSol ?? 0) < 0)).toBe(true);
  });

  it('blocks re-entry once MAX_REENTRY is exhausted (6 total trades = initial + 5 re-entries)', () => {
    const snapshots: HistoricalMarketSnapshot[] = [];
    let t = 40_000;
    for (let i = 0; i < 6; i += 1) {
      snapshots.push(...winningRoundTrip('MINT_A', t));
      t += 2_000 + 60_001;
    }
    snapshots.push(entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: t })); // 7th attempt
    const result = replay(snapshots);
    expect(result.trades).toHaveLength(6);
    expect(result.trades.map((tr) => tr.reentryIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('runReplay: risk-limit replay', () => {
  it('latches the daily loss circuit breaker once cumulative realized losses breach the daily limit, blocking even an untouched mint', () => {
    const snapshots: HistoricalMarketSnapshot[] = [
      ...losingRoundTrip('MINT_1', 40_000),
      ...losingRoundTrip('MINT_2', 50_000),
      ...losingRoundTrip('MINT_3', 60_000),
      ...losingRoundTrip('MINT_4', 70_000), // 4th loss of ~0.3 SOL each breaches 10% of the 10 SOL daily starting balance
      entryEligibleSnapshot({ mint: 'MINT_5', observedAtMs: 80_000 }), // otherwise perfectly entry-eligible
    ];
    const result = replay(snapshots);
    const mint5Trades = result.trades.filter((t) => t.mint === 'MINT_5');
    expect(mint5Trades).toHaveLength(0);
    const totalLosses = result.trades.reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);
    expect(totalLosses).toBeLessThanOrEqual(-1);
  });

  it('never opens more than the hard concurrent-position limit at once', () => {
    const snapshots: HistoricalMarketSnapshot[] = [
      entryEligibleSnapshot({ mint: 'MINT_1', observedAtMs: 40_000 }),
      entryEligibleSnapshot({ mint: 'MINT_2', observedAtMs: 40_001 }),
      entryEligibleSnapshot({ mint: 'MINT_3', observedAtMs: 40_002 }),
      entryEligibleSnapshot({ mint: 'MINT_4', observedAtMs: 40_003 }), // 4th concurrent -- should be blocked
    ];
    const result = replay(snapshots);
    expect(result.trades).toHaveLength(3);
    expect(result.trades.some((t) => t.mint === 'MINT_4')).toBe(false);
  });
});

describe('runReplay: no look-ahead bias', () => {
  it('an entry decision on a mint is unaffected by that same mint\'s own future ticks', () => {
    const full = replay(winningRoundTrip('MINT_A', 40_000));
    const truncated = replay([entryEligibleSnapshot({ mint: 'MINT_A', observedAtMs: 40_000 })]);

    expect(full.trades).toHaveLength(1);
    expect(truncated.trades).toHaveLength(1);
    const fullTrade = full.trades[0]!;
    const truncatedTrade = truncated.trades[0]!;

    // The truncated run has no future tick to exit on, so its trade is still
    // open -- but everything decided AT ENTRY TIME must be identical.
    expect(truncatedTrade.status).toBe('still_open_at_end_of_data');
    expect(truncatedTrade.entryTimeMs).toBe(fullTrade.entryTimeMs);
    expect(truncatedTrade.entryPriceSol).toBe(fullTrade.entryPriceSol);
    expect(truncatedTrade.entrySizeSol).toBe(fullTrade.entrySizeSol);
    expect(truncatedTrade.entryFilledAmountSol).toBe(fullTrade.entryFilledAmountSol);
    expect(truncatedTrade.entryFeesSol).toBe(fullTrade.entryFeesSol);
    expect(truncatedTrade.entryScore).toBe(fullTrade.entryScore);
    expect(truncatedTrade.expectedNetEdgePct).toBe(fullTrade.expectedNetEdgePct);
  });

  it('a mint\'s already-closed trade is unaffected by another mint\'s later data being present or absent', () => {
    const mintAOnly = replay(winningRoundTrip('MINT_A', 40_000)); // closes at 42_000
    const withFutureMintB = replay([
      ...winningRoundTrip('MINT_A', 40_000),
      ...losingRoundTrip('MINT_B', 50_000), // strictly after MINT_A's trade has already closed
    ]);

    const aOnlyTrade = mintAOnly.trades.find((t) => t.mint === 'MINT_A')!;
    const aWithFutureTrade = withFutureMintB.trades.find((t) => t.mint === 'MINT_A')!;
    expect(aWithFutureTrade).toEqual(aOnlyTrade);
  });
});

describe('runReplay: determinism and data quality', () => {
  it('produces byte-identical output when replayed twice against the same input', () => {
    const snapshots = [
      ...winningRoundTrip('MINT_A', 40_000),
      ...losingRoundTrip('MINT_B', 50_000),
      entryEligibleSnapshot({ mint: 'MINT_C', observedAtMs: 60_000, liquiditySol: -5 }), // also exercises data-quality reporting
    ];
    const first = replay(snapshots);
    const second = replay(snapshots);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('surfaces data-quality issues without silently discarding the offending record or aborting the whole replay', () => {
    const result = replay([
      entryEligibleSnapshot({ mint: 'MINT_BAD', observedAtMs: 40_000, liquiditySol: -5 }),
      ...winningRoundTrip('MINT_GOOD', 40_000),
    ]);
    expect(result.dataQualityIssues.some((i) => i.mint === 'MINT_BAD' && i.kind === 'negative_liquidity')).toBe(true);
    expect(result.trades.some((t) => t.mint === 'MINT_GOOD')).toBe(true);
  });

  it('returns status=insufficient_data and no trades when given an empty dataset, never a fabricated result', () => {
    const result = runReplay(new Map(), DEFAULT_CONFIG, DEFAULT_ASSUMPTIONS, 'baseline-v1');
    expect(result.status).toBe('insufficient_data');
    expect(result.trades).toEqual([]);
    expect(result.sampleSizeSnapshots).toBe(0);
  });

  it('labels every result with the strategy label and simulator version passed in', () => {
    const result = replay(winningRoundTrip('MINT_A', 40_000), 'candidate-xyz');
    expect(result.strategyLabel).toBe('candidate-xyz');
    expect(result.simulatorVersion).toBe(DEFAULT_ASSUMPTIONS.simulatorVersion);
  });
});
