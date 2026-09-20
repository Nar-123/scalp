import { request } from 'undici';
import type { AppConfig } from '../config/schema.js';
import type { JupiterQuote, RoundTripQuote } from '../types/market.js';
import { isFiniteNumber } from '../utils/math.js';
import type { Logger } from '../logging/logger.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

interface JupiterQuoteResponseRoutePlanStep {
  swapInfo?: { label?: string };
}

interface JupiterQuoteResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  priceImpactPct?: string;
  routePlan?: JupiterQuoteResponseRoutePlanStep[];
}

export class JupiterQuoteClient {
  constructor(
    private readonly cfg: Pick<AppConfig['aggregators'], 'jupiterQuoteBaseUrl' | 'requestTimeoutMs'>,
    private readonly logger?: Logger,
  ) {}

  /**
   * Returns null (never throws) on any network error, timeout, or malformed
   * response, so callers (safety gate, edge calculator) fail closed.
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint,
    slippageBps: number,
  ): Promise<JupiterQuote | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const url = `${this.cfg.jupiterQuoteBaseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports.toString()}&slippageBps=${slippageBps}`;
      const res = await request(url, { method: 'GET', signal: controller.signal });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        this.logger?.warn({ url, statusCode: res.statusCode }, 'jupiter quote non-2xx');
        return null;
      }
      const body = (await res.body.json()) as JupiterQuoteResponse;
      const priceImpactPct = body.priceImpactPct !== undefined ? Number(body.priceImpactPct) * 100 : undefined;
      if (!body.inAmount || !body.outAmount || !isFiniteNumber(priceImpactPct)) {
        return null;
      }
      return {
        inputMint,
        outputMint,
        inAmount: body.inAmount,
        outAmount: body.outAmount,
        priceImpactPct,
        slippageBps,
        routePlanSummary: (body.routePlan ?? []).map((s) => s.swapInfo?.label ?? '?').join(' -> '),
      };
    } catch (err) {
      this.logger?.warn({ err: String(err) }, 'jupiter quote request failed');
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getBuyQuote(outputMint: string, amountSol: number, slippageBps: number): Promise<JupiterQuote | null> {
    const lamports = BigInt(Math.round(amountSol * 1_000_000_000));
    return this.getQuote(WSOL_MINT, outputMint, lamports, slippageBps);
  }

  async getSellQuote(inputMint: string, tokenAmountRaw: bigint, slippageBps: number): Promise<JupiterQuote | null> {
    return this.getQuote(inputMint, WSOL_MINT, tokenAmountRaw, slippageBps);
  }

  /**
   * Round-trip sellability probe: quotes a small SOL->mint buy, then reuses
   * that exact raw output amount as the input to a mint->SOL sell quote.
   * Reusing the raw amount sidesteps ever needing to know the mint's
   * decimals to build a synthetic sell-side test amount.
   */
  async getRoundTripQuote(mint: string, testAmountSol: number, slippageBps: number): Promise<RoundTripQuote | null> {
    const buyQuote = await this.getBuyQuote(mint, testAmountSol, slippageBps);
    if (!buyQuote) return null;
    const sellQuote = await this.getQuote(mint, WSOL_MINT, BigInt(buyQuote.outAmount), slippageBps);
    return {
      buyPriceImpactPct: buyQuote.priceImpactPct,
      sellPriceImpactPct: sellQuote?.priceImpactPct ?? null,
    };
  }
}

export { WSOL_MINT };
