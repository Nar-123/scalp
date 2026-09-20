import { request } from 'undici';
import type { AppConfig } from '../config/schema.js';
import type { AggregatorHolderConcentration, AggregatorLiquidityVolume } from '../types/market.js';
import type { AggregatorClient } from './types.js';
import { isFiniteNumber } from '../utils/math.js';
import type { Logger } from '../logging/logger.js';

interface DexscreenerPair {
  liquidity?: { base?: number; quote?: number; usd?: number };
  volume?: { m5?: number; h1?: number };
  txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
  priceNative?: string;
  quoteToken?: { symbol?: string };
}

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

  private pickBestPair(pairs: DexscreenerPair[] | null | undefined): DexscreenerPair | null {
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    let best: DexscreenerPair | null = null;
    let bestLiquidity = -Infinity;
    for (const pair of pairs) {
      const liquidity = pair.liquidity?.usd ?? -Infinity;
      if (isFiniteNumber(liquidity) && liquidity > bestLiquidity) {
        bestLiquidity = liquidity;
        best = pair;
      }
    }
    return best ?? pairs[0] ?? null;
  }

  async getLiquidityAndVolume(mint: string): Promise<AggregatorLiquidityVolume | null> {
    const data = await this.fetchJson<DexscreenerResponse>(
      `${this.cfg.dexscreenerBaseUrl}/latest/dex/tokens/${encodeURIComponent(mint)}`,
    );
    const pair = this.pickBestPair(data?.pairs);
    if (!pair) return null;

    const liquiditySol = pair.liquidity?.base;
    const volume1mRaw = pair.volume?.m5 !== undefined ? pair.volume.m5 / 5 : undefined;
    const usingM5Txns = pair.txns?.m5 !== undefined;
    const txns = pair.txns?.m5 ?? pair.txns?.h1;
    const buys = txns?.buys ?? 0;
    const sells = txns?.sells ?? 0;
    const txCount1m = (buys + sells) / (usingM5Txns ? 5 : 60);

    if (!isFiniteNumber(liquiditySol) || !isFiniteNumber(volume1mRaw)) return null;

    const buySellRatio = sells > 0 ? buys / sells : buys > 0 ? Number.POSITIVE_INFINITY : 0;

    return {
      liquiditySol,
      volume1mSol: volume1mRaw,
      buySellRatio,
      txCount1m,
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

  async getPrice(mint: string): Promise<number | null> {
    const data = await this.fetchJson<DexscreenerResponse>(
      `${this.cfg.dexscreenerBaseUrl}/latest/dex/tokens/${encodeURIComponent(mint)}`,
    );
    const pair = this.pickBestPair(data?.pairs);
    const price = pair?.priceNative !== undefined ? Number(pair.priceNative) : undefined;
    return isFiniteNumber(price) ? price : null;
  }
}
