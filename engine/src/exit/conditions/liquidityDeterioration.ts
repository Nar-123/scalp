import type { AppConfig } from '../../config/schema.js';
import { pctChange } from '../../utils/math.js';

export function checkLiquidityDeterioration(
  entryLiquiditySol: number,
  currentLiquiditySol: number,
  cfg: Pick<AppConfig['exits'], 'liquidityDeteriorationPct'>,
): boolean {
  if (entryLiquiditySol <= 0 || !Number.isFinite(currentLiquiditySol)) return true;
  const dropPct = -pctChange(entryLiquiditySol, currentLiquiditySol);
  return dropPct >= cfg.liquidityDeteriorationPct;
}
