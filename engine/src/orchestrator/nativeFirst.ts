import type { AggregatorClient } from '../discovery/types.js';
import type { ExecutionQuote, PriceSource, QuoteFetchRecord } from '../execution/types.js';
import type { AggregatorHolderConcentration, AggregatorLiquidityVolume } from '../types/market.js';
import type { NativeMarketProvider, NativeMarketSnapshot } from '../volume/types.js';

/**
 * Native-first decorators for the CONSUMERS that are not the evaluation loop (the dry-run executor and the
 * position monitor). Same priority rule as orchestrator/marketSourcePolicy.ts, applied per call:
 *
 *   native VALID                          -> native value (event-driven, no request)
 *   native GRADUATED / mint_not_observed  -> delegate (not on a Pump.fun curve as far as the stream knows)
 *   any other native state                -> null (still on the curve but unprovable: never fall back to another source)
 *
 * Read-only: these wrap getters; nothing here signs, sends or builds a transaction.
 */

/** Protocol + creator fee per leg (bps) carried by the curve state behind a native snapshot; null when there is no curve state. */
export function nativeVenueFeeBps(snap: NativeMarketSnapshot): number | null {
  if (!snap.curve) return null;
  const bps = snap.curve.feeBasisPoints + snap.curve.creatorFeeBasisPoints;
  return Number.isFinite(bps) && bps >= 0 ? bps : null;
}

/** Whether the inner (DexScreener/Jupiter) source may be consulted for this native state. */
export function mayDelegate(native: NativeMarketSnapshot): boolean {
  return native.quality === 'GRADUATED' || (native.quality === 'UNAVAILABLE' && native.reason === 'mint_not_observed');
}

export class NativeFirstPriceSource implements PriceSource {
  constructor(
    private readonly inner: PriceSource,
    private readonly native: NativeMarketProvider,
  ) {}

  async getPrice(mint: string): Promise<number | null> {
    const snap = this.native.getNativeMarketSnapshot(mint, 0);
    if (snap.quality === 'VALID') return snap.priceSol;
    return mayDelegate(snap) ? this.inner.getPrice(mint) : null;
  }

  async getEstimatedPriceImpactPct(mint: string, amountSol: number): Promise<number | null> {
    const snap = this.native.getNativeMarketSnapshot(mint, amountSol);
    if (snap.quality === 'VALID') return snap.priceImpactPct;
    return mayDelegate(snap) ? this.inner.getEstimatedPriceImpactPct(mint, amountSol) : null;
  }

  async getBuyExecutionQuote(mint: string, amountSol: number): Promise<ExecutionQuote | null> {
    const snap = this.native.getNativeMarketSnapshot(mint, amountSol);
    if (snap.quality === 'VALID') return snap.priceImpactPct === null ? null : { priceImpactPct: snap.priceImpactPct, tokenAmountRaw: snap.buyTokenAmountRaw, venueFeeBps: nativeVenueFeeBps(snap) };
    return mayDelegate(snap) ? this.inner.getBuyExecutionQuote(mint, amountSol) : null;
  }

  /** Exact curve SELL impact for the held amount when the token is on a valid curve; the inner Jupiter sell quote only if it is not a curve token. */
  async getSellPriceImpactPct(mint: string, tokenAmountRaw: string): Promise<number | null> {
    let raw: bigint;
    try {
      raw = BigInt(tokenAmountRaw);
    } catch {
      return null;
    }
    const sell = this.native.getNativeSellImpact(mint, raw);
    if (sell.quality === 'VALID') return sell.sellPriceImpactPct;
    const observed = sell.quality === 'GRADUATED' || (sell.quality === 'UNAVAILABLE' && sell.reason === 'mint_not_observed');
    return observed ? this.inner.getSellPriceImpactPct(mint, tokenAmountRaw) : null;
  }

  /** The curve's own fee for a valid native token; nothing for a token that is not on a curve (the generic model applies). */
  async getVenueFeeBps(mint: string): Promise<number | null> {
    const snap = this.native.getNativeMarketSnapshot(mint, 0);
    if (snap.quality === 'VALID') return nativeVenueFeeBps(snap);
    return mayDelegate(snap) ? (this.inner.getVenueFeeBps?.(mint) ?? null) : null;
  }

  takeLastQuoteFetch(mint: string): QuoteFetchRecord | null {
    return this.inner.takeLastQuoteFetch?.(mint) ?? null;
  }
}

export class NativeFirstAggregator implements AggregatorClient {
  constructor(
    private readonly inner: AggregatorClient,
    private readonly native: NativeMarketProvider,
  ) {}

  async getLiquidityAndVolume(mint: string): Promise<AggregatorLiquidityVolume | null> {
    const snap = this.native.getNativeMarketSnapshot(mint, 0);
    if (snap.quality === 'VALID') {
      if (snap.liquiditySol === null) return null;
      return {
        liquiditySol: snap.liquiditySol,
        volume1mSol: snap.volume1mSol,
        // The position monitor only reads liquidity from this object; the ratio is not consumed on this path.
        buySellRatio: snap.buySellRatio ?? 0,
        txCount1m: snap.txCount1m ?? 0,
      };
    }
    return mayDelegate(snap) ? this.inner.getLiquidityAndVolume(mint) : null;
  }

  getHolderConcentration(mint: string): Promise<AggregatorHolderConcentration | null> {
    return this.inner.getHolderConcentration(mint);
  }

  async getPrice(mint: string): Promise<number | null> {
    const snap = this.native.getNativeMarketSnapshot(mint, 0);
    if (snap.quality === 'VALID') return snap.priceSol;
    return mayDelegate(snap) ? this.inner.getPrice(mint) : null;
  }
}
