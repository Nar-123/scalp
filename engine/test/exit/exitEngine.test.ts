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
