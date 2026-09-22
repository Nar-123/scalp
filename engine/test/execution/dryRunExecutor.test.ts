import { describe, expect, it, vi } from 'vitest';
import { DryRunExecutor } from '../../src/execution/dryRunExecutor.js';
import type { PriceSource } from '../../src/execution/types.js';

const cfg = {
  edge: { dexFeeBps: 25, swapFeeBps: 5, networkFeeSol: 0.000005, priorityFeeSol: 0.0005, safetyMarginBps: 50 },
  execution: { latencySlippageBufferPct: 0.3, fallbackPriceImpactPct: 1, liveTradingExplicitlyEnabled: false },
};

function priceSource(overrides: Partial<PriceSource> = {}): PriceSource {
  return {
    getPrice: vi.fn().mockResolvedValue(1),
    getEstimatedPriceImpactPct: vi.fn().mockResolvedValue(0.5),
    getBuyExecutionQuote: vi.fn().mockResolvedValue({ priceImpactPct: 0.5, tokenAmountRaw: '1000000' }),
    getSellPriceImpactPct: vi.fn().mockResolvedValue(0.5),
    ...overrides,
  };
}

describe('DryRunExecutor', () => {
  it('produces a deterministic simulated buy fill applying fees/impact/slippage', async () => {
    const executor = new DryRunExecutor(priceSource(), cfg);
    const fill = await executor.buy({ mint: 'MINT', amountSol: 0.3, maxSlippageBps: 100 });

    expect(fill.success).toBe(true);
    expect(fill.simulated).toBe(true);
    expect(fill.txSignature).toBeNull();
    expect(fill.filledPriceSol).toBe(1);

    const bpsFees = (0.3 * (25 + 5)) / 10_000;
    const fixedFees = 0.000005 + 0.0005;
    const feesSol = fixedFees + bpsFees;
    const expectedFilled = 0.3 - feesSol - (0.3 * (0.5 + 0.3)) / 100;
    expect(fill.feesSol).toBeCloseTo(feesSol, 10);
    expect(fill.filledAmountSol).toBeCloseTo(expectedFilled, 10);
  });

  it('fails the fill (rather than throwing) when price is unavailable', async () => {
    const executor = new DryRunExecutor(priceSource({ getPrice: vi.fn().mockResolvedValue(null) }), cfg);
    const fill = await executor.buy({ mint: 'MINT', amountSol: 0.3, maxSlippageBps: 100 });
    expect(fill.success).toBe(false);
    expect(fill.error).toBe('price_unavailable');
    expect(fill.filledAmountSol).toBe(0);
  });

  it('FAILS CLOSED (Phase 5.6) when the buy price impact is unavailable: no fallback default is invented', async () => {
    const executor = new DryRunExecutor(priceSource({ getBuyExecutionQuote: vi.fn().mockResolvedValue(null) }), cfg);
    const fill = await executor.buy({ mint: 'MINT', amountSol: 0.3, maxSlippageBps: 100 });
    expect(fill.success).toBe(false);
    expect(fill.error).toBe('buy_price_impact_unavailable');
    expect(fill.filledAmountSol).toBe(0);
  });

  it('sell computes value from the price ratio since entry, not raw token amounts', async () => {
    const executor = new DryRunExecutor(priceSource({ getPrice: vi.fn().mockResolvedValue(2) }), cfg); // price doubled
    const fill = await executor.sell({ mint: 'MINT', entryPriceSol: 1, entryFilledAmountSol: 0.29, tokenAmountRaw: '1000000', maxSlippageBps: 100 });

    expect(fill.success).toBe(true);
    const grossValueSol = 0.29 * (2 / 1);
    expect(fill.filledAmountSol).toBeLessThan(grossValueSol); // fees/impact reduce it
    expect(fill.filledAmountSol).toBeGreaterThan(0);
  });

  it('never lets filledAmountSol go negative even under extreme fees/impact', async () => {
    const extremeCfg = { ...cfg, execution: { latencySlippageBufferPct: 200, fallbackPriceImpactPct: 60, liveTradingExplicitlyEnabled: false } };
    const executor = new DryRunExecutor(priceSource(), extremeCfg);
    const fill = await executor.buy({ mint: 'MINT', amountSol: 0.3, maxSlippageBps: 100 });
    expect(fill.filledAmountSol).toBe(0);
  });
});
