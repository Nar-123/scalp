import { describe, expect, it } from 'vitest';
import { evaluateMintAuthority } from '../../../src/safety/checks/mintAuthorityCheck.js';
import type { MintAccountSummary } from '../../../src/types/token.js';

function summary(overrides: Partial<MintAccountSummary> = {}): MintAccountSummary {
  return { mint: 'MINT', mintAuthority: null, freezeAuthority: null, supply: 1_000_000n, decimals: 6, ...overrides };
}

describe('evaluateMintAuthority', () => {
  it('fails closed when the account is unavailable', () => {
    expect(evaluateMintAuthority(null)).toEqual({ passed: false, reason: 'mint_account_unavailable' });
  });

  it('passes when mint authority has been renounced', () => {
    expect(evaluateMintAuthority(summary({ mintAuthority: null }))).toEqual({ passed: true });
  });

  it('fails when mint authority is still present', () => {
    const result = evaluateMintAuthority(summary({ mintAuthority: 'SomeAuthorityAddress' }));
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('mint_authority_not_renounced');
  });
});
