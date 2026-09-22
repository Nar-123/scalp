export interface MarketSnapshot {
  mint: string;
  priceSol: number;
  liquiditySol: number;
  /** null = no trustworthy 1-minute SOL volume was available for this observation. */
  volume1mSol: number | null;
  /** null = undefined ratio (native source with no trades in the window). */
  buySellRatio: number | null;
  priceVelocity5sPct: number;
  /** null when volume1mSol (either window) is unavailable -- never computed across mixed units. */
  volumeAccelerationX: number | null;
  txVelocityPerSec: number;
  estimatedSlippagePct: number;
  /** null = the entry could not be priced (native source): the price-impact filter then fails closed. */
  estimatedPriceImpactPct: number | null;
  observedAtMs: number;
}

/**
 * UNIT CONTRACT: every "Sol" field is denominated in SOL or is null; a value
 * whose unit cannot be proven is never reported as SOL (see
 * discovery/dexscreenerUnits.ts).
 */
export interface AggregatorLiquidityVolume {
  /** SOL-side pool liquidity of a TOKEN/SOL pair. Never a token amount, USD, or another quote asset. */
  liquiditySol: number;
  /** Real 1-minute volume in SOL; null when no real 1-minute source exists (DexScreener publishes m5/h1/h6/h24 only). */
  volume1mSol: number | null;
  /** Trailing-5-minute volume converted USD -> SOL; informational, never substituted for volume1mSol. */
  volume5mSol?: number | null;
  /** Buy count / sell count over the trailing window (same window for both). */
  buySellRatio: number;
  /** Address of the pair the values came from (audit trail). */
  pairAddress?: string | null;
  /** Buy+sell transactions per minute as the trailing-window MEAN (m5/5, else h1/60) -- a count rate, not a 1-minute observation. */
  txCount1m: number;
}

export interface AggregatorHolderConcentration {
  top10HolderPct: number;
}

export interface RoundTripQuote {
  /** Wall-clock time of the OLDEST leg (the as-of time the safety decision may rely on). */
  asOfMs?: number;
  buyPriceImpactPct: number;
  /** null means no sell route was found at all -- treat as a critical red flag (likely honeypot). */
  sellPriceImpactPct: number | null;
}

export interface JupiterQuote {
  /** When the provider answered (event as-of time; a cached quote keeps its original time). */
  fetchedAtMs?: number;
  /** Host of the endpoint that answered (never a URL or key). */
  provider?: string;
  cached?: boolean;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  slippageBps: number;
  routePlanSummary: string;
}
