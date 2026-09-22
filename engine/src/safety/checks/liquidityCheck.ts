export function evaluateLiquidity(
  liquiditySol: number | null | undefined,
  minLiquiditySol: number,
): { passed: boolean; reason?: string } {
  if (liquiditySol === null || liquiditySol === undefined || !Number.isFinite(liquiditySol)) {
    return { passed: false, reason: 'liquidity_unavailable' };
  }
  if (liquiditySol < minLiquiditySol) {
    return { passed: false, reason: 'liquidity_below_minimum' };
  }
  return { passed: true };
}
