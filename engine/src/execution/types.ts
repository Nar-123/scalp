export interface FillResult {
  success: boolean;
  /** Real SOL-denominated price per token at fill time (or null-fill 0 on failure). */
  filledPriceSol: number;
  /** Net SOL value actually realized by this fill, after fees/impact/slippage. */
  filledAmountSol: number;
  feesSol: number;
  txSignature: string | null;
  simulated: boolean;
  timestampMs: number;
  slippagePct: number;
  /** BUY fills: the buy-side impact. SELL fills: the independently computed SELL-side impact (never the buy figure). */
  priceImpactPct: number;
  /** Tokens (raw base units, decimal string) received by a BUY fill; the amount a later SELL must liquidate. null when unknown. */
  tokenAmountRaw?: string | null;
  /** Fee rate (bps) and model this fill was priced with (Phase 5.6H): what the simulated venue fee was computed from. */
  venueFeeBps?: number;
  feeModel?: 'pumpfun_curve' | 'configured_flat';
  error?: string;
  /**
   * true when nothing was executed because a required input was UNAVAILABLE (price, impact, token amount) -- the
   * position is intact and it is SAFE to retry the same sell automatically (bounded -- see positionMonitor.ts).
   * false/absent means retrying automatically is not appropriate (see `executionOutcome` for why): either nothing
   * ran and retrying would not help (e.g. a structurally missing token amount), or a real attempt's outcome is
   * unconfirmed and retrying risks a DUPLICATE sell.
   */
  retryable?: boolean;
  /**
   * Explicit, authoritative execution outcome (bug fix following the DRY_RUN incident where a `success:false` fill
   * that had executed NOTHING was still recorded as a closed position with a fabricated realized loss). This is the
   * ONLY field `positionMonitor.ts` trusts to decide whether a sell actually happened -- `success`/`filledAmountSol`
   * describe the resulting numbers, not whether they are real.
   *
   *   'executed'     -- the trade genuinely happened; filledAmountSol/filledPriceSol/fees are real and may be
   *                      booked as a realized exit. Never combined with `success: false`.
   *   'not_executed' -- nothing was sent or filled; the position is UNCHANGED. Safe to retry when `retryable` is
   *                      also true (bounded); otherwise retrying would not help and the position needs
   *                      reconciliation (never automatically closed, never given a fabricated PnL).
   *   'unknown'      -- an attempt was made (e.g. a transaction was broadcast) but whether it landed could not be
   *                      confirmed. MUST NOT be retried automatically under any circumstance -- doing so could
   *                      execute a second, duplicate sell of a position that was already sold. Requires manual
   *                      reconciliation of the real on-chain/venue state before this position trades again.
   *
   * Optional for backward compatibility: when omitted, the caller derives it as `success ? 'executed' : 'not_executed'`
   * (see `resolveExecutionOutcome`) -- which is exactly what fixed the bug for every existing DRY_RUN failure case,
   * none of which ever sends anything. A future live executor MUST set this explicitly, in particular `'unknown'`
   * for its own ambiguous cases (timeouts, dropped confirmations) -- it must never rely on the `success:false`
   * fallback to mean "executed", because the fallback can only ever produce `'not_executed'`.
   */
  executionOutcome?: 'executed' | 'not_executed' | 'unknown';
}

/**
 * The authoritative interpretation of a fill's execution outcome (see `FillResult.executionOutcome`). Exported so
 * both `positionMonitor.ts` and any future execution-outcome-aware code (e.g. a live executor's own retry guard)
 * apply the exact same rule and can never independently reinvent (or misinterpret) it.
 */
export function resolveExecutionOutcome(fill: Pick<FillResult, 'success' | 'executionOutcome'>): 'executed' | 'not_executed' | 'unknown' {
  return fill.executionOutcome ?? (fill.success ? 'executed' : 'not_executed');
}

export interface BuyParams {
  mint: string;
  amountSol: number;
  maxSlippageBps: number;
}

export interface SellParams {
  mint: string;
  /** The price the position was entered at, for computing the current mark. */
  entryPriceSol: number;
  /** SOL value actually deployed at entry (post entry fees/impact), i.e. the buy fill's filledAmountSol. */
  entryFilledAmountSol: number;
  /** Raw token amount the position holds (from the buy fill). null/unknown => the sell impact cannot be computed => the sell fails closed. */
  tokenAmountRaw: string | null;
  maxSlippageBps: number;
}

export interface ExecutionEngine {
  buy(params: BuyParams): Promise<FillResult>;
  sell(params: SellParams): Promise<FillResult>;
}

/**
 * Abstracts "what's the current price / expected impact" away from any
 * particular data provider. DRY_RUN pricing intentionally avoids needing
 * raw token decimals: aggregator.getPrice() already returns a
 * human-normalized SOL price per token.
 */
export interface ExecutionQuote {
  /** Price impact (%) of the trade in ITS OWN direction, fees excluded. */
  priceImpactPct: number;
  /** BUY quotes: the raw token amount the SOL would buy (what a later sell has to liquidate). */
  tokenAmountRaw: string | null;
  /**
   * The venue's own fee per leg in bps that `tokenAmountRaw` already accounts for (Pump.fun: protocol + creator fee of the
   * curve). Absent/null => the venue fee is not known and the configured generic fee model prices the leg.
   */
  venueFeeBps?: number | null;
}

export interface PriceSource {
  getPrice(mint: string): Promise<number | null>;
  /**
   * BUY-side price-impact percent for spending `amountSol` (a buy-direction quote). It is NOT valid for a sell:
   * selling is a different trade against different reserves -- use `getSellPriceImpactPct`.
   */
  getEstimatedPriceImpactPct(mint: string, amountSol: number): Promise<number | null>;
  /** BUY-side quote incl. the raw token amount received (Phase 5.6). null => unavailable (callers fail closed). */
  getBuyExecutionQuote(mint: string, amountSol: number): Promise<ExecutionQuote | null>;
  /**
   * SELL-side price-impact percent of liquidating `tokenAmountRaw` base units (a sell-direction quote against the
   * real market, never derived from the buy impact and never `amount / liquidity`). null => unavailable.
   */
  getSellPriceImpactPct(mint: string, tokenAmountRaw: string): Promise<number | null>;
  /**
   * The venue's CURRENT fee per leg in bps for this mint (Pump.fun bonding curve: protocol + creator fee carried by the
   * curve's TradeEvents), or null when the venue fee is not known. Optional: a source without a venue fee model simply
   * omits it and the configured generic fee model applies.
   */
  getVenueFeeBps?(mint: string): Promise<number | null>;
  /** Optional: outcome of the quote request made by the last getEstimatedPriceImpactPct call for this mint (cleared on read). */
  takeLastQuoteFetch?(mint: string): QuoteFetchRecord | null;
}

/**
 * OBSERVED outcome of one read-only quote request (an HTTP GET for an
 * indicative price/impact). It is data about a quote -- never a transaction,
 * never an executable order.
 */
export interface QuoteFetchRecord {
  ok: boolean;
  startedAtMs: number;
  completedAtMs: number;
  requestLatencyMs: number;
  inAmountLamports: string | null;
  outAmountRaw: string | null;
  priceImpactPct: number | null;
  route: string | null;
  /** the slippage TOLERANCE sent with the request -- not an estimate of slippage */
  slippageToleranceBps: number;
}

export * from './signer/types.js';
