import { describe, expect, it } from 'vitest';
import { evaluateEntryRisk } from '../../src/risk/riskEngine.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';
import type { RiskDecisionContext } from '../../src/risk/types.js';

const reentryCfg = { reentry: { cooldownMs: 60_000, consecutiveLossLimit: 2 } };

function ctx(overrides: Partial<RiskDecisionContext> = {}): RiskDecisionContext {
  return {
    mint: 'MINT',
    openPositions: [],
    dailyRealizedPnlSol: 0,
    dailyStartingBalanceSol: 10,
    dailyCircuitBreakerAlreadyTriggered: false,
    emergencyStopTriggered: false,
    tokenHistory: { mint: 'MINT', totalTrades: 0, lastTradeExitTimeMs: null, lastTradeWasLoss: null, consecutiveLosses: 0, cumulativePnlSol: 0 },
    now: 1_000_000,
    ...overrides,
  };
}

describe('evaluateEntryRisk', () => {
  it('allows a clean first entry and sizes it at the fixed hard position size', () => {
    const decision = evaluateEntryRisk(ctx(), HARD_RISK_PARAMETERS, reentryCfg);
    expect(decision.allowed).toBe(true);
    expect(decision.sizingSol).toBe(HARD_RISK_PARAMETERS.positionSizeSol);
    expect(decision.reasons).toEqual([]);
  });

  it('blocks and zero-sizes when the emergency stop is triggered', () => {
    const decision = evaluateEntryRisk(ctx({ emergencyStopTriggered: true }), HARD_RISK_PARAMETERS, reentryCfg);
    expect(decision.allowed).toBe(false);
    expect(decision.sizingSol).toBe(0);
    expect(decision.reasons).toContain('emergency_stop_triggered');
  });

  it('blocks when the daily circuit breaker is already latched', () => {
    const decision = evaluateEntryRisk(ctx({ dailyCircuitBreakerAlreadyTriggered: true }), HARD_RISK_PARAMETERS, reentryCfg);
    expect(decision.allowed).toBe(false);
    expect(decision.circuitBreakerTriggered).toBe(true);
    expect(decision.reasons).toContain('daily_loss_circuit_breaker_triggered');
  });

  it('newly latches the circuit breaker when this evaluation crosses the daily loss threshold', () => {
    const decision = evaluateEntryRisk(
      ctx({ dailyRealizedPnlSol: -1, dailyStartingBalanceSol: 10 }), // exactly -10%
      HARD_RISK_PARAMETERS,
      reentryCfg,
    );
    expect(decision.circuitBreakerTriggered).toBe(true);
    expect(decision.allowed).toBe(false);
  });

  it('blocks on exposure limits independent of circuit breaker/reentry state', () => {
    const positions = Array.from({ length: HARD_RISK_PARAMETERS.maxConcurrentPositions }, (_, i) => ({
      tradeId: `t${i}`,
      mint: `m${i}`,
      entrySizeSol: 0.01,
    }));
    const decision = evaluateEntryRisk(ctx({ openPositions: positions }), HARD_RISK_PARAMETERS, reentryCfg);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('max_concurrent_positions_reached');
  });

  it('blocks re-entry beyond the max-reentries cap', () => {
    const decision = evaluateEntryRisk(
      ctx({
        tokenHistory: {
          mint: 'MINT',
          totalTrades: HARD_RISK_PARAMETERS.maxReentriesPerToken + 1,
          lastTradeExitTimeMs: 0,
          lastTradeWasLoss: false,
          consecutiveLosses: 0,
          cumulativePnlSol: 0,
        },
      }),
      HARD_RISK_PARAMETERS,
      reentryCfg,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('max_reentries_per_token_reached');
  });

  it('accumulates every applicable rejection reason rather than short-circuiting on the first', () => {
    const positions = Array.from({ length: HARD_RISK_PARAMETERS.maxConcurrentPositions }, (_, i) => ({
      tradeId: `t${i}`,
      mint: `m${i}`,
      entrySizeSol: 0.01,
    }));
    const decision = evaluateEntryRisk(
      ctx({ emergencyStopTriggered: true, openPositions: positions }),
      HARD_RISK_PARAMETERS,
      reentryCfg,
    );
    expect(decision.reasons).toContain('emergency_stop_triggered');
    expect(decision.reasons).toContain('max_concurrent_positions_reached');
  });
});
