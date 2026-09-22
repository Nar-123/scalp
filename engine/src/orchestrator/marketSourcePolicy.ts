import type { DiscoverySource } from '../types/token.js';
import type { NativeMarketSnapshot } from '../volume/types.js';

/**
 * Which market-data source is AUTHORITATIVE for a token (Phase 5.5). One source
 * per evaluation: a native price/liquidity/volume snapshot is never mixed with
 * DexScreener fields (they carry different timestamps and different definitions
 * of "liquidity"). Pure and deterministic; unit-tested as a table.
 *
 *  discovery source  native snapshot            route          why
 *  ----------------  -------------------------  -------------  ------------------------------------------------
 *  not pumpfun       (any)                      dexscreener    the token is not a Pump.fun curve token
 *  pumpfun           VALID                      native         primary source for a token on the bonding curve
 *  pumpfun           GRADUATED                  dexscreener    the curve ended; a separate market (PumpSwap
 *                                                              pair) may exist. Native volume stays null.
 *  pumpfun           anything else              unavailable    still (or possibly) on the curve but the native
 *                                                              state cannot be proven. DexScreener is NOT
 *                                                              consulted just because it answers faster -- unless
 *                                                              `allowDexscreenerFallback` is explicitly set.
 *
 * `market_data_unavailable` is therefore a deliberate, explained outcome for a curve token, never a silent
 * switch to another source.
 */
export type MarketRoute = 'native' | 'dexscreener' | 'unavailable';

export interface MarketRouteDecision {
  route: MarketRoute;
  /** Why the route was chosen; for `unavailable` this is the native reason (recorded on the evaluation). */
  reason: string;
}

export function decideMarketSource(
  native: NativeMarketSnapshot | null,
  ctx: { discoverySource: DiscoverySource; allowDexscreenerFallback?: boolean },
): MarketRouteDecision {
  if (ctx.discoverySource !== 'pumpfun') return { route: 'dexscreener', reason: 'not_a_pumpfun_curve_token' };
  if (native === null) return { route: 'dexscreener', reason: 'native_source_not_configured' };
  if (native.quality === 'VALID') return { route: 'native', reason: 'native_curve_valid' };
  if (native.quality === 'GRADUATED') return { route: 'dexscreener', reason: 'graduated_curve_ended' };
  if (ctx.allowDexscreenerFallback) return { route: 'dexscreener', reason: `native_${native.quality.toLowerCase()}_fallback_enabled` };
  return { route: 'unavailable', reason: `native_${native.reason ?? native.quality.toLowerCase()}` };
}
