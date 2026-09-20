import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { isFiniteNumber } from '../utils/math.js';
import type { BuyParams, ExecutionEngine, FillResult, PriceSource, SellParams } from './types.js';

/**
 * Simulates fills using live market data -- no transaction is ever built or
 * sent, no wallet or Signer is touched. Applies real quoted price impact
 * plus a configurable latency-slippage buffer and the configured fee
 * schedule, so simulated PnL is a realistic (if imperfect) approximation of
 * what a live fill would look like.
 */
export class DryRunExecutor implements ExecutionEngine {
  constructor(
    private readonly priceSource: PriceSource,
    private readonly cfg: Pick<AppConfig, 'edge' | 'execution'>,
    private readonly logger?: Logger,
  ) {}

  private computeFees(grossSol: number): number {
    const bpsFees = (grossSol * (this.cfg.edge.dexFeeBps + this.cfg.edge.swapFeeBps)) / 10_000;
    return this.cfg.edge.networkFeeSol + this.cfg.edge.priorityFeeSol + bpsFees;
  }

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
    };
  }

  async buy(params: BuyParams): Promise<FillResult> {
    const priceSol = await this.priceSource.getPrice(params.mint);
    if (!isFiniteNumber(priceSol) || priceSol <= 0) {
      this.logger?.warn({ mint: params.mint }, 'dry-run buy: price unavailable');
      return this.failedFill('price_unavailable');
    }

    const priceImpactPct =
      (await this.priceSource.getEstimatedPriceImpactPct(params.mint, params.amountSol)) ??
      this.cfg.execution.fallbackPriceImpactPct;
    const latencySlippagePct = this.cfg.execution.latencySlippageBufferPct;
    const feesSol = this.computeFees(params.amountSol);

    const effectiveAmountSol =
      params.amountSol - feesSol - (params.amountSol * (priceImpactPct + latencySlippagePct)) / 100;
    const filledAmountSol = Math.max(effectiveAmountSol, 0);

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
    };
  }

  async sell(params: SellParams): Promise<FillResult> {
    const currentPriceSol = await this.priceSource.getPrice(params.mint);
    if (!isFiniteNumber(currentPriceSol) || currentPriceSol <= 0 || params.entryPriceSol <= 0) {
      this.logger?.warn({ mint: params.mint }, 'dry-run sell: price unavailable');
      return this.failedFill('price_unavailable');
    }

    const grossValueSol = params.entryFilledAmountSol * (currentPriceSol / params.entryPriceSol);
    const priceImpactPct =
      (await this.priceSource.getEstimatedPriceImpactPct(params.mint, grossValueSol)) ??
      this.cfg.execution.fallbackPriceImpactPct;
    const latencySlippagePct = this.cfg.execution.latencySlippageBufferPct;
    const feesSol = this.computeFees(grossValueSol);

    const netValueSol = grossValueSol - feesSol - (grossValueSol * (priceImpactPct + latencySlippagePct)) / 100;
    const filledAmountSol = Math.max(netValueSol, 0);

    return {
      success: true,
      filledPriceSol: currentPriceSol,
      filledAmountSol,
      feesSol,
      txSignature: null,
      simulated: true,
      timestampMs: Date.now(),
      slippagePct: latencySlippagePct,
      priceImpactPct,
    };
  }
}
