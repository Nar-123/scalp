import { isFiniteNumber } from '../utils/math.js';

/**
 * DexScreener response -> V1 units, as ONE pure, fail-closed function.
 *
 * UNIT CONTRACT (verified against live responses, Phase 5.2):
 *
 *   liquidity.base   amount of the BASE token (a token quantity)   -- never SOL
 *   liquidity.quote  amount of the QUOTE asset, in that asset's own units.
 *                    It is SOL only when quoteToken.address is wrapped SOL.
 *                    For a TOKEN/USDC pair it is USDC.
 *   liquidity.usd    USD value
 *   volume.m5/h1/..  USD volume for that trailing window
 *   priceNative      price of the BASE token in units of the QUOTE asset
 *                    (SOL only when the quote is wrapped SOL)
 *   priceUsd         USD price of the BASE token
 *   txns.m5 / h1     buy / sell COUNTS for that trailing window
 *
 * Rule: UNKNOWN UNIT != SOL. A value is only reported in SOL when the pair
 * proves it (base token == requested mint AND quote token == wrapped SOL);
 * otherwise the field is unavailable (null), never a relabelled number.
 */

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Sanity guard on the derived SOL/USD reference (USD per SOL). It only
 * rejects garbage (zero, absurd ratios from a corrupt payload); it is not a
 * price view and is deliberately very wide.
 */
export const SOL_USD_SANITY_MIN = 1;
export const SOL_USD_SANITY_MAX = 10_000;

export interface DexscreenerPair {
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  liquidity?: { base?: number; quote?: number; usd?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
  priceNative?: string;
  priceUsd?: string;
}

export interface InterpretedPairMarketData {
  pairAddress: string | null;
  dexId: string | null;
  /** Price of the token in SOL (priceNative of a TOKEN/SOL pair). */
  priceSol: number | null;
  /** SOL-side pool liquidity (liquidity.quote of a TOKEN/SOL pair). null if unprovable. */
  liquiditySol: number | null;
  /**
   * Real 1-minute volume in SOL. ALWAYS null with DexScreener: it publishes
   * m5/h1/h6/h24 windows only, and a 5-minute total (or its per-minute mean)
   * is not a 1-minute observation. Never derived from m5.
   */
  volume1mSol: null;
  /** Trailing-5-minute volume converted USD -> SOL with a same-response reference. Informational; never used as volume1mSol. */
  volume5mSol: number | null;
  /** USD per SOL derived from this pair's own priceUsd / priceNative (same response snapshot). */
  solUsdReference: number | null;
  buySellRatio: number;
  /** Buy+sell transactions per minute, as the trailing-window mean (m5/5, else h1/60). A count rate, not a 1-minute observation. */
  txCountPerMinute: number;
  txWindow: 'm5' | 'h1' | 'none';
}

/** True only when the pair proves it is TOKEN(mint)/SOL. */
export function isTokenSolPair(pair: DexscreenerPair, mint: string): boolean {
  return pair.baseToken?.address === mint && pair.quoteToken?.address === WSOL_MINT;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return isFiniteNumber(n) ? n : null;
}

/**
 * Picks the eligible (TOKEN/SOL) pair with the largest SOL-side liquidity.
 * Non-SOL-quoted pairs are never candidates: comparing or returning them
 * would mix units.
 */
export function pickTokenSolPair(pairs: DexscreenerPair[] | null | undefined, mint: string): DexscreenerPair | null {
  if (!Array.isArray(pairs)) return null;
  const eligible = pairs.filter((p) => isTokenSolPair(p, mint));
  if (eligible.length === 0) return null;
  let best: DexscreenerPair | null = null;
  let bestLiquidity = -Infinity;
  for (const pair of eligible) {
    const q = num(pair.liquidity?.quote);
    if (q !== null && q > bestLiquidity) {
      bestLiquidity = q;
      best = pair;
    }
  }
  return best ?? eligible[0] ?? null;
}

export function deriveSolUsdReference(pair: DexscreenerPair): number | null {
  const priceNative = num(pair.priceNative);
  const priceUsd = num(pair.priceUsd);
  if (priceNative === null || priceUsd === null || priceNative <= 0 || priceUsd <= 0) return null;
  const ref = priceUsd / priceNative;
  return ref >= SOL_USD_SANITY_MIN && ref <= SOL_USD_SANITY_MAX ? ref : null;
}

/** Interprets ONE pair. Returns null when the pair is not provably TOKEN/SOL. */
export function interpretPair(pair: DexscreenerPair, mint: string): InterpretedPairMarketData | null {
  if (!isTokenSolPair(pair, mint)) return null;

  const liquidityQuote = num(pair.liquidity?.quote);
  const liquiditySol = liquidityQuote !== null && liquidityQuote >= 0 ? liquidityQuote : null;

  const priceNative = num(pair.priceNative);
  const priceSol = priceNative !== null && priceNative > 0 ? priceNative : null;

  const solUsdReference = deriveSolUsdReference(pair);
  const volumeM5Usd = num(pair.volume?.m5);
  const volume5mSol = solUsdReference !== null && volumeM5Usd !== null && volumeM5Usd >= 0 ? volumeM5Usd / solUsdReference : null;

  const useM5 = pair.txns?.m5 !== undefined;
  const txns = pair.txns?.m5 ?? pair.txns?.h1;
  const buys = num(txns?.buys) ?? 0;
  const sells = num(txns?.sells) ?? 0;
  const txWindow: 'm5' | 'h1' | 'none' = useM5 ? 'm5' : pair.txns?.h1 !== undefined ? 'h1' : 'none';
  const buySellRatio = sells > 0 ? buys / sells : buys > 0 ? Number.POSITIVE_INFINITY : 0;

  return {
    pairAddress: pair.pairAddress ?? null,
    dexId: pair.dexId ?? null,
    priceSol,
    liquiditySol,
    volume1mSol: null,
    volume5mSol,
    solUsdReference,
    buySellRatio,
    txCountPerMinute: (buys + sells) / (useM5 ? 5 : 60),
    txWindow,
  };
}
