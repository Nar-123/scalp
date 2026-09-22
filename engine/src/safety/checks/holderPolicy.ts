import type { HolderBalance } from '../../types/token.js';
import type { VaultOutcome } from '../bondingCurveVault.js';
import { evaluateHolderConcentration } from './holderConcentrationCheck.js';

/**
 * Holder-concentration POLICY (Phase 5.6E, Option D).
 *
 *  - live Pump.fun curve, vault VERIFIED (all checks of bondingCurveVault.ts):
 *        circulating = supply - vault balance
 *        concentration = top 10 NON-vault accounts / circulating, limit unchanged (default 60%)
 *        circulating <= 0 => reject; optional safeguards (both OFF by default):
 *        minCirculatingSharePct and minVisibleHolders
 *  - curve exists but the vault cannot be verified, or cannot be read => reject `holder_vault_unknown` (fail closed)
 *  - graduated curve, or a token with no bonding curve at all => the previous metric, unchanged
 *        (top 10 / total supply; PumpSwap-owned accounts are still counted as holders: their semantics are unverified)
 *
 * Only the verified vault account is ever removed. Creator concentration is computed for the record and NEVER rejects.
 */

export interface HolderPolicyInputs {
  largestAccounts: HolderBalance[];
  totalSupply: bigint;
  excludeAddresses: string[];
  maxTop10Pct: number;
  /** 0 = safeguard off. Configurable, no default policy value. */
  minCirculatingSharePct: number;
  /** 0 = safeguard off. Configurable, no default policy value. */
  minVisibleHolders: number;
  vault: VaultOutcome;
  /** Diagnostic only: tokens held by the curve creator among the visible accounts (null = could not be determined). */
  creatorBalanceRaw: bigint | null;
}

export interface HolderPolicyDiagnostics {
  policy: 'verified_vault_excluded' | 'legacy_total_supply';
  vaultStatus: 'verified' | 'not_curve_token' | 'unverified' | 'unavailable';
  phase: 'live' | 'graduated' | null;
  vaultFailedChecks?: string[];
  vaultUnavailableCause?: string;
  vaultBalanceRaw: string | null;
  circulatingRaw: string | null;
  circulatingSharePct: number | null;
  visibleHolders: number | null;
  /** The previous metric, always computed for comparison (top 10 incl. any vault / total supply). */
  legacyTop10Pct: number;
  /** Creator's share of circulating supply among the visible top accounts (a lower bound). Never used to reject. */
  creatorPctOfCirculating: number | null;
}

export interface HolderPolicyResult {
  passed: boolean;
  reasons: string[];
  /** The concentration figure the decision used; null when no figure could be trusted (unknown vault, invalid circulating). */
  top10Pct: number | null;
  diagnostics: HolderPolicyDiagnostics;
}

const pct = (part: bigint, whole: bigint): number => Number((part * 1_000_000n) / whole) / 10_000;

export function evaluateHolderPolicy(i: HolderPolicyInputs): HolderPolicyResult {
  const legacy = evaluateHolderConcentration({ largestAccounts: i.largestAccounts, totalSupply: i.totalSupply, excludeAddresses: i.excludeAddresses }, i.maxTop10Pct);
  const base: HolderPolicyDiagnostics = {
    policy: 'legacy_total_supply',
    vaultStatus: i.vault.status,
    phase: i.vault.status === 'verified' ? i.vault.phase : null,
    vaultBalanceRaw: i.vault.status === 'verified' ? i.vault.vaultBalance.toString() : null,
    circulatingRaw: null,
    circulatingSharePct: null,
    visibleHolders: null,
    legacyTop10Pct: legacy.top10Pct,
    creatorPctOfCirculating: null,
  };
  if (i.vault.status === 'unverified') base.vaultFailedChecks = i.vault.failedChecks;
  if (i.vault.status === 'unavailable') base.vaultUnavailableCause = i.vault.cause;

  if (i.totalSupply <= 0n) return { passed: false, reasons: ['invalid_supply'], top10Pct: null, diagnostics: base };

  // Curve present but not provably the Pump.fun vault, or unreadable: never guess, never fall back to a looser metric.
  if (i.vault.status === 'unverified' || i.vault.status === 'unavailable') {
    return { passed: false, reasons: ['holder_vault_unknown'], top10Pct: null, diagnostics: base };
  }

  // No curve (not a Pump.fun token) or a graduated curve: the previous behaviour, unchanged.
  if (i.vault.status === 'not_curve_token' || i.vault.phase === 'graduated') {
    return { passed: legacy.passed, reasons: legacy.passed ? [] : [legacy.reason ?? 'holder_concentration_too_high'], top10Pct: legacy.top10Pct, diagnostics: base };
  }

  // Live curve with a verified vault.
  const vault = i.vault;
  const diagnostics: HolderPolicyDiagnostics = { ...base, policy: 'verified_vault_excluded' };
  const circulating = i.totalSupply - vault.vaultBalance;
  if (circulating <= 0n) {
    return { passed: false, reasons: ['holder_circulating_supply_invalid'], top10Pct: null, diagnostics: { ...diagnostics, circulatingRaw: circulating.toString(), circulatingSharePct: 0 } };
  }
  diagnostics.circulatingRaw = circulating.toString();
  diagnostics.circulatingSharePct = pct(circulating, i.totalSupply);

  const excluded = new Set(i.excludeAddresses);
  const nonVault = i.largestAccounts.filter((h) => h.address !== vault.vaultAddress && !excluded.has(h.address));
  diagnostics.visibleHolders = nonVault.filter((h) => h.amount > 0n).length;
  const top10 = nonVault.slice(0, 10).reduce((sum, h) => sum + h.amount, 0n);
  const top10Pct = pct(top10, circulating);
  if (i.creatorBalanceRaw !== null) diagnostics.creatorPctOfCirculating = pct(i.creatorBalanceRaw, circulating);

  const reasons: string[] = [];
  if (top10Pct > i.maxTop10Pct) reasons.push('holder_concentration_too_high');
  if (i.minCirculatingSharePct > 0 && diagnostics.circulatingSharePct < i.minCirculatingSharePct) reasons.push('holder_circulating_share_too_low');
  if (i.minVisibleHolders > 0 && diagnostics.visibleHolders < i.minVisibleHolders) reasons.push('holder_visible_holders_too_low');
  return { passed: reasons.length === 0, reasons, top10Pct, diagnostics };
}
