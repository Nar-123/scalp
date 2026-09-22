import type { AppConfig } from '../config/schema.js';
import type { SafetyCheckResult } from '../types/signals.js';
import type { SafetyGateDeps } from './types.js';
import { evaluateMintAuthority } from './checks/mintAuthorityCheck.js';
import { DirectSafetyDataSource } from './dataSource.js';
import { evaluateFreezeAuthority } from './checks/freezeAuthorityCheck.js';
import { evaluateToken2022Extensions } from './checks/token2022ExtensionCheck.js';
import { evaluateHolderPolicy, type HolderPolicyDiagnostics } from './checks/holderPolicy.js';
import { verifyBondingCurveVault, type VaultOutcome } from './bondingCurveVault.js';
import { evaluateLiquidity } from './checks/liquidityCheck.js';
import { evaluateSellability } from './checks/sellabilityHeuristic.js';

export interface RunSafetyGateResult extends SafetyCheckResult {
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  top10HolderPct: number | null;
  liquiditySol: number | null;
  /**
   * Wall-clock time of the OLDEST piece of external data the verdict relied on (mint, holders, round-trip quote);
   * null when none was obtained. The caller must not act on a verdict whose data is older than the decision bound.
   */
  dataAsOfMs?: number | null;
  /** Phase 5.6E: how the holder-concentration decision was made (policy, vault verification, circulating supply, creator share). */
  holderPolicy?: HolderPolicyDiagnostics;
}

/**
 * Runs every deterministic safety check for a candidate mint. Fails closed:
 * any check that cannot obtain valid data counts as a failure, never a pass.
 */
export async function runSafetyGate(
  mint: string,
  deps: SafetyGateDeps,
  cfg: Pick<AppConfig, 'filters' | 'edge'> & {
    /** The Phase 5.6E safeguards are optional here (absent = off) so callers/fixtures written before them keep working. */
    safety: Pick<AppConfig['safety'], 'maxTop10HolderPct' | 'excludeAddresses'> & Partial<Pick<AppConfig['safety'], 'minCirculatingSharePct' | 'minVisibleHolders'>>;
  },
): Promise<RunSafetyGateResult> {
  const reasons: string[] = [];
  const details: Record<string, unknown> = {};

  const data = deps.data ?? new DirectSafetyDataSource(deps.connection);
  const asOf: number[] = [];
  const failures: Record<string, string> = {};
  const note = (source: 'mint' | 'holders' | 'vault' | 'quote', kind: string, reason: string): void => {
    failures[source] = `${kind}:${reason}`;
    deps.onUnavailable?.(source, `${kind}:${reason}`);
  };

  const mintFetch = await data.getMintSummary(mint);
  const mintSummary = mintFetch.value;
  if (mintSummary) asOf.push(mintFetch.asOfMs);
  else if (mintFetch.failure) note('mint', mintFetch.failure.kind, mintFetch.failure.reason);
  const mintAuthorityResult = evaluateMintAuthority(mintSummary);
  const freezeAuthorityResult = evaluateFreezeAuthority(mintSummary);
  if (!mintAuthorityResult.passed) reasons.push(mintAuthorityResult.reason ?? 'mint_authority_check_failed');
  if (!freezeAuthorityResult.passed) reasons.push(freezeAuthorityResult.reason ?? 'freeze_authority_check_failed');
  // Token-2022: every extension must be understood and safe (classic SPL mints are untouched by this check).
  const token2022Result = evaluateToken2022Extensions(mintSummary);
  reasons.push(...token2022Result.reasons);

  let top10HolderPct: number | null = null;
  let holderPolicy: HolderPolicyDiagnostics | undefined;
  if (mintSummary) {
    const holderFetch = await data.getLargestHolders(mint);
    const largestHolders = holderFetch.value;
    if (largestHolders !== null) asOf.push(holderFetch.asOfMs);
    else if (holderFetch.failure) note('holders', holderFetch.failure.kind, holderFetch.failure.reason);
    if (largestHolders === null) {
      reasons.push('holder_data_unavailable');
    } else {
      // Where does the vault stand? Pump.fun curve + vault read in one call, then the seven checks (bondingCurveVault.ts).
      const curveFetch = await data.getBondingCurveAccounts(mint, mintSummary);
      let vault: VaultOutcome;
      if (curveFetch.value) {
        asOf.push(curveFetch.asOfMs);
        vault = verifyBondingCurveVault(mint, { tokenProgram: mintSummary.tokenProgram ?? 'spl-token', supply: mintSummary.supply }, curveFetch.value);
      } else {
        const cause = curveFetch.failure ? `${curveFetch.failure.kind}:${curveFetch.failure.reason}` : 'no_result';
        if (curveFetch.failure) note('vault', curveFetch.failure.kind, curveFetch.failure.reason);
        vault = { status: 'unavailable', cause };
      }
      // Diagnostic only (never a rejection): the creator's tokens among the visible accounts.
      let creatorBalanceRaw: bigint | null = null;
      if (vault.status === 'verified' && vault.phase === 'live') {
        const ownersFetch = await data.getTokenAccountOwners(mint, largestHolders.map((h) => h.address));
        if (ownersFetch.value) creatorBalanceRaw = largestHolders.reduce((sum, h) => (ownersFetch.value?.[h.address] === vault.creator ? sum + h.amount : sum), 0n);
      }
      const policy = evaluateHolderPolicy({
        largestAccounts: largestHolders,
        totalSupply: mintSummary.supply,
        excludeAddresses: cfg.safety.excludeAddresses,
        maxTop10Pct: cfg.safety.maxTop10HolderPct,
        minCirculatingSharePct: cfg.safety.minCirculatingSharePct ?? 0,
        minVisibleHolders: cfg.safety.minVisibleHolders ?? 0,
        vault,
        creatorBalanceRaw,
      });
      top10HolderPct = policy.top10Pct;
      holderPolicy = policy.diagnostics;
      reasons.push(...policy.reasons);
    }
  } else {
    reasons.push('holder_data_unavailable');
  }

  // Aggregator/quote implementations are documented to never throw, but we
  // don't let a violation of that contract crash the evaluation pipeline --
  // fail closed here too.
  const liquidityVolume = await deps.aggregator.getLiquidityAndVolume(mint).catch(() => null);
  const liquidityResult = evaluateLiquidity(liquidityVolume?.liquiditySol ?? null, cfg.filters.minLiquiditySol);
  if (!liquidityResult.passed) reasons.push(liquidityResult.reason ?? 'liquidity_check_failed');

  const ROUND_TRIP_TEST_AMOUNT_SOL = 0.05;
  const roundTripQuote = await deps.getRoundTripQuote(mint, ROUND_TRIP_TEST_AMOUNT_SOL).catch(() => null);
  if (roundTripQuote?.asOfMs !== undefined) asOf.push(roundTripQuote.asOfMs);
  if (!roundTripQuote) deps.onUnavailable?.('quote', 'provider_or_route:quote_unavailable');
  const sellabilityResult = evaluateSellability(roundTripQuote, cfg.edge.safetyMarginBps / 100 + cfg.filters.maxPriceImpactPct * 2);
  if (!sellabilityResult.passed) reasons.push(sellabilityResult.reason ?? 'sellability_check_failed');

  details.mintAuthority = mintSummary?.mintAuthority ?? null;
  details.freezeAuthority = mintSummary?.freezeAuthority ?? null;
  details.top10HolderPct = top10HolderPct;
  details.liquiditySol = liquidityVolume?.liquiditySol ?? null;
  details.impliedRoundTripLossPct = sellabilityResult.impliedRoundTripLossPct ?? null;
  details.tokenProgram = mintSummary?.tokenProgram ?? (mintSummary ? 'spl-token' : null);
  details.token2022Extensions = token2022Result.extensions;
  details.holderPolicy = holderPolicy ?? null;
  details.dataFailures = failures;
  details.dataAsOfMs = asOf.length > 0 ? Math.min(...asOf) : null;

  return {
    passed: reasons.length === 0,
    reasons,
    details,
    mintAuthorityRenounced: mintSummary ? mintAuthorityResult.passed : null,
    freezeAuthorityRenounced: mintSummary ? freezeAuthorityResult.passed : null,
    top10HolderPct,
    liquiditySol: liquidityVolume?.liquiditySol ?? null,
    dataAsOfMs: asOf.length > 0 ? Math.min(...asOf) : null,
    ...(holderPolicy ? { holderPolicy } : {}),
  };
}
