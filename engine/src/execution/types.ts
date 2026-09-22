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
   * position is intact and the same sell may be retried. false/absent = a genuine execution failure.
   */
  retryable?: boolean;
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
