import { describe, expect, it } from 'vitest';
import { checkTickDataQuality } from '../../src/shadow/dataQualityMonitor.js';
import { entryEligibleTick } from './fixtures.js';

describe('checkTickDataQuality', () => {
  it('reports nothing for the first tick seen on a mint', () => {
    const issues = checkTickDataQuality('MINT_A', 'V1', null, entryEligibleTick());
    expect(issues).toEqual([]);
  });

  it('reports nothing for two well-formed, well-spaced, ordered ticks', () => {
    const first = entryEligibleTick({ observedAtMs: 40_000 });
    const second = entryEligibleTick({ observedAtMs: 42_000 });
    expect(checkTickDataQuality('MINT_A', 'V1', first, second)).toEqual([]);
  });

  it('detects a duplicate observedAtMs', () => {
    const tick = entryEligibleTick({ observedAtMs: 40_000 });
    const issues = checkTickDataQuality('MINT_A', 'V1', tick, entryEligibleTick({ observedAtMs: 40_000 }));
    expect(issues.some((i) => i.kind === 'duplicate_event')).toBe(true);
  });

  it('detects an out-of-order tick', () => {
    const first = entryEligibleTick({ observedAtMs: 42_000 });
    const second = entryEligibleTick({ observedAtMs: 40_000 });
    const issues = checkTickDataQuality('MINT_A', 'V1', first, second);
    expect(issues.some((i) => i.kind === 'out_of_order_event')).toBe(true);
  });

  it('detects stale market data when the gap exceeds the threshold', () => {
    const first = entryEligibleTick({ observedAtMs: 40_000 });
    const second = entryEligibleTick({ observedAtMs: 40_000 + 15_000 });
    const issues = checkTickDataQuality('MINT_A', 'V1', first, second);
    expect(issues.some((i) => i.kind === 'stale_market_data')).toBe(true);
  });

  it('does not flag a normal ~2s polling gap as stale', () => {
    const first = entryEligibleTick({ observedAtMs: 40_000 });
    const second = entryEligibleTick({ observedAtMs: 42_000 });
    expect(checkTickDataQuality('MINT_A', 'V1', first, second)).toEqual([]);
  });

  it('detects an impossible price jump', () => {
    const first = entryEligibleTick({ observedAtMs: 40_000, priceSol: 1 });
    const second = entryEligibleTick({ observedAtMs: 42_000, priceSol: 50 });
    const issues = checkTickDataQuality('MINT_A', 'V1', first, second);
    expect(issues.some((i) => i.kind === 'impossible_price_change')).toBe(true);
  });

  it('does not flag a plausible price move', () => {
    const first = entryEligibleTick({ observedAtMs: 40_000, priceSol: 1 });
    const second = entryEligibleTick({ observedAtMs: 42_000, priceSol: 1.1 });
    expect(checkTickDataQuality('MINT_A', 'V1', first, second)).toEqual([]);
  });

  it('detects invalid (negative) liquidity', () => {
    const issues = checkTickDataQuality('MINT_A', 'V1', null, entryEligibleTick({ liquiditySol: -5 }));
    expect(issues.some((i) => i.kind === 'invalid_liquidity')).toBe(true);
  });

  it('surfaces an rpc fetch error as an rpc_error data-quality event', () => {
    const tick = entryEligibleTick({ fetchError: { source: 'rpc', message: 'timeout' } });
    const issues = checkTickDataQuality('MINT_A', 'V1', null, tick);
    expect(issues.some((i) => i.kind === 'rpc_error')).toBe(true);
  });

  it('surfaces an aggregator fetch error as an aggregator_error data-quality event', () => {
    const tick = entryEligibleTick({ fetchError: { source: 'aggregator', message: 'timeout' } });
    const issues = checkTickDataQuality('MINT_A', 'V1', null, tick);
    expect(issues.some((i) => i.kind === 'aggregator_error')).toBe(true);
  });
});
