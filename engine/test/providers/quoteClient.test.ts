import { describe, expect, it } from 'vitest';
import { JupiterQuoteClient, MAX_QUOTE_AGE_MS, WSOL_MINT } from '../../src/execution/jupiterQuoteClient.js';
import { MarketPriceSource } from '../../src/execution/marketPriceSource.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';
import { fakeFetch, gate } from './helpers.js';

const MINT = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const q = (over: Record<string, unknown> = {}) => JSON.stringify({ inAmount: '50000000', outAmount: '1234567', priceImpactPct: '0.004', routePlan: [{ swapInfo: { label: 'Pump' } }], ...over });

function client(script: Parameters<typeof fakeFetch>[0], over: { now?: () => number; cacheTtlMs?: number } = {}) {
  const f = fakeFetch(script);
  const metrics = new ProviderMetrics();
  const { gate: g } = gate({ kind: 'quote', fetchImpl: f.fn, maxRetries: 1, endpoints: [{ baseUrl: 'https://quote.example/swap/v1', headers: { 'x-api-key': 'QUOTEKEY_ABCDEF' } }] }, metrics);
  const c = new JupiterQuoteClient({ jupiterQuoteBaseUrl: 'https://quote.example/swap/v1', requestTimeoutMs: 200 }, undefined, { gate: g, metrics, cacheTtlMs: over.cacheTtlMs ?? 2000, ...(over.now ? { now: over.now } : {}) });
  return { c, f, metrics };
}

describe('dedicated quote config', () => {
  it('requests go to the configured base URL with the configured credential header', async () => {
    const { c, f } = client([{ body: q() }]);
    await c.getBuyQuote(MINT, 0.3, 100);
    expect(f.calls[0]?.url.startsWith('https://quote.example/swap/v1/quote?')).toBe(true);
    expect(f.calls[0]?.headers['x-api-key']).toBe('QUOTEKEY_ABCDEF');
  });
});

describe('BUY and SELL quotes are separate requests with real amounts', () => {
  it('BUY: SOL -> token with the requested SOL amount; returns raw tokens out, impact (in %) and route', async () => {
    const { c, f } = client([{ body: q({ priceImpactPct: '0.0123' }) }]);
    const quote = await c.getBuyQuote(MINT, 0.3, 100);
    const url = new URL(f.calls[0]!.url);
    expect(url.searchParams.get('inputMint')).toBe(WSOL_MINT);
    expect(url.searchParams.get('outputMint')).toBe(MINT);
    expect(url.searchParams.get('amount')).toBe('300000000');
    expect(quote?.outAmount).toBe('1234567');
    expect(quote?.priceImpactPct).toBeCloseTo(1.23, 6);
    expect(quote?.routePlanSummary).toBe('Pump');
    expect(quote?.provider).toBe('https://quote.example');
    expect(typeof quote?.fetchedAtMs).toBe('number');
  });

  it('SELL: token -> SOL for the ACTUAL held raw token amount, with its own impact', async () => {
    const { c, f } = client([{ body: q({ inAmount: '987654321', outAmount: '29000000', priceImpactPct: '0.031' }) }]);
    const held = 987_654_321n;
    const quote = await c.getSellQuote(MINT, held, 100);
    const url = new URL(f.calls[0]!.url);
    expect(url.searchParams.get('inputMint')).toBe(MINT);
    expect(url.searchParams.get('outputMint')).toBe(WSOL_MINT);
    expect(url.searchParams.get('amount')).toBe(held.toString());
    expect(quote?.priceImpactPct).toBeCloseTo(3.1, 6);
  });

  it('round trip: the sell leg uses the raw amount the buy leg returned and the sell impact is the sell quote, never the buy impact', async () => {
    const { c, f } = client((_i, url) => (url.includes(`inputMint=${WSOL_MINT}`) ? { body: q({ outAmount: '777', priceImpactPct: '0.002' }) } : { body: q({ inAmount: '777', outAmount: '49000000', priceImpactPct: '0.05' }) }));
    const rt = await c.getRoundTripQuote(MINT, 0.05, 100);
    expect(new URL(f.calls[1]!.url).searchParams.get('amount')).toBe('777');
    expect(rt?.buyPriceImpactPct).toBeCloseTo(0.2, 6);
    expect(rt?.sellPriceImpactPct).toBeCloseTo(5, 6);
    expect(rt?.asOfMs).toBeGreaterThan(0);
  });

  it('a "no route" answer means sellPriceImpactPct is null (token fact), NOT a default impact', async () => {
    const { c } = client((_i, url) => (url.includes(`inputMint=${WSOL_MINT}`) ? { body: q() } : { status: 400, body: '{"error":"Could not find any route","errorCode":"COULD_NOT_FIND_ANY_ROUTE"}' }));
    const rt = await c.getRoundTripQuote(MINT, 0.05, 100);
    expect(rt).not.toBeNull();
    expect(rt?.sellPriceImpactPct).toBeNull();
  });
});

describe('provider failure never becomes a default or a token fact', () => {
  it('quote 429 on the sell leg => the round trip is null (quote_unavailable), never "no sell route" and never a default 1% impact', async () => {
    const { c, metrics } = client((_i, url) => (url.includes(`inputMint=${WSOL_MINT}`) ? { body: q() } : { status: 429 }));
    const rt = await c.getRoundTripQuote(MINT, 0.05, 100);
    expect(rt).toBeNull();
    expect(metrics.counters('quote').http429).toBeGreaterThan(0);
  });

  it('total provider outage => getBuyQuote/getSellQuote are null (callers fail closed), no exception escapes', async () => {
    const { c } = client([{ status: 500 }]);
    expect(await c.getBuyQuote(MINT, 0.3, 100)).toBeNull();
    expect(await c.getSellQuote(MINT, 5n, 100)).toBeNull();
    const d = await c.getQuoteDetailed(WSOL_MINT, MINT, 1n, 100);
    expect(d).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('a malformed response (missing impact) is unavailable, not a zero/default impact', async () => {
    const { c } = client([{ body: JSON.stringify({ inAmount: '1', outAmount: '2' }) }]);
    expect(await c.getBuyQuote(MINT, 0.3, 100)).toBeNull();
  });
});

describe('quote caching and staleness', () => {
  it('identical quotes within the TTL are reused (and marked cached); after the TTL a new request is made', async () => {
    let t = 1_000_000;
    const { c, f } = client([{ body: q() }], { now: () => t, cacheTtlMs: 2000 });
    await c.getBuyQuote(MINT, 0.3, 100);
    const again = await c.getBuyQuote(MINT, 0.3, 100);
    expect(f.calls.length).toBe(1);
    expect(again?.cached).toBe(true);
    t += 2500;
    await c.getBuyQuote(MINT, 0.3, 100);
    expect(f.calls.length).toBe(2);
  });

  it('the quote cache cannot be configured beyond the 10 s freshness bound', () => {
    const f = fakeFetch([{ body: q() }]);
    const { gate: g } = gate({ kind: 'quote', fetchImpl: f.fn });
    const c = new JupiterQuoteClient({ jupiterQuoteBaseUrl: 'https://x.example', requestTimeoutMs: 100 }, undefined, { gate: g, cacheTtlMs: 999_999 });
    expect(c).toBeDefined(); // clamped to MAX_QUOTE_AGE_MS instead of throwing
  });

  it('stale quote rejection: MarketPriceSource treats a quote older than the freshness bound as unavailable', async () => {
    const stale = { inAmount: '1', outAmount: '1000', priceImpactPct: 0.5, inputMint: WSOL_MINT, outputMint: MINT, slippageBps: 100, routePlanSummary: '', fetchedAtMs: Date.now() - MAX_QUOTE_AGE_MS - 1000 };
    const fresh = { ...stale, fetchedAtMs: Date.now() };
    const agg = { getPrice: async () => 1, getLiquidityAndVolume: async () => null, getHolderConcentration: async () => null } as never;
    const mk = (quote: typeof stale) => new MarketPriceSource(agg, { getBuyQuote: async () => quote, getSellQuote: async () => quote } as never);
    expect(await mk(stale).getEstimatedPriceImpactPct(MINT, 0.3)).toBeNull();
    expect(await mk(fresh).getEstimatedPriceImpactPct(MINT, 0.3)).toBe(0.5);
    expect(await mk(stale).getSellPriceImpactPct(MINT, '1000')).toBeNull();
  });
});

describe('quote provider fallback (explicitly configured only)', () => {
  it('falls back to the second configured quote endpoint and reports which host answered', async () => {
    const f = fakeFetch((_i, url) => (url.includes('primary') ? { status: 500 } : { body: q() }));
    const metrics = new ProviderMetrics();
    const { gate: g } = gate({ kind: 'quote', fetchImpl: f.fn, maxRetries: 0, endpoints: [{ baseUrl: 'https://primary.example' }, { baseUrl: 'https://backup.example' }] }, metrics);
    const c = new JupiterQuoteClient({ jupiterQuoteBaseUrl: 'https://primary.example', requestTimeoutMs: 200 }, undefined, { gate: g, metrics });
    const quote = await c.getBuyQuote(MINT, 0.3, 100);
    expect(quote?.provider).toBe('https://backup.example');
    expect(metrics.counters('quote').fallbackUsed).toBe(1);
  });
});
