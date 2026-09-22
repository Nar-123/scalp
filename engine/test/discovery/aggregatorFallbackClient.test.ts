import { describe, expect, it, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

const { DexscreenerBirdeyeAggregator } = await import('../../src/discovery/aggregatorFallbackClient.js');

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: { json: async () => body } };
}

const MINT = 'MINT_UNDER_TEST';
const WSOL = 'So11111111111111111111111111111111111111112';

/** A minimal TOKEN/SOL pair with explicit identities (an unidentified pair is never trusted). */
function solPair(overrides: Record<string, unknown> = {}) {
  return {
    baseToken: { address: MINT, symbol: 'TKN' },
    quoteToken: { address: WSOL, symbol: 'SOL' },
    priceNative: '0.00001',
    priceUsd: '0.001',
    ...overrides,
  };
}

const cfg = {
  dexscreenerBaseUrl: 'https://api.dexscreener.com',
  jupiterQuoteBaseUrl: 'https://quote-api.jup.ag/v6',
  requestTimeoutMs: 4000,
};

describe('DexscreenerBirdeyeAggregator', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('returns SOL liquidity / buySellRatio from the highest-SOL-liquidity TOKEN/SOL pair; 1m volume is unavailable', async () => {
    requestMock.mockResolvedValueOnce(
      jsonResponse(200, {
        pairs: [
          solPair({ liquidity: { base: 999_999, quote: 5, usd: 500 }, txns: { m5: { buys: 8, sells: 2 } } }),
          solPair({ liquidity: { base: 999_999, quote: 40, usd: 4000 }, volume: { m5: 50 }, txns: { m5: { buys: 30, sells: 10 } } }),
        ],
      }),
    );
    const client = new DexscreenerBirdeyeAggregator(cfg);
    const result = await client.getLiquidityAndVolume(MINT);
    expect(result).not.toBeNull();
    expect(result!.liquiditySol).toBe(40); // liquidity.quote (SOL), never liquidity.base (token amount)
    expect(result!.volume1mSol).toBeNull(); // no real 1-minute source
    expect(result!.buySellRatio).toBe(3);
    expect(result!.txCount1m).toBeCloseTo(8, 5);
  });

  it('returns null on a non-2xx response', async () => {
    requestMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getLiquidityAndVolume(MINT)).toBeNull();
  });

  it('returns null on malformed JSON / missing pairs', async () => {
    requestMock.mockResolvedValueOnce(jsonResponse(200, { pairs: null }));
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getLiquidityAndVolume(MINT)).toBeNull();
  });

  it('returns null when the request throws (network error / timeout)', async () => {
    requestMock.mockRejectedValueOnce(new Error('timeout'));
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getLiquidityAndVolume(MINT)).toBeNull();
  });

  it('returns null holder concentration when no Birdeye key is configured', async () => {
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getHolderConcentration(MINT)).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('treats an all-buys, zero-sells pair as infinite buy/sell ratio', async () => {
    requestMock.mockResolvedValueOnce(
      jsonResponse(200, {
        pairs: [solPair({ liquidity: { base: 1, quote: 40, usd: 4000 }, volume: { m5: 50 }, txns: { m5: { buys: 5, sells: 0 } } })],
      }),
    );
    const client = new DexscreenerBirdeyeAggregator(cfg);
    const result = await client.getLiquidityAndVolume(MINT);
    expect(result!.buySellRatio).toBe(Number.POSITIVE_INFINITY);
  });
});
