export interface MarketSnapshot {
  mint: string;
  priceSol: number;
  liquiditySol: number;
  volume1mSol: number;
  buySellRatio: number;
  priceVelocity5sPct: number;
  volumeAccelerationX: number;
  txVelocityPerSec: number;
  estimatedSlippagePct: number;
  estimatedPriceImpactPct: number;
  observedAtMs: number;
}

export interface AggregatorLiquidityVolume {
  liquiditySol: number;
  volume1mSol: number;
  buySellRatio: number;
  /** Buy+sell transaction count, normalized to a 1-minute window. */
  txCount1m: number;
}

export interface AggregatorHolderConcentration {
  top10HolderPct: number;
}

export interface RoundTripQuote {
  buyPriceImpactPct: number;
  /** null means no sell route was found at all -- treat as a critical red flag (likely honeypot). */
  sellPriceImpactPct: number | null;
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  slippageBps: number;
  routePlanSummary: string;
}
