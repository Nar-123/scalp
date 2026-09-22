import { describe, expect, it } from 'vitest';
import { evaluateExit } from '../../src/exit/exitEngine.js';
import type { Position } from '../../src/types/trade.js';
import type { ExitEvaluationInputs } from '../../src/exit/types.js';
import { getDefaultConfig } from '../../src/config/defaults.js';

const cfg = getDefaultConfig().exits;

function position(overrides: Partial<Position> = {}): Position {
  return {
    tradeId: 't1',
    mint: 'MINT',
    poolAddress: null,
    entryTimeMs: 0,
    entryPriceSol: 1,
    entrySizeSol: 0.3,
    entryFilledAmountSol: 0.29,
    reentryIndex: 0,
    strategyVersion: 'baseline-v1',
    dryRun: true,
    priceHistory: [{ priceSol: 1, liquiditySol: 40, timestampMs: 0 }],
    peakPriceSol: 1,
    troughPriceSol: 1,
    ...overrides,
  };
}

function inputs(overrides: Partial<ExitEvaluationInputs> = {}): ExitEvaluationInputs {
  return {
    position: position(),
    currentPriceSol: 1,
    currentLiquiditySol: 40,
    recentMomentumPct: 0,
    recentVolatilityPct: 0.5,
    nowMs: 5000,
    emergencyStopTriggered: false,
    ...overrides,
  };
}

describe('evaluateExit', () => {
  it('does not exit when nothing has triggered', () => {
    const decision = evaluateExit(inputs(), cfg);
    expect(decision.shouldExit).toBe(false);
  });

  it('circuit_breaker takes priority over every other condition', () => {
    const decision = evaluateExit(
      inputs({ emergencyStopTriggered: true, currentPriceSol: 1.1, position: position({ peakPriceSol: 1.1 }) }),
      cfg,
    );
    expect(decision.reason).toBe('circuit_breaker');
  });

  it('dynamic_sl takes priority over momentum/quick TP when both technically apply', () => {
    // pnl is deeply negative, so TP conditions can't apply anyway; this just
    // confirms SL fires as expected ahead of trailing/reversal/timeout.
    const decision = evaluateExit(inputs({ currentPriceSol: 0.9 }), cfg); // -10% pnl
    expect(decision.reason).toBe('dynamic_sl');
  });

  it('momentum_tp is chosen over quick_tp when momentum is still confirmed positive', () => {
    const decision = evaluateExit(
      inputs({ currentPriceSol: 1.05, recentMomentumPct: 1 }), // +5% pnl, momentum positive
      cfg,
    );
    expect(decision.reason).toBe('momentum_tp');
  });

  it('falls through to quick_tp when the momentum threshold is not met', () => {
    const decision = evaluateExit(inputs({ currentPriceSol: 1.025, recentMomentumPct: 0.1 }), cfg); // +2.5% pnl
    expect(decision.reason).toBe('quick_tp');
  });

  it('reaches max_hold_timeout when nothing else has triggered and time has elapsed', () => {
    const decision = evaluateExit(
      inputs({ nowMs: cfg.maxHoldTimeSec * 1000, currentPriceSol: 1.0001, recentVolatilityPct: 0 }),
      cfg,
    );
    expect(decision.reason).toBe('max_hold_timeout');
  });

  it('reaches liquidity_deterioration ahead of max_hold_timeout when liquidity has collapsed', () => {
    const decision = evaluateExit(
      inputs({
        nowMs: cfg.maxHoldTimeSec * 1000,
        currentPriceSol: 1.0001,
        currentLiquiditySol: 10, // entry liquidity was 40 -> -75%
        recentVolatilityPct: 0,
      }),
      cfg,
    );
    expect(decision.reason).toBe('liquidity_deterioration');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P1 fix #2: emergency-stop / max-hold-timeout must not depend on price availability. Previously the CALLER
// (positionMonitor.pollOne) returned before evaluateExit() ever ran whenever the price provider answered null,
// silently skipping every condition including the two that never needed a price to begin with. Fixed here, at the
// single point that decides what is safe to evaluate without a current market reading.
// ---------------------------------------------------------------------------------------------------------------------
describe('evaluateExit: currentPriceSol unavailable (null)', () => {
  it('circuit_breaker still fires with no price at all', () => {
    const decision = evaluateExit(inputs({ currentPriceSol: null, emergencyStopTriggered: true }), cfg);
    expect(decision).toEqual({ shouldExit: true, reason: 'circuit_breaker', details: { emergencyStopTriggered: true } });
  });

  it('max_hold_timeout still fires with no price at all', () => {
    const decision = evaluateExit(inputs({ currentPriceSol: null, nowMs: cfg.maxHoldTimeSec * 1000 }), cfg);
    expect(decision.reason).toBe('max_hold_timeout');
  });

  it('no non-price exit condition applies => shouldExit is false, nothing is fabricated', () => {
    const decision = evaluateExit(inputs({ currentPriceSol: null, currentLiquiditySol: null, nowMs: 1000 }), cfg);
    expect(decision).toEqual({ shouldExit: false });
  });

  it('every price-dependent condition is skipped: dynamic_sl/momentum_tp/quick_tp/trailing_stop/reversal never fire on a null price, however the position looks', () => {
    // Inputs that would trigger dynamic_sl (via a real price) if price WERE available -- proves the skip is real,
    // not a coincidence of these specific numbers.
    const decision = evaluateExit(
      inputs({ currentPriceSol: null, recentVolatilityPct: 50, recentMomentumPct: -50, position: position({ peakPriceSol: 5 }) }),
      cfg,
    );
    expect(decision).toEqual({ shouldExit: false });
  });

  it('price becoming available again on the next tick restores full price-dependent evaluation (dynamic_sl)', () => {
    const stillOpen = evaluateExit(inputs({ currentPriceSol: null }), cfg);
    expect(stillOpen.shouldExit).toBe(false);
    const decision = evaluateExit(inputs({ currentPriceSol: 0.9 }), cfg); // -10% pnl
    expect(decision.reason).toBe('dynamic_sl');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P2 fix: do not substitute stale liquidity for current liquidity. currentLiquiditySol is now independently
// nullable from currentPriceSol -- either can be missing while the other is present.
// ---------------------------------------------------------------------------------------------------------------------
describe('evaluateExit: currentLiquiditySol unavailable (null)', () => {
  it('liquidity_deterioration is skipped when liquidity is unavailable, even though entry liquidity collapsed by every other measure', () => {
    const decision = evaluateExit(
      inputs({ currentLiquiditySol: null, currentPriceSol: 1.0001, recentVolatilityPct: 0, nowMs: 1000 }),
      cfg,
    );
    expect(decision).toEqual({ shouldExit: false }); // NOT liquidity_deterioration, and not max_hold_timeout either yet
  });

  it('price-dependent conditions still evaluate normally when only liquidity is unavailable', () => {
    const decision = evaluateExit(inputs({ currentLiquiditySol: null, currentPriceSol: 0.9 }), cfg); // -10% pnl
    expect(decision.reason).toBe('dynamic_sl');
  });

  it('max_hold_timeout still fires when only liquidity is unavailable', () => {
    const decision = evaluateExit(
      inputs({ currentLiquiditySol: null, currentPriceSol: 1.0001, recentVolatilityPct: 0, nowMs: cfg.maxHoldTimeSec * 1000 }),
      cfg,
    );
    expect(decision.reason).toBe('max_hold_timeout');
  });

  it('circuit_breaker still takes priority when only liquidity is unavailable', () => {
    const decision = evaluateExit(inputs({ currentLiquiditySol: null, emergencyStopTriggered: true }), cfg);
    expect(decision.reason).toBe('circuit_breaker');
  });

  it('both price and liquidity unavailable simultaneously: only the two non-market conditions can still fire', () => {
    const neither = evaluateExit(inputs({ currentPriceSol: null, currentLiquiditySol: null, nowMs: 1000 }), cfg);
    expect(neither).toEqual({ shouldExit: false });
    const stop = evaluateExit(inputs({ currentPriceSol: null, currentLiquiditySol: null, emergencyStopTriggered: true }), cfg);
    expect(stop.reason).toBe('circuit_breaker');
    const hold = evaluateExit(inputs({ currentPriceSol: null, currentLiquiditySol: null, nowMs: cfg.maxHoldTimeSec * 1000 }), cfg);
    expect(hold.reason).toBe('max_hold_timeout');
  });

  it('current liquidity available => existing behavior unchanged (still reaches liquidity_deterioration ahead of max_hold_timeout)', () => {
    const decision = evaluateExit(
      inputs({ nowMs: cfg.maxHoldTimeSec * 1000, currentPriceSol: 1.0001, currentLiquiditySol: 10, recentVolatilityPct: 0 }),
      cfg,
    );
    expect(decision.reason).toBe('liquidity_deterioration');
  });
});
