import { describe, expect, it } from 'vitest';
import {
  simulateIfPossible,
  validateTransactionSafety,
  type TransactionSafetyContext,
} from '../../src/execution/transactionSafety.js';
import { hardLimitsFrom } from '../../src/risk/hardLimits.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';

const limits = hardLimitsFrom(HARD_RISK_PARAMETERS);

function goodContext(overrides: Partial<TransactionSafetyContext> = {}): TransactionSafetyContext {
  return {
    actualProgramId: 'PumpFunProgram1111111111111111111111111111',
    expectedProgramId: 'PumpFunProgram1111111111111111111111111111',
    actualInstructionType: 'buy',
    expectedInstructionType: 'buy',
    actualMint: 'Mint11111111111111111111111111111111111111',
    expectedMint: 'Mint11111111111111111111111111111111111111',
    amountSol: HARD_RISK_PARAMETERS.positionSizeSol,
    estimatedSlippagePct: 0.5,
    estimatedPriceImpactPct: 0.5,
    currentExposureSol: 0,
    dailyCircuitBreakerTriggered: false,
    emergencyStopTriggered: false,
    dryRun: false,
    liveTradingExplicitlyEnabled: true,
    ...overrides,
  };
}

describe('validateTransactionSafety -- happy path', () => {
  it('allows a transaction that satisfies every check', () => {
    const result = validateTransactionSafety(goodContext(), limits);
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe('validateTransactionSafety -- DRY_RUN / explicit live mode', () => {
  it('blocks when dryRun is true regardless of everything else', () => {
    const result = validateTransactionSafety(goodContext({ dryRun: true }), limits);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('dry_run_active');
  });

  it('blocks when liveTradingExplicitlyEnabled is false, even with dryRun=false', () => {
    const result = validateTransactionSafety(goodContext({ liveTradingExplicitlyEnabled: false }), limits);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('live_trading_not_explicitly_enabled');
  });
});

describe('validateTransactionSafety -- destination/program validation', () => {
  it('blocks on an unexpected program id', () => {
    const result = validateTransactionSafety(goodContext({ actualProgramId: 'SomeOtherProgram11111111111111111111111111' }), limits);
    expect(result.reasons).toContain('unexpected_program_id');
  });
});

describe('validateTransactionSafety -- instruction type validation', () => {
  it('blocks when the actual instruction type does not match what was expected', () => {
    const result = validateTransactionSafety(goodContext({ actualInstructionType: 'sell', expectedInstructionType: 'buy' }), limits);
    expect(result.reasons).toContain('unexpected_instruction_type');
  });
});

describe('validateTransactionSafety -- mint validation', () => {
  it('blocks on a mint mismatch', () => {
    const result = validateTransactionSafety(goodContext({ actualMint: 'DifferentMint111111111111111111111111111' }), limits);
    expect(result.reasons).toContain('mint_mismatch');
  });
});

describe('validateTransactionSafety -- amount validation (hard position size)', () => {
  it('blocks a zero or negative amount', () => {
    expect(validateTransactionSafety(goodContext({ amountSol: 0 }), limits).reasons).toContain('amount_out_of_bounds');
    expect(validateTransactionSafety(goodContext({ amountSol: -0.1 }), limits).reasons).toContain('amount_out_of_bounds');
  });

  it('blocks an amount exceeding the hard position size', () => {
    const result = validateTransactionSafety(goodContext({ amountSol: HARD_RISK_PARAMETERS.positionSizeSol + 0.01 }), limits);
    expect(result.reasons).toContain('amount_out_of_bounds');
  });

  it('allows exactly the hard position size', () => {
    const result = validateTransactionSafety(goodContext({ amountSol: HARD_RISK_PARAMETERS.positionSizeSol }), limits);
    expect(result.reasons).not.toContain('amount_out_of_bounds');
  });
});

describe('validateTransactionSafety -- slippage / price impact', () => {
  it('blocks slippage above the hard maximum', () => {
    const result = validateTransactionSafety(goodContext({ estimatedSlippagePct: limits.maxSlippagePct + 1 }), limits);
    expect(result.reasons).toContain('slippage_exceeds_maximum');
  });

  it('blocks price impact above the hard maximum', () => {
    const result = validateTransactionSafety(goodContext({ estimatedPriceImpactPct: limits.maxPriceImpactPct + 1 }), limits);
    expect(result.reasons).toContain('price_impact_exceeds_maximum');
  });
});

describe('validateTransactionSafety -- exposure', () => {
  it('blocks when this trade would push total exposure over the hard maximum', () => {
    const result = validateTransactionSafety(
      goodContext({ currentExposureSol: limits.maxExposureSol - HARD_RISK_PARAMETERS.positionSizeSol / 2 }),
      limits,
    );
    expect(result.reasons).toContain('exposure_limit_exceeded');
  });
});

describe('validateTransactionSafety -- daily loss state / emergency stop', () => {
  it('blocks when the daily circuit breaker is triggered', () => {
    const result = validateTransactionSafety(goodContext({ dailyCircuitBreakerTriggered: true }), limits);
    expect(result.reasons).toContain('daily_loss_circuit_breaker_triggered');
  });

  it('blocks when the emergency stop is triggered', () => {
    const result = validateTransactionSafety(goodContext({ emergencyStopTriggered: true }), limits);
    expect(result.reasons).toContain('emergency_stop_triggered');
  });
});

describe('validateTransactionSafety -- accumulates every failing reason, not just the first', () => {
  it('reports all applicable failures at once', () => {
    const result = validateTransactionSafety(
      goodContext({ dryRun: true, emergencyStopTriggered: true, actualMint: 'Wrong11111111111111111111111111111111111' }),
      limits,
    );
    expect(result.reasons).toContain('dry_run_active');
    expect(result.reasons).toContain('emergency_stop_triggered');
    expect(result.reasons).toContain('mint_mismatch');
  });
});

describe('validateTransactionSafety -- malformed numeric inputs fail closed', () => {
  it('blocks on NaN amount/slippage/impact/exposure rather than accidentally passing', () => {
    expect(validateTransactionSafety(goodContext({ amountSol: NaN }), limits).allowed).toBe(false);
    expect(validateTransactionSafety(goodContext({ estimatedSlippagePct: NaN }), limits).allowed).toBe(false);
    expect(validateTransactionSafety(goodContext({ estimatedPriceImpactPct: NaN }), limits).allowed).toBe(false);
    expect(validateTransactionSafety(goodContext({ currentExposureSol: NaN }), limits).allowed).toBe(false);
  });
});

describe('simulateIfPossible', () => {
  it('reports not-supported when no simulate function is given', async () => {
    const result = await simulateIfPossible(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('simulation_not_supported');
  });

  it('passes through a successful simulation', async () => {
    const result = await simulateIfPossible(async () => ({ ok: true }));
    expect(result.ok).toBe(true);
  });

  it('catches a throwing simulate function rather than propagating', async () => {
    const result = await simulateIfPossible(async () => {
      throw new Error('simulation failed');
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('simulation failed');
  });
});
