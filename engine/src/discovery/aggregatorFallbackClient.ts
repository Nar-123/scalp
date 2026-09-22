import { request } from 'undici';
import type { AppConfig } from '../config/schema.js';
import type { AggregatorHolderConcentration, AggregatorLiquidityVolume } from '../types/market.js';
import type { AggregatorClient } from './types.js';
import { isFiniteNumber } from '../utils/math.js';
import { type DexscreenerPair, interpretPair, pickTokenSolPair } from './dexscreenerUnits.js';
import type { Logger } from '../logging/logger.js';

interface DexscreenerResponse {
  pairs?: DexscreenerPair[] | null;
}

/**
 * Aggregator fallback/enrichment client. Never throws -- any network error,
 * timeout, or malformed payload resolves to `null` so the safety/scoring
 * pipeline can fail closed instead of crashing.
 */
export class DexscreenerBirdeyeAggregator implements AggregatorClient {
  constructor(
    private readonly cfg: AppConfig['aggregators'],
    private readonly logger?: Logger,
  ) {}

  private async fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const res = await request(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        this.logger?.warn({ url, statusCode: res.statusCode }, 'aggregator request non-2xx');
        return null;
      }
      const body = (await res.body.json()) as T;
      return body;
    } catch (err) {
      this.logger?.warn({ url, err: String(err) }, 'aggregator request failed');
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Returns SOL-denominated liquidity, 5-minute-converted volume, and buy/sell
   * counts for the best TOKEN/SOL pair -- see dexscreenerUnits.ts for the unit
   * contract. Returns null (fail closed) when no pair is provably TOKEN/SOL or
   * its SOL-side liquidity is unavailable. `volume1mSol` is always null: no
   * real 1-minute volume source exists here.
   */
  async getLiquidityAndVolume(mint: string): Promise<AggregatorLiquidityVolume | null> {
    const data = await this.fetchJson<DexscreenerResponse>(
      `${this.cfg.dexscreenerBaseUrl}/latest/dex/tokens/${encodeURIComponent(mint)}`,
    );
    const pair = pickTokenSolPair(data?.pairs, mint);
    if (!pair) return null;
    const interpreted = interpretPair(pair, mint);
    if (!interpreted || interpreted.liquiditySol === null) return null;

    return {
      liquiditySol: interpreted.liquiditySol,
      volume1mSol: interpreted.volume1mSol,
      volume5mSol: interpreted.volume5mSol,
      buySellRatio: interpreted.buySellRatio,
      txCount1m: interpreted.txCountPerMinute,
      pairAddress: interpreted.pairAddress,
    };
  }

  async getHolderConcentration(mint: string): Promise<AggregatorHolderConcentration | null> {
    if (!this.cfg.birdeyeApiKey) {
      // No Birdeye key configured -- callers should fall back to the direct
      // on-chain getTokenLargestAccounts check, which is the primary path.
      return null;
    }
    const data = await this.fetchJson<{ data?: { items?: Array<{ percentage?: number }> } }>(
      `https://public-api.birdeye.so/defi/token_holder?address=${encodeURIComponent(mint)}&offset=0&limit=10`,
      { 'X-API-KEY': this.cfg.birdeyeApiKey, 'x-chain': 'solana' },
    );
    const items = data?.data?.items;
    if (!Array.isArray(items) || items.length === 0) return null;
    const top10HolderPct = items.reduce((sum, item) => sum + (isFiniteNumber(item.percentage) ? item.percentage : 0), 0);
    return { top10HolderPct };
  }

  /** Price in SOL of the token, only from a provably TOKEN/SOL pair (priceNative of a USDC pair is USDC, not SOL). */
  async getPrice(mint: string): Promise<number | null> {
    const data = await this.fetchJson<DexscreenerResponse>(
      `${this.cfg.dexscreenerBaseUrl}/latest/dex/tokens/${encodeURIComponent(mint)}`,
    );
    const pair = pickTokenSolPair(data?.pairs, mint);
    return pair ? (interpretPair(pair, mint)?.priceSol ?? null) : null;
  }
}
