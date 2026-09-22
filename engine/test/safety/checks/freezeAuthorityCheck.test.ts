import { describe, expect, it } from 'vitest';
import { evaluateFreezeAuthority } from '../../../src/safety/checks/freezeAuthorityCheck.js';
import type { MintAccountSummary } from '../../../src/types/token.js';

function summary(overrides: Partial<MintAccountSummary> = {}): MintAccountSummary {
  return { mint: 'MINT', mintAuthority: null, freezeAuthority: null, supply: 1_000_000n, decimals: 6, ...overrides };
}

describe('evaluateFreezeAuthority', () => {
  it('fails closed when the account is unavailable', () => {
    expect(evaluateFreezeAuthority(null)).toEqual({ passed: false, reason: 'mint_account_unavailable' });
  });

  it('passes when no freeze authority is set', () => {
    expect(evaluateFreezeAuthority(summary())).toEqual({ passed: true });
  });

  it('fails when a freeze authority is present', () => {
    const result = evaluateFreezeAuthority(summary({ freezeAuthority: 'SomeFreezeAuthority' }));
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('freeze_authority_present');
  });
});
