import type { AggregatorClient } from '../discovery/types.js';
import { MAX_QUOTE_AGE_MS, type JupiterQuoteClient } from './jupiterQuoteClient.js';
import type { ExecutionQuote, PriceSource, QuoteFetchRecord } from './types.js';

const DEFAULT_QUOTE_SLIPPAGE_BPS = 100;

function isStaleQuote(fetchedAtMs: number | undefined): boolean {
  return fetchedAtMs !== undefined && Date.now() - fetchedAtMs > MAX_QUOTE_AGE_MS;
}

export interface MarketPriceSourceOptions {
  /**
   * When true, the outcome of each read-only buy-quote request made by
   * getEstimatedPriceImpactPct is remembered (one slot per mint) so shadow
   * trading can observe it via takeLastQuoteFetch WITHOUT a second request.
   * Off by default: with shadow disabled nothing is retained.
   */
  recordQuoteFetches?: boolean;
}

export class MarketPriceSource implements PriceSource {
  private readonly lastQuoteFetch = new Map<string, QuoteFetchRecord>();

  constructor(
    private readonly aggregator: AggregatorClient,
    private readonly jupiterClient: JupiterQuoteClient,
    private readonly options: MarketPriceSourceOptions = {},
  ) {}

  async getPrice(mint: string): Promise<number | null> {
    return this.aggregator.getPrice(mint);
  }

  async getEstimatedPriceImpactPct(mint: string, amountSol: number): Promise<number | null> {
    return (await this.fetchBuyQuote(mint, amountSol))?.priceImpactPct ?? null;
  }

  private async fetchBuyQuote(mint: string, amountSol: number): Promise<{ priceImpactPct: number; outAmount: string } | null> {
    const startedAtMs = Date.now();
    const started = performance.now();
    const fetched = await this.jupiterClient.getBuyQuote(mint, amountSol, DEFAULT_QUOTE_SLIPPAGE_BPS);
    // A stale quote is unavailable, never a usable one (freshness bound shared with the 10 s decision rule).
    const quote = fetched && !isStaleQuote(fetched.fetchedAtMs) ? fetched : null;
    if (this.options.recordQuoteFetches) {
      this.lastQuoteFetch.set(mint, {
        ok: quote !== null,
        startedAtMs,
        // the quote's own as-of time (a reused quote keeps the time it was obtained), so coherence checks see its real age
        completedAtMs: fetched?.fetchedAtMs ?? Date.now(),
        requestLatencyMs: performance.now() - started,
        inAmountLamports: quote?.inAmount ?? null,
        outAmountRaw: quote?.outAmount ?? null,
        priceImpactPct: quote?.priceImpactPct ?? null,
        route: quote?.routePlanSummary ?? null,
        slippageToleranceBps: DEFAULT_QUOTE_SLIPPAGE_BPS,
      });
    }
    return quote ? { priceImpactPct: quote.priceImpactPct, outAmount: quote.outAmount } : null;
  }

  async getBuyExecutionQuote(mint: string, amountSol: number): Promise<ExecutionQuote | null> {
    const quote = await this.fetchBuyQuote(mint, amountSol);
    return quote ? { priceImpactPct: quote.priceImpactPct, tokenAmountRaw: quote.outAmount } : null;
  }

  /** Jupiter SELL quote (token -> SOL) for the actual raw amount: the sell direction, priced by the market itself. */
  async getSellPriceImpactPct(mint: string, tokenAmountRaw: string): Promise<number | null> {
    let raw: bigint;
    try {
      raw = BigInt(tokenAmountRaw);
    } catch {
      return null;
    }
    if (raw <= 0n) return null;
    const quote = await this.jupiterClient.getSellQuote(mint, raw, DEFAULT_QUOTE_SLIPPAGE_BPS);
    if (!quote || isStaleQuote(quote.fetchedAtMs)) return null;
    return quote.priceImpactPct;
  }

  /** Returns and clears the most recent recorded quote fetch for this mint (read-only observation, never an executable transaction). */
  takeLastQuoteFetch(mint: string): QuoteFetchRecord | null {
    const record = this.lastQuoteFetch.get(mint) ?? null;
    this.lastQuoteFetch.delete(mint);
    return record;
  }
}
