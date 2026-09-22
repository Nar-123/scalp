import type { AppConfig } from '../config/schema.js';

/**
 * Extracted from orchestrator/loop.ts into its own module (Phase 5) so it
 * has a neutral home both the live orchestrator AND anything that reuses
 * it (backtest/replayEngine.ts since Phase 3-alt, shadow/shadowRunner.ts
 * since Phase 5) can import without loop.ts having to import THEM back --
 * shadow/shadowRunner.ts needs this function, and loop.ts needs to import
 * ShadowRunner to wire shadow into the live tick loop, which would
 * otherwise be a circular import.
 */
export function collectBaselineFilterFailures(
  liquidityVolume: { liquiditySol: number; volume1mSol: number | null; buySellRatio: number | null },
  priceVelocity5sPct: number,
  volumeAccelerationX: number | null,
  estimatedPriceImpactPct: number | null,
  cfg: AppConfig,
): string[] {
  const failures: string[] = [];
  if (liquidityVolume.liquiditySol < cfg.filters.minLiquiditySol) failures.push('liquidity_below_minimum');
  // Unavailable 1-minute volume can never pass: an unknown value is not "enough" volume.
  if (liquidityVolume.volume1mSol === null) failures.push('volume_1m_unavailable');
  else if (liquidityVolume.volume1mSol < cfg.filters.minVolume1mSol) failures.push('volume_below_minimum');
  // Native data (Phase 5.5) can be unable to define a ratio (no trades in the window); unknown is never "enough".
  if (liquidityVolume.buySellRatio === null) failures.push('buy_sell_ratio_unavailable');
  else if (liquidityVolume.buySellRatio < cfg.filters.minBuySellRatio) failures.push('buy_sell_ratio_below_minimum');
  if (priceVelocity5sPct < cfg.filters.minPriceVelocity5sPct) failures.push('price_velocity_below_minimum');
  if (volumeAccelerationX === null) failures.push('volume_acceleration_unavailable');
  else if (volumeAccelerationX < cfg.filters.minVolumeAccelerationX) failures.push('volume_acceleration_below_minimum');
  // Null only comes from a native source that could not price the entry: fail closed, never substitute a default.
  if (estimatedPriceImpactPct === null) failures.push('price_impact_unavailable');
  else if (estimatedPriceImpactPct > cfg.filters.maxPriceImpactPct) failures.push('price_impact_above_maximum');
  return failures;
}
