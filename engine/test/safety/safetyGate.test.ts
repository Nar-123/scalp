import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Connection } from '@solana/web3.js';

const getMintMock = vi.fn();
vi.mock('@solana/spl-token', () => ({
  getMint: (...args: unknown[]) => getMintMock(...args),
}));

const { runSafetyGate } = await import('../../src/safety/safetyGate.js');

const VALID_MINT = 'So11111111111111111111111111111111111111112';

function makeConnection(largestAccounts: { address: string; amount: string }[] = []): Connection {
  return {
    // Phase 5.6E: no Pump.fun bonding curve exists for this mint (both accounts missing) => the previous holder metric applies unchanged
    getMultipleAccountsInfo: vi.fn().mockResolvedValue([null, null]),
    getTokenLargestAccounts: vi.fn().mockResolvedValue({
      value: largestAccounts.map((a) => ({ address: { toBase58: () => a.address }, amount: a.amount })),
    }),
  } as unknown as Connection;
}

const cfg = {
  safety: { maxTop10HolderPct: 60, excludeAddresses: [] as string[] },
  filters: { minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 },
  edge: { dexFeeBps: 25, swapFeeBps: 5, networkFeeSol: 0.000005, priorityFeeSol: 0.0005, safetyMarginBps: 50 },
};

function goodMintInfo() {
  return { mintAuthority: null, freezeAuthority: null, supply: 1_000_000n, decimals: 6 };
}

describe('runSafetyGate', () => {
  beforeEach(() => {
    getMintMock.mockReset();
  });

  it('passes when every check succeeds', async () => {
    getMintMock.mockResolvedValue(goodMintInfo());
    const connection = makeConnection([{ address: 'holder1', amount: '100' }]);
    const aggregator = { getLiquidityAndVolume: vi.fn().mockResolvedValue({ liquiditySol: 40, volume1mSol: 10, buySellRatio: 2, txCount1m: 5 }) } as any;
    const getRoundTripQuote = vi.fn().mockResolvedValue({ buyPriceImpactPct: 0.5, sellPriceImpactPct: 0.5 });

    const result = await runSafetyGate(VALID_MINT, { connection, aggregator, getRoundTripQuote }, cfg);
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('fails closed and aggregates every failing reason', async () => {
    // mintInfo.mintAuthority/freezeAuthority mirror @solana/spl-token's real
    // Mint type: a PublicKey (with .toBase58()), not a plain string.
    getMintMock.mockResolvedValue({
      ...goodMintInfo(),
      mintAuthority: { toBase58: () => 'SomeMintAuthority' },
      freezeAuthority: { toBase58: () => 'SomeFreezeAuthority' },
    });
    const connection = {
      getTokenLargestAccounts: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as unknown as Connection;
    const aggregator = { getLiquidityAndVolume: vi.fn().mockResolvedValue(null) } as any;
    const getRoundTripQuote = vi.fn().mockResolvedValue(null);

    const result = await runSafetyGate(VALID_MINT, { connection, aggregator, getRoundTripQuote }, cfg);
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('mint_authority_not_renounced');
    expect(result.reasons).toContain('freeze_authority_present');
    expect(result.reasons).toContain('holder_data_unavailable');
    expect(result.reasons).toContain('liquidity_unavailable');
    expect(result.reasons).toContain('quote_unavailable');
  });

  it('fails when mint authority has not been renounced even if everything else passes', async () => {
    getMintMock.mockResolvedValue({ ...goodMintInfo(), mintAuthority: { toBase58: () => 'SomeMintAuthority' } });
    const connection = makeConnection([{ address: 'holder1', amount: '100' }]);
    const aggregator = { getLiquidityAndVolume: vi.fn().mockResolvedValue({ liquiditySol: 40, volume1mSol: 10, buySellRatio: 2, txCount1m: 5 }) } as any;
    const getRoundTripQuote = vi.fn().mockResolvedValue({ buyPriceImpactPct: 0.5, sellPriceImpactPct: 0.5 });

    const result = await runSafetyGate(VALID_MINT, { connection, aggregator, getRoundTripQuote }, cfg);
    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual(['mint_authority_not_renounced']);
  });
});
