import type { CurveState } from './types.js';

/**
 * Pump.fun bonding-curve arithmetic (PURE, exact bigint math, no I/O).
 *
 * VERIFIED (Phase 5.5, real mainnet, 2,582 SOL-quoted TradeEvents + 8 curve
 * accounts):
 *  - The curve is a constant-product AMM over the VIRTUAL reserves:
 *      virtual_sol * virtual_token = k   (k is preserved by every step up to a
 *      dust of ~1 lamport of the traded side).
 *  - Every TradeEvent carries the POST-trade reserves; a chain of events of one
 *    mint satisfies  post(n) = post(n-1) +/- (sol_amount, token_amount)  exactly
 *    (1,676 of 1,678 links on standard curves).
 *  - Selling follows  sol_out = floor(tok * vSol / (vTok + tok))  exactly;
 *    buying follows  tokens_out = floor(net * vTok / (vSol + net))  to within
 *    ~1 lamport of `net` (the program's own rounding), which is < 1e-8 relative
 *    for any trade V1 can make.
 *  - `real_sol_reserves` == the curve account's lamports minus its rent-exempt
 *    minimum (1,417,320 lamports for the 151-byte account), exactly, on all 8
 *    accounts inspected.
 *  - Token mints of curves have 6 decimals (8 of 8 verified on-chain).
 *  - is_mayhem_mode curves do NOT follow the standard virtual-reserve mechanics
 *    (virtual SOL moves ~100x the real SOL per trade): unsupported, never priced.
 */

export const PUMPFUN_TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
const SCALE = 1_000_000_000_000n; // 1e12 fixed point for ratios close to 1 (impact)
const PRICE_SCALE = 10n ** 30n; // token prices are ~1e-8 SOL: needs far more fixed-point digits than a ratio

const BPS = 10_000n;

/** Relative tolerance for "this step preserved k": 1e-6 (observed deviations are < 1e-9). */
const K_TOLERANCE_NUM = 1n;
const K_TOLERANCE_DEN = 1_000_000n;

/** SOL per WHOLE token: (virtual_sol / 1e9) / (virtual_token / 10^decimals). null if either reserve is not positive. */
export function spotPriceSol(virtualSol: bigint, virtualToken: bigint, decimals: number = PUMPFUN_TOKEN_DECIMALS): number | null {
  if (virtualSol <= 0n || virtualToken <= 0n) return null;
  const scaled = (virtualSol * 10n ** BigInt(decimals) * PRICE_SCALE) / (virtualToken * LAMPORTS_PER_SOL);
  const price = Number(scaled) / Number(PRICE_SCALE);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** SOL actually held by the curve. This is what V1's liquiditySol means for a bonding curve (see docs). */
export function realSolLiquidity(realSolReserves: bigint): number {
  return Number(realSolReserves) / Number(LAMPORTS_PER_SOL);
}

/** Portion of a total SOL spend that reaches the curve after the protocol and creator fees (both charged on top of the curve amount). */
export function entryNetLamports(totalLamports: bigint, feeBasisPoints: number, creatorFeeBasisPoints: number): bigint {
  const rate = BigInt(feeBasisPoints) + BigInt(creatorFeeBasisPoints);
  return (totalLamports * BPS) / (BPS + rate);
}

/** Tokens (base units) the curve pays for `netLamports` of SOL: constant-product, floor. */
export function tokensOutForNetSol(virtualSol: bigint, virtualToken: bigint, netLamports: bigint): bigint {
  if (netLamports <= 0n || virtualSol <= 0n || virtualToken <= 0n) return 0n;
  return (netLamports * virtualToken) / (virtualSol + netLamports);
}

/**
 * Buy price impact in percent, EXECUTION price versus the pre-trade SPOT price,
 * fees excluded (they are a separate, fixed cost and would make every trade fail
 * a 1 % limit):
 *
 *    impact = (net / tokensOut) / (vSol / vTok) - 1
 *
 * For a constant-product curve this equals net / vSol (+ rounding), i.e. the
 * classic "trade size / VIRTUAL SOL reserve" -- NOT trade size / real
 * liquidity. The exact bigint expression is used; the identity is asserted in
 * the tests. Returns null when the buy cannot be priced (empty reserves, or it
 * would exceed the tokens left on the curve, i.e. it would graduate it).
 */
export function buyPriceImpactPct(state: Pick<CurveState, 'virtualSolReserves' | 'virtualTokenReserves' | 'realTokenReserves'>, netLamports: bigint): number | null {
  const out = tokensOutForNetSol(state.virtualSolReserves, state.virtualTokenReserves, netLamports);
  if (out <= 0n || out > state.realTokenReserves) return null;
  const ratioScaled = (netLamports * state.virtualTokenReserves * SCALE) / (out * state.virtualSolReserves);
  const impact = (Number(ratioScaled - SCALE) / Number(SCALE)) * 100;
  return Number.isFinite(impact) && impact >= 0 ? impact : null;
}

export interface PreTradeState {
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
}

/** State BEFORE a trade, recovered from the post-trade reserves and the trade's own amounts. */
export function preTradeState(post: CurveState, isBuy: boolean, solAmountLamports: number, tokenAmount: bigint): PreTradeState {
  const sol = BigInt(solAmountLamports);
  return isBuy
    ? { virtualSol: post.virtualSolReserves - sol, virtualToken: post.virtualTokenReserves + tokenAmount, realSol: post.realSolReserves - sol, realToken: post.realTokenReserves + tokenAmount }
    : { virtualSol: post.virtualSolReserves + sol, virtualToken: post.virtualTokenReserves - tokenAmount, realSol: post.realSolReserves + sol, realToken: post.realTokenReserves - tokenAmount };
}

/**
 * Is this trade a valid constant-product step? (k preserved within 1e-6, reserves positive, real <= virtual.)
 * Fails for mayhem-mode curves and for any payload whose reserves do not belong to the amounts it reports.
 */
export function isConstantProductStep(post: CurveState, isBuy: boolean, solAmountLamports: number, tokenAmount: bigint): boolean {
  const pre = preTradeState(post, isBuy, solAmountLamports, tokenAmount);
  if (pre.virtualSol <= 0n || pre.virtualToken <= 0n || pre.realSol < 0n || pre.realToken < 0n) return false;
  if (post.virtualSolReserves <= 0n || post.virtualTokenReserves <= 0n) return false;
  if (post.realSolReserves > post.virtualSolReserves || post.realTokenReserves > post.virtualTokenReserves) return false;
  const kPre = pre.virtualSol * pre.virtualToken;
  const kPost = post.virtualSolReserves * post.virtualTokenReserves;
  const diff = kPost > kPre ? kPost - kPre : kPre - kPost;
  return diff * K_TOLERANCE_DEN <= kPre * K_TOLERANCE_NUM;
}

/** Does `event`'s pre-trade state equal the previous event's post-trade state (no trade missing between them)? */
export function chainLinks(previousPost: CurveState, post: CurveState, isBuy: boolean, solAmountLamports: number, tokenAmount: bigint): boolean {
  const pre = preTradeState(post, isBuy, solAmountLamports, tokenAmount);
  return (
    pre.virtualSol === previousPost.virtualSolReserves &&
    pre.virtualToken === previousPost.virtualTokenReserves &&
    pre.realSol === previousPost.realSolReserves &&
    pre.realToken === previousPost.realTokenReserves
  );
}

/** SOL (lamports) the curve pays for `tokens` base units sold into it: constant-product, floor. Fees excluded. */
export function solOutForTokens(virtualSol: bigint, virtualToken: bigint, tokens: bigint): bigint {
  if (tokens <= 0n || virtualSol <= 0n || virtualToken <= 0n) return 0n;
  return (tokens * virtualSol) / (virtualToken + tokens);
}

/**
 * SELL price impact in percent: how far the EXECUTION price of selling `tokens` into the curve falls below the
 * pre-trade SPOT price, fees excluded (Phase 5.6):
 *
 *    solOut = floor(tokens * vSol / (vTok + tokens))
 *    impact = 1 - (solOut / tokens) / (vSol / vTok)          [= tokens / (vTok + tokens), the exact identity]
 *
 * It is a different quantity from the BUY impact: it depends on the TOKEN reserve (tokens / (vTok + tokens)), not on
 * the SOL reserve (net / (vSol + net)) -- so it can never be replaced by the buy figure, nor by `amount / liquidity`.
 *
 * Returns null (fail closed) when the sale cannot be priced: empty reserves, nothing to sell, or the curve does not
 * hold enough real SOL to pay the proceeds (the sale would be impossible, not merely expensive).
 */
export function sellPriceImpactPct(
  state: Pick<CurveState, 'virtualSolReserves' | 'virtualTokenReserves' | 'realSolReserves'>,
  tokens: bigint,
): number | null {
  const out = solOutForTokens(state.virtualSolReserves, state.virtualTokenReserves, tokens);
  if (out <= 0n || out > state.realSolReserves) return null;
  const ratioScaled = (out * state.virtualTokenReserves * SCALE) / (tokens * state.virtualSolReserves);
  const impact = (Number(SCALE - ratioScaled) / Number(SCALE)) * 100;
  return Number.isFinite(impact) && impact >= 0 ? impact : null;
}

/** Proceeds after the protocol + creator fee the curve charges on a sell (fee comes out of the SOL paid). */
export function sellNetLamports(grossLamports: bigint, feeBasisPoints: number, creatorFeeBasisPoints: number): bigint {
  const rate = BigInt(feeBasisPoints) + BigInt(creatorFeeBasisPoints);
  return grossLamports - (grossLamports * rate + BPS - 1n) / BPS;
}
