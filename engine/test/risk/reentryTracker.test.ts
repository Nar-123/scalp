import { describe, expect, it } from 'vitest';
import { canReenter } from '../../src/risk/reentryTracker.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';
import type { TokenTradeHistory } from '../../src/types/trade.js';

const reentryCfg = { cooldownMs: 60_000, consecutiveLossLimit: 2 };

function history(overrides: Partial<TokenTradeHistory> = {}): TokenTradeHistory {
  return {
    mint: 'MINT',
    totalTrades: 0,
    lastTradeExitTimeMs: null,
    lastTradeWasLoss: null,
    consecutiveLosses: 0,
    cumulativePnlSol: 0,
    ...overrides,
  };
}

describe('canReenter', () => {
  it('always allows the very first entry', () => {
    expect(canReenter(history({ totalTrades: 0 }), HARD_RISK_PARAMETERS, reentryCfg, 0).allowed).toBe(true);
  });

  it('allows re-entries 1 through 5 (maxReentriesPerToken=5)', () => {
    for (let totalTrades = 1; totalTrades <= HARD_RISK_PARAMETERS.maxReentriesPerToken; totalTrades++) {
      const result = canReenter(
        history({ totalTrades, lastTradeExitTimeMs: 0, consecutiveLosses: 0 }),
        HARD_RISK_PARAMETERS,
        reentryCfg,
        1_000_000,
      );
      expect(result.allowed).toBe(true);
    }
  });

  it('blocks the 6th re-entry attempt once maxReentriesPerToken has been used', () => {
    const result = canReenter(
      history({ totalTrades: HARD_RISK_PARAMETERS.maxReentriesPerToken + 1, lastTradeExitTimeMs: 0 }),
      HARD_RISK_PARAMETERS,
      reentryCfg,
      1_000_000,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('max_reentries_per_token_reached');
  });

  it('blocks when the consecutive-loss limit has been reached', () => {
    const result = canReenter(
      history({ totalTrades: 1, consecutiveLosses: 2, lastTradeExitTimeMs: 0 }),
      HARD_RISK_PARAMETERS,
      reentryCfg,
      1_000_000,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('consecutive_loss_limit_reached');
  });

  it('blocks while the cooldown window is still active', () => {
    const result = canReenter(
      history({ totalTrades: 1, lastTradeExitTimeMs: 100_000 }),
      HARD_RISK_PARAMETERS,
      reentryCfg,
      100_000 + reentryCfg.cooldownMs - 1,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('reentry_cooldown_active');
  });

  it('allows re-entry once the cooldown window has fully elapsed', () => {
    const result = canReenter(
      history({ totalTrades: 1, lastTradeExitTimeMs: 100_000, consecutiveLosses: 0 }),
      HARD_RISK_PARAMETERS,
      reentryCfg,
      100_000 + reentryCfg.cooldownMs,
    );
    expect(result.allowed).toBe(true);
  });
});
