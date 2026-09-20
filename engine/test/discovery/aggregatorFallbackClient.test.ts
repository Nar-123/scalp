import { describe, expect, it, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

const { DexscreenerBirdeyeAggregator } = await import('../../src/discovery/aggregatorFallbackClient.js');

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: { json: async () => body } };
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

  it('returns liquidity/volume/buySellRatio from the highest-liquidity pair', async () => {
    requestMock.mockResolvedValueOnce(
      jsonResponse(200, {
        pairs: [
          { liquidity: { base: 5, usd: 500 }, volume: { m5: 10 }, txns: { m5: { buys: 8, sells: 2 } } },
          { liquidity: { base: 40, usd: 4000 }, volume: { m5: 50 }, txns: { m5: { buys: 30, sells: 10 } } },
        ],
      }),
    );
    const client = new DexscreenerBirdeyeAggregator(cfg);
    const result = await client.getLiquidityAndVolume('MINT');
    expect(result).not.toBeNull();
    expect(result!.liquiditySol).toBe(40);
    expect(result!.volume1mSol).toBe(10);
    expect(result!.buySellRatio).toBe(3);
    expect(result!.txCount1m).toBeCloseTo(8, 5);
  });

  it('returns null on a non-2xx response', async () => {
    requestMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getLiquidityAndVolume('MINT')).toBeNull();
  });

  it('returns null on malformed JSON / missing pairs', async () => {
    requestMock.mockResolvedValueOnce(jsonResponse(200, { pairs: null }));
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getLiquidityAndVolume('MINT')).toBeNull();
  });

  it('returns null when the request throws (network error / timeout)', async () => {
    requestMock.mockRejectedValueOnce(new Error('timeout'));
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getLiquidityAndVolume('MINT')).toBeNull();
  });

  it('returns null holder concentration when no Birdeye key is configured', async () => {
    const client = new DexscreenerBirdeyeAggregator(cfg);
    expect(await client.getHolderConcentration('MINT')).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('treats an all-buys, zero-sells pair as infinite buy/sell ratio', async () => {
    requestMock.mockResolvedValueOnce(
      jsonResponse(200, {
        pairs: [{ liquidity: { base: 40, usd: 4000 }, volume: { m5: 50 }, txns: { m5: { buys: 5, sells: 0 } } }],
      }),
    );
    const client = new DexscreenerBirdeyeAggregator(cfg);
    const result = await client.getLiquidityAndVolume('MINT');
    expect(result!.buySellRatio).toBe(Number.POSITIVE_INFINITY);
  });
});
