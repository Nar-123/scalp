import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Connection } from '@solana/web3.js';

const getMintMock = vi.fn();
vi.mock('@solana/spl-token', () => ({
  getMint: (...args: unknown[]) => getMintMock(...args),
}));

const { runSafetyGate } = await import('../../src/safety/safetyGate.js');

const VALID_MINT = 'So11111111111111111111111111111111111111112';

const cfg = {
  safety: { maxTop10HolderPct: 60, excludeAddresses: [] as string[] },
  filters: { minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 },
  edge: { dexFeeBps: 25, swapFeeBps: 5, networkFeeSol: 0.000005, priorityFeeSol: 0.0005, safetyMarginBps: 50 },
};

beforeEach(() => {
  getMintMock.mockReset();
});

describe('safety gate malformed / adversarial data handling', () => {
  it('fails closed when getTokenLargestAccounts RPC call throws', async () => {
    getMintMock.mockResolvedValue({ mintAuthority: null, freezeAuthority: null, supply: 1000n, decimals: 6 });
    const connection = {
      getTokenLargestAccounts: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
    } as unknown as Connection;
    const aggregator = { getLiquidityAndVolume: vi.fn().mockResolvedValue({ liquiditySol: 40, volume1mSol: 10, buySellRatio: 2, txCount1m: 5 }) } as any;
    const getRoundTripQuote = vi.fn().mockResolvedValue({ buyPriceImpactPct: 0.5, sellPriceImpactPct: 0.5 });

    const result = await runSafetyGate(VALID_MINT, { connection, aggregator, getRoundTripQuote }, cfg);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('holder_data_unavailable');
  });

  it('fails closed on negative liquidity from the aggregator', async () => {
    getMintMock.mockResolvedValue({ mintAuthority: null, freezeAuthority: null, supply: 1000n, decimals: 6 });
    const connection = {
      getTokenLargestAccounts: vi.fn().mockResolvedValue({ value: [] }),
    } as unknown as Connection;
    const aggregator = { getLiquidityAndVolume: vi.fn().mockResolvedValue({ liquiditySol: -5, volume1mSol: 10, buySellRatio: 2, txCount1m: 5 }) } as any;
    const getRoundTripQuote = vi.fn().mockResolvedValue({ buyPriceImpactPct: 0.5, sellPriceImpactPct: 0.5 });

    const result = await runSafetyGate(VALID_MINT, { connection, aggregator, getRoundTripQuote }, cfg);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('liquidity_below_minimum');
  });

  it('fails closed (does not throw) when the aggregator violates its no-throw contract', async () => {
    getMintMock.mockResolvedValue({ mintAuthority: null, freezeAuthority: null, supply: 1000n, decimals: 6 });
    const connection = { getTokenLargestAccounts: vi.fn().mockResolvedValue({ value: [] }) } as unknown as Connection;
    const aggregator = { getLiquidityAndVolume: vi.fn().mockRejectedValue(new Error('network error')) } as any;
    const getRoundTripQuote = vi.fn().mockResolvedValue(null);

    const result = await runSafetyGate(VALID_MINT, { connection, aggregator, getRoundTripQuote }, cfg);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('liquidity_unavailable');
  });
});
