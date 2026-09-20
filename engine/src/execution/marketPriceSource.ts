import type { AggregatorClient } from '../discovery/types.js';
import type { JupiterQuoteClient } from './jupiterQuoteClient.js';
import type { PriceSource } from './types.js';

const DEFAULT_QUOTE_SLIPPAGE_BPS = 100;

export class MarketPriceSource implements PriceSource {
  constructor(
    private readonly aggregator: AggregatorClient,
    private readonly jupiterClient: JupiterQuoteClient,
  ) {}

  async getPrice(mint: string): Promise<number | null> {
    return this.aggregator.getPrice(mint);
  }

  async getEstimatedPriceImpactPct(mint: string, amountSol: number): Promise<number | null> {
    const quote = await this.jupiterClient.getBuyQuote(mint, amountSol, DEFAULT_QUOTE_SLIPPAGE_BPS);
    return quote?.priceImpactPct ?? null;
  }
}
