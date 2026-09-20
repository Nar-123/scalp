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
  priceImpactPct: number;
  error?: string;
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
export interface PriceSource {
  getPrice(mint: string): Promise<number | null>;
  /**
   * Estimated price-impact percent for a trade of this size, used for both
   * buy and sell simulation. Derived from a Jupiter buy-side quote as an
   * approximation -- a precise sell-side figure would require the position's
   * raw token amount (decimals), which DRY_RUN mode deliberately avoids
   * needing. Good enough for realistic-ish simulated fills; a live executor
   * (later pass) should compute both sides exactly.
   */
  getEstimatedPriceImpactPct(mint: string, amountSol: number): Promise<number | null>;
}

export * from './signer/types.js';
