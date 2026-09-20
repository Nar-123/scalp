import type { MintAccountSummary } from '../../types/token.js';

export function evaluateFreezeAuthority(summary: MintAccountSummary | null): { passed: boolean; reason?: string } {
  if (!summary) return { passed: false, reason: 'mint_account_unavailable' };
  if (summary.freezeAuthority !== null) {
    return { passed: false, reason: 'freeze_authority_present' };
  }
  return { passed: true };
}
