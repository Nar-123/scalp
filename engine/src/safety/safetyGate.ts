import type { AppConfig } from '../config/schema.js';
import type { SafetyCheckResult } from '../types/signals.js';
import type { SafetyGateDeps } from './types.js';
import { fetchMintAccountSummary, evaluateMintAuthority } from './checks/mintAuthorityCheck.js';
import { evaluateFreezeAuthority } from './checks/freezeAuthorityCheck.js';
import { fetchLargestHolders, evaluateHolderConcentration } from './checks/holderConcentrationCheck.js';
import { evaluateLiquidity } from './checks/liquidityCheck.js';
import { evaluateSellability } from './checks/sellabilityHeuristic.js';

export interface RunSafetyGateResult extends SafetyCheckResult {
  mintAuthorityRenounced: boolean | null;
  freezeAuthorityRenounced: boolean | null;
  top10HolderPct: number | null;
  liquiditySol: number | null;
}

/**
 * Runs every deterministic safety check for a candidate mint. Fails closed:
 * any check that cannot obtain valid data counts as a failure, never a pass.
 */
export async function runSafetyGate(
  mint: string,
  deps: SafetyGateDeps,
  cfg: Pick<AppConfig, 'safety' | 'filters' | 'edge'>,
): Promise<RunSafetyGateResult> {
  const reasons: string[] = [];
  const details: Record<string, unknown> = {};

  const mintSummary = await fetchMintAccountSummary(deps.connection, mint);
  const mintAuthorityResult = evaluateMintAuthority(mintSummary);
  const freezeAuthorityResult = evaluateFreezeAuthority(mintSummary);
  if (!mintAuthorityResult.passed) reasons.push(mintAuthorityResult.reason ?? 'mint_authority_check_failed');
  if (!freezeAuthorityResult.passed) reasons.push(freezeAuthorityResult.reason ?? 'freeze_authority_check_failed');

  let top10HolderPct: number | null = null;
  if (mintSummary) {
    const largestHolders = await fetchLargestHolders(deps.connection, mint);
    if (largestHolders === null) {
      reasons.push('holder_data_unavailable');
    } else {
      const holderResult = evaluateHolderConcentration(
        { largestAccounts: largestHolders, totalSupply: mintSummary.supply, excludeAddresses: cfg.safety.excludeAddresses },
        cfg.safety.maxTop10HolderPct,
      );
      top10HolderPct = holderResult.top10Pct;
      if (!holderResult.passed) reasons.push(holderResult.reason ?? 'holder_concentration_check_failed');
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
  const sellabilityResult = evaluateSellability(roundTripQuote, cfg.edge.safetyMarginBps / 100 + cfg.filters.maxPriceImpactPct * 2);
  if (!sellabilityResult.passed) reasons.push(sellabilityResult.reason ?? 'sellability_check_failed');

  details.mintAuthority = mintSummary?.mintAuthority ?? null;
  details.freezeAuthority = mintSummary?.freezeAuthority ?? null;
  details.top10HolderPct = top10HolderPct;
  details.liquiditySol = liquidityVolume?.liquiditySol ?? null;
  details.impliedRoundTripLossPct = sellabilityResult.impliedRoundTripLossPct ?? null;

  return {
    passed: reasons.length === 0,
    reasons,
    details,
    mintAuthorityRenounced: mintSummary ? mintAuthorityResult.passed : null,
    freezeAuthorityRenounced: mintSummary ? freezeAuthorityResult.passed : null,
    top10HolderPct,
    liquiditySol: liquidityVolume?.liquiditySol ?? null,
  };
}
