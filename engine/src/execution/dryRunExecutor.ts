import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { isFiniteNumber } from '../utils/math.js';
import { simulateBuyFill, simulateSellFill } from './fillSimulation.js';
import type { BuyParams, ExecutionEngine, FillResult, PriceSource, SellParams } from './types.js';

/**
 * Simulates fills using live market data -- no transaction is ever built or
 * sent, no wallet or Signer is touched. Applies real quoted price impact
 * plus a configurable latency-slippage buffer and the configured fee
 * schedule (via the shared `simulateFill` -- see fillSimulation.ts), so
 * simulated PnL is a realistic (if imperfect) approximation of what a live
 * fill would look like.
 */
export class DryRunExecutor implements ExecutionEngine {
  constructor(
    private readonly priceSource: PriceSource,
    private readonly cfg: Pick<AppConfig, 'edge' | 'execution'>,
    private readonly logger?: Logger,
  ) {}

  // Every failure path here is `executionOutcome: 'not_executed'`: DRY_RUN never sends a transaction, so a fill
  // that did not compute simply never touched anything -- it can never be 'executed' and is never ambiguous
  // enough to be 'unknown' (that outcome is reserved for a real executor's own unconfirmed broadcasts).
  private failedFill(error: string): FillResult {
    return {
      success: false,
      filledPriceSol: 0,
      filledAmountSol: 0,
      feesSol: 0,
      txSignature: null,
      simulated: true,
      timestampMs: Date.now(),
      slippagePct: 0,
      priceImpactPct: 0,
      error,
      executionOutcome: 'not_executed',
    };
  }

  async buy(params: BuyParams): Promise<FillResult> {
    const priceSol = await this.priceSource.getPrice(params.mint);
    if (!isFiniteNumber(priceSol) || priceSol <= 0) {
      this.logger?.warn({ mint: params.mint }, 'dry-run buy: price unavailable');
      return this.failedFill('price_unavailable');
    }

    // FAIL CLOSED: an entry whose buy impact cannot be quoted is not simulated with a default.
    const quote = await this.priceSource.getBuyExecutionQuote(params.mint, params.amountSol);
    if (!quote || !isFiniteNumber(quote.priceImpactPct) || quote.priceImpactPct < 0) {
      this.logger?.warn({ mint: params.mint }, 'dry-run buy: price impact unavailable');
      return { ...this.failedFill('buy_price_impact_unavailable'), retryable: true };
    }
    const priceImpactPct = quote.priceImpactPct;
    const latencySlippagePct = this.cfg.execution.latencySlippageBufferPct;
    // BUY: the venue fee is charged on top of the spend, at the fee rate the token's quote was computed with (else the generic model).
    const { feesSol, filledAmountSol, breakdown } = simulateBuyFill(params.amountSol, priceImpactPct, latencySlippagePct, this.cfg.edge, quote.venueFeeBps ?? null);

    return {
      success: true,
      filledPriceSol: priceSol,
      filledAmountSol,
      feesSol,
      txSignature: null,
      simulated: true,
      timestampMs: Date.now(),
      slippagePct: latencySlippagePct,
      priceImpactPct,
      tokenAmountRaw: quote.tokenAmountRaw,
      venueFeeBps: breakdown.feeBps,
      feeModel: breakdown.feeModel,
      executionOutcome: 'executed',
    };
  }

  async sell(params: SellParams): Promise<FillResult> {
    const currentPriceSol = await this.priceSource.getPrice(params.mint);
    if (!isFiniteNumber(currentPriceSol) || currentPriceSol <= 0 || params.entryPriceSol <= 0) {
      this.logger?.warn({ mint: params.mint }, 'dry-run sell: price unavailable');
      return { ...this.failedFill('price_unavailable'), retryable: true };
    }
    // The SELL is priced in the SELL direction for the tokens actually held. No token amount => no sell impact => fail closed.
    if (!params.tokenAmountRaw) {
      this.logger?.warn({ mint: params.mint }, 'dry-run sell: position token amount unknown');
      return this.failedFill('sell_token_amount_unknown');
    }
    const sellImpactPct = await this.priceSource.getSellPriceImpactPct(params.mint, params.tokenAmountRaw);
    if (!isFiniteNumber(sellImpactPct) || sellImpactPct < 0) {
      this.logger?.warn({ mint: params.mint }, 'dry-run sell: sell price impact unavailable');
      return { ...this.failedFill('sell_price_impact_unavailable'), retryable: true };
    }

    const grossValueSol = params.entryFilledAmountSol * (currentPriceSol / params.entryPriceSol);
    const latencySlippagePct = this.cfg.execution.latencySlippageBufferPct;
    // SELL: the venue fee is deducted from the proceeds, at the token's current fee rate (else the generic model).
    const venueFeeBps = (await this.priceSource.getVenueFeeBps?.(params.mint)) ?? null;
    const { feesSol, filledAmountSol, breakdown } = simulateSellFill(grossValueSol, sellImpactPct, latencySlippagePct, this.cfg.edge, venueFeeBps);

    return {
      success: true,
      filledPriceSol: currentPriceSol,
      filledAmountSol,
      feesSol,
      txSignature: null,
      simulated: true,
      timestampMs: Date.now(),
      slippagePct: latencySlippagePct,
      priceImpactPct: sellImpactPct,
      venueFeeBps: breakdown.feeBps,
      feeModel: breakdown.feeModel,
      executionOutcome: 'executed',
    };
  }
}
