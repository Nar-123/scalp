import type { AppConfig } from '../config/schema.js';
import type { JupiterQuote, RoundTripQuote } from '../types/market.js';
import { isFiniteNumber } from '../utils/math.js';
import type { Logger } from '../logging/logger.js';
import { DEFAULT_GATE_LIMITS, ProviderError, ProviderGate } from '../providers/providerGate.js';
import { ProviderMetrics } from '../providers/providerMetrics.js';
import { SingleFlightCache } from '../providers/singleFlightCache.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Freshness bound shared with the decision rules (see orchestrator/snapshotCoherence.ts): a quote is never reused past it. */
export const MAX_QUOTE_AGE_MS = 10_000;

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
  error?: string;
  errorCode?: string;
}

/**
 * The provider ANSWERED "there is no route" (a token-level fact) versus the provider could NOT answer (a rate limit,
 * timeout or outage). Both fail closed, but only the first says anything about the token.
 */
export type QuoteResult =
  | { ok: true; quote: JupiterQuote }
  | { ok: false; kind: 'no_route'; reason: string }
  | { ok: false; kind: 'unavailable'; reason: string };

export interface JupiterClientDeps {
  gate?: ProviderGate;
  metrics?: ProviderMetrics;
  /** How long an identical quote may be reused (never above MAX_QUOTE_AGE_MS). 0 disables reuse; in-flight dedup stays. */
  cacheTtlMs?: number;
  now?: () => number;
}

export class JupiterQuoteClient {
  private readonly gate: ProviderGate;
  private readonly cache: SingleFlightCache<QuoteResult>;

  constructor(
    private readonly cfg: Pick<AppConfig['aggregators'], 'jupiterQuoteBaseUrl' | 'requestTimeoutMs'>,
    private readonly logger?: Logger,
    deps: JupiterClientDeps = {},
  ) {
    const metrics = deps.metrics ?? new ProviderMetrics();
    this.gate =
      deps.gate ??
      new ProviderGate(
        { kind: 'quote', endpoints: [{ baseUrl: cfg.jupiterQuoteBaseUrl }], ...DEFAULT_GATE_LIMITS, timeoutMs: cfg.requestTimeoutMs, maxTotalMs: Math.max(DEFAULT_GATE_LIMITS.maxTotalMs, cfg.requestTimeoutMs) },
        metrics,
        logger,
      );
    this.cache = new SingleFlightCache<QuoteResult>({ ttlMs: Math.min(deps.cacheTtlMs ?? 2000, MAX_QUOTE_AGE_MS), maxAgeMs: MAX_QUOTE_AGE_MS, ...(deps.now ? { now: deps.now } : {}), metrics, kind: 'quote' });
  }

  /**
   * Returns null (never throws) on any unavailability, so callers fail closed. Use `getQuoteDetailed` when the
   * difference between "no route" and "provider unavailable" matters.
   */
  async getQuote(inputMint: string, outputMint: string, amountLamports: bigint, slippageBps: number): Promise<JupiterQuote | null> {
    const r = await this.getQuoteDetailed(inputMint, outputMint, amountLamports, slippageBps);
    return r.ok ? r.quote : null;
  }

  async getQuoteDetailed(inputMint: string, outputMint: string, amountLamports: bigint, slippageBps: number): Promise<QuoteResult> {
    const key = `${inputMint}|${outputMint}|${amountLamports.toString()}|${slippageBps}`;
    const timed = await this.cache.get(
      key,
      async () => this.fetchQuote(inputMint, outputMint, amountLamports, slippageBps),
      (r) => r.ok,
    );
    if (!timed) return { ok: false, kind: 'unavailable', reason: 'no_result' };
    const r = timed.value;
    if (!r.ok) return r;
    return { ok: true, quote: { ...r.quote, fetchedAtMs: r.quote.fetchedAtMs ?? timed.fetchedAtMs, cached: timed.cached } };
  }

  private async fetchQuote(inputMint: string, outputMint: string, amountLamports: bigint, slippageBps: number): Promise<QuoteResult> {
    const path = `/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports.toString()}&slippageBps=${slippageBps}`;
    let res;
    try {
      res = await this.gate.execute({ method: 'GET', path });
    } catch (err) {
      const reason = err instanceof ProviderError ? err.reason : 'error';
      this.logger?.warn({ reason, inputMint, outputMint }, 'quote provider unavailable');
      return { ok: false, kind: 'unavailable', reason };
    }
    if (res.status >= 400) {
      // The provider answered. "No route" is a token fact; anything else (bad request) is an unusable answer.
      const noRoute = /route|not tradable|TOKEN_NOT_TRADABLE|COULD_NOT_FIND/i.test(res.body.slice(0, 500));
      return noRoute ? { ok: false, kind: 'no_route', reason: `http_${res.status}` } : { ok: false, kind: 'unavailable', reason: `http_${res.status}` };
    }
    try {
      const body = JSON.parse(res.body) as JupiterQuoteResponse;
      const priceImpactPct = body.priceImpactPct !== undefined ? Number(body.priceImpactPct) * 100 : undefined;
      if (!body.inAmount || !body.outAmount || !isFiniteNumber(priceImpactPct)) return { ok: false, kind: 'unavailable', reason: 'malformed_response' };
      return {
        ok: true,
        quote: {
          inputMint,
          outputMint,
          inAmount: body.inAmount,
          outAmount: body.outAmount,
          priceImpactPct,
          slippageBps,
          routePlanSummary: (body.routePlan ?? []).map((s) => s.swapInfo?.label ?? '?').join(' -> '),
          fetchedAtMs: res.asOfMs,
          provider: res.host,
        },
      };
    } catch {
      return { ok: false, kind: 'unavailable', reason: 'malformed_response' };
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
   * Round-trip sellability probe: quotes a small SOL->mint buy, then reuses that exact raw output amount as the input
   * of a mint->SOL sell quote (no decimals needed). `sellPriceImpactPct: null` means the provider ANSWERED that there is
   * no sell route; if the provider could not answer at all the result is null (quote_unavailable) -- a rate limit is
   * never reported as a token having no sell route.
   */
  async getRoundTripQuote(mint: string, testAmountSol: number, slippageBps: number): Promise<RoundTripQuote | null> {
    const lamports = BigInt(Math.round(testAmountSol * 1_000_000_000));
    const buy = await this.getQuoteDetailed(WSOL_MINT, mint, lamports, slippageBps);
    if (!buy.ok) return null;
    let raw: bigint;
    try {
      raw = BigInt(buy.quote.outAmount);
    } catch {
      return null;
    }
    const sell = await this.getQuoteDetailed(mint, WSOL_MINT, raw, slippageBps);
    const buyAsOf = buy.quote.fetchedAtMs ?? Date.now();
    if (sell.ok) return { asOfMs: Math.min(buyAsOf, sell.quote.fetchedAtMs ?? buyAsOf), buyPriceImpactPct: buy.quote.priceImpactPct, sellPriceImpactPct: sell.quote.priceImpactPct };
    if (sell.kind === 'no_route') return { asOfMs: buyAsOf, buyPriceImpactPct: buy.quote.priceImpactPct, sellPriceImpactPct: null };
    return null;
  }
}

export { WSOL_MINT };
