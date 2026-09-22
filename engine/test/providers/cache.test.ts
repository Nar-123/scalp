import { describe, expect, it } from 'vitest';
import { SingleFlightCache } from '../../src/providers/singleFlightCache.js';
import { CachedSafetyDataSource, classifyFetchError, type FetchOutcome, type SafetyDataSource } from '../../src/safety/dataSource.js';
import { ProviderError } from '../../src/providers/providerGate.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';

describe('SingleFlightCache', () => {
  it('cache behavior: a hit within the TTL is served without a loader call, and expires after it', async () => {
    let t = 1000;
    let loads = 0;
    const m = new ProviderMetrics();
    const c = new SingleFlightCache<number>({ ttlMs: 2000, maxAgeMs: 10_000, now: () => t, metrics: m, kind: 'quote' });
    const load = async () => ++loads;
    const a = await c.get('k', load);
    const b = await c.get('k', load);
    expect(loads).toBe(1);
    expect(b?.cached).toBe(true);
    expect(b?.fetchedAtMs).toBe(a?.fetchedAtMs); // the as-of time travels with the value
    t += 2001;
    await c.get('k', load);
    expect(loads).toBe(2);
    expect(m.counters('quote').cacheHits).toBe(1);
    expect(m.counters('quote').cacheMisses).toBe(2);
  });

  it('request dedup: concurrent identical requests share one upstream call', async () => {
    let loads = 0;
    const m = new ProviderMetrics();
    const c = new SingleFlightCache<number>({ ttlMs: 0, maxAgeMs: 10_000, metrics: m, kind: 'rpc' });
    const load = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 10));
      return 7;
    };
    const rs = await Promise.all([c.get('k', load), c.get('k', load), c.get('k', load)]);
    expect(loads).toBe(1);
    expect(rs.every((r) => r?.value === 7)).toBe(true);
    expect(m.counters('rpc').dedupHits).toBe(2);
  });

  it('failures are never cached', async () => {
    let loads = 0;
    const c = new SingleFlightCache<number>({ ttlMs: 5000, maxAgeMs: 10_000 });
    expect(await c.get('k', async () => (loads += 1, null))).toBeNull();
    expect(await c.get('k', async () => { loads += 1; throw new Error('x'); })).toBeNull();
    expect(await c.get('k', async () => 5)).not.toBeNull();
    expect(loads).toBe(2);
  });

  it('a cache can never be configured to outlive the 10 s freshness bound', () => {
    expect(() => new SingleFlightCache({ ttlMs: 10_001, maxAgeMs: 10_000 })).toThrow();
  });

  it('a non-cacheable value is not reused', async () => {
    let loads = 0;
    const c = new SingleFlightCache<{ ok: boolean }>({ ttlMs: 5000, maxAgeMs: 10_000 });
    const load = async () => (loads += 1, { ok: false });
    await c.get('k', load, (v) => v.ok);
    await c.get('k', load, (v) => v.ok);
    expect(loads).toBe(2);
  });
});

describe('CachedSafetyDataSource', () => {
  const mint = { mint: 'm', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6 };
  function inner(fail: boolean): SafetyDataSource & { mintCalls: number } {
    const o = {
      mintCalls: 0,
      async getMintSummary(): Promise<FetchOutcome<typeof mint>> {
        o.mintCalls += 1;
        return fail ? { value: null, failure: { kind: 'provider', reason: 'rate_limited' }, asOfMs: Date.now() } : { value: mint, failure: null, asOfMs: Date.now() };
      },
      async getLargestHolders(): Promise<FetchOutcome<never[]>> {
        return { value: [], failure: null, asOfMs: Date.now() };
      },
    };
    return o as never;
  }

  it('reuses mint data within the TTL but keeps the ORIGINAL as-of time (no refreshing a timestamp by caching)', async () => {
    let t = 50_000;
    const i = inner(false);
    const c = new CachedSafetyDataSource(i, { ttlMs: 10_000, now: () => t });
    const first = await c.getMintSummary('m');
    t += 4000;
    const second = await c.getMintSummary('m');
    expect(i.mintCalls).toBe(1);
    expect(second.asOfMs).toBe(first.asOfMs);
  });

  it('does not cache a provider failure', async () => {
    const i = inner(true);
    const c = new CachedSafetyDataSource(i, { ttlMs: 10_000 });
    const a = await c.getMintSummary('m');
    await c.getMintSummary('m');
    expect(a.value).toBeNull();
    expect(a.failure).toEqual({ kind: 'provider', reason: 'rate_limited' });
    expect(i.mintCalls).toBe(2);
  });

  it('a TTL above the 10 s bound is clamped', async () => {
    let t = 0;
    const i = inner(false);
    const c = new CachedSafetyDataSource(i, { ttlMs: 60_000, now: () => t });
    await c.getMintSummary('m');
    t = 10_001;
    await c.getMintSummary('m');
    expect(i.mintCalls).toBe(2);
  });
});

describe('failure classification: provider problem vs token fact', () => {
  it('provider errors are provider failures; account-not-found is a token fact', () => {
    expect(classifyFetchError(new ProviderError('rpc', 'rate_limited', 'x', 1, null))).toEqual({ kind: 'provider', reason: 'rate_limited' });
    const e = new Error('nf');
    e.name = 'TokenAccountNotFoundError';
    expect(classifyFetchError(e).kind).toBe('token');
    const o = new Error('owner');
    o.name = 'TokenInvalidAccountOwnerError';
    expect(classifyFetchError(o)).toEqual({ kind: 'token', reason: 'unsupported_token_program' });
    expect(classifyFetchError(new Error('boom')).kind).toBe('provider');
  });
});
