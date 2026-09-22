import { describe, expect, it, beforeEach } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { rpcEndpoints, quoteEndpoints, createProviderStack } from '../../src/providers/providerStack.js';
import { clearRegisteredSecrets, redactSecrets } from '../../src/providers/redact.js';

/**
 * P1 fix #4: provider credential isolation. `rpcEndpoints()`/`quoteEndpoints()` used to attach the PRIMARY
 * endpoint's API-key header to every configured endpoint they returned, including every fallback -- silently
 * leaking a credential belonging to one provider to a completely different fallback provider on every request that
 * endpoint sent.
 */

beforeEach(() => {
  clearRegisteredSecrets();
});

function cfgWithRpc(over: Partial<{ apiKey: string; fallbackUrls: string[]; fallbackApiKeys: string[] }>) {
  return getDefaultConfig({
    rpc: { httpUrl: 'https://primary-rpc.example/v1', wsUrl: 'wss://primary-rpc.example/v1' },
    providers: {
      rpc: { apiKey: over.apiKey, fallbackUrls: over.fallbackUrls ?? [], fallbackApiKeys: over.fallbackApiKeys ?? [] },
    },
  });
}

function cfgWithQuote(over: Partial<{ apiKey: string; fallbackUrls: string[]; fallbackApiKeys: string[] }>) {
  return getDefaultConfig({
    providers: {
      quote: { apiKey: over.apiKey, fallbackUrls: over.fallbackUrls ?? [], fallbackApiKeys: over.fallbackApiKeys ?? [] },
    },
  });
}

describe('rpcEndpoints: credential isolation', () => {
  it('the primary endpoint receives the primary API key', () => {
    const cfg = cfgWithRpc({ apiKey: 'primary-secret-key-1' });
    const [primary] = rpcEndpoints(cfg);
    expect(primary!.baseUrl).toBe('https://primary-rpc.example/v1');
    expect(primary!.headers).toEqual({ 'x-api-key': 'primary-secret-key-1' });
  });

  it('a fallback with no explicit credential receives NO headers at all -- never the primary key', () => {
    const cfg = cfgWithRpc({ apiKey: 'primary-secret-key-1', fallbackUrls: ['https://fallback-a.example', 'https://fallback-b.example'] });
    const endpoints = rpcEndpoints(cfg);
    expect(endpoints).toHaveLength(3);
    expect(endpoints[1]).toEqual({ baseUrl: 'https://fallback-a.example' }); // no `headers` key at all
    expect(endpoints[2]).toEqual({ baseUrl: 'https://fallback-b.example' });
    expect(JSON.stringify(endpoints[1])).not.toContain('primary-secret-key-1');
    expect(JSON.stringify(endpoints[2])).not.toContain('primary-secret-key-1');
  });

  it('a fallback with an explicitly configured credential (index-aligned) gets ONLY that credential, isolated to it', () => {
    const cfg = cfgWithRpc({
      apiKey: 'primary-secret-key-1',
      fallbackUrls: ['https://fallback-a.example', 'https://fallback-b.example'],
      fallbackApiKeys: ['fallback-a-secret', ''], // b has no key of its own
    });
    const endpoints = rpcEndpoints(cfg);
    expect(endpoints[1]).toEqual({ baseUrl: 'https://fallback-a.example', headers: { 'x-api-key': 'fallback-a-secret' } });
    expect(endpoints[2]).toEqual({ baseUrl: 'https://fallback-b.example' }); // empty string => no credential, not the primary's
    expect(endpoints[0]!.headers).toEqual({ 'x-api-key': 'primary-secret-key-1' }); // primary untouched
  });

  it('no primary API key configured: the primary gets no headers either (no credential to isolate FROM)', () => {
    const cfg = cfgWithRpc({ fallbackUrls: ['https://fallback-a.example'] });
    const endpoints = rpcEndpoints(cfg);
    expect(endpoints[0]).toEqual({ baseUrl: 'https://primary-rpc.example/v1' });
    expect(endpoints[1]).toEqual({ baseUrl: 'https://fallback-a.example' });
  });

  it('fallback functionality still works: every configured endpoint is still returned, in order, primary first', () => {
    const cfg = cfgWithRpc({ apiKey: 'k', fallbackUrls: ['https://a.example', 'https://b.example', 'https://c.example'] });
    const endpoints = rpcEndpoints(cfg);
    expect(endpoints.map((e) => e.baseUrl)).toEqual(['https://primary-rpc.example/v1', 'https://a.example', 'https://b.example', 'https://c.example']);
  });

  it('single-primary configuration (no fallbacks at all -- every current VPS deployment) is unaffected', () => {
    const cfg = cfgWithRpc({ apiKey: 'the-only-key' });
    const endpoints = rpcEndpoints(cfg);
    expect(endpoints).toEqual([{ baseUrl: 'https://primary-rpc.example/v1', headers: { 'x-api-key': 'the-only-key' } }]);
  });
});

describe('quoteEndpoints: the same isolation rule applies to the Jupiter quote gate', () => {
  it('primary receives the quote API key; a fallback with none configured receives nothing', () => {
    const cfg = cfgWithQuote({ apiKey: 'quote-secret', fallbackUrls: ['https://quote-fallback.example'] });
    const endpoints = quoteEndpoints(cfg);
    expect(endpoints[0]!.headers).toEqual({ 'x-api-key': 'quote-secret' });
    expect(endpoints[1]).toEqual({ baseUrl: 'https://quote-fallback.example' });
  });

  it('an explicitly configured fallback credential is isolated to that one fallback', () => {
    const cfg = cfgWithQuote({ apiKey: 'quote-secret', fallbackUrls: ['https://quote-fallback.example'], fallbackApiKeys: ['fallback-quote-secret'] });
    const endpoints = quoteEndpoints(cfg);
    expect(endpoints[1]).toEqual({ baseUrl: 'https://quote-fallback.example', headers: { 'x-api-key': 'fallback-quote-secret' } });
  });
});

describe('secret hygiene: every configured credential (primary AND fallback) is registered for log redaction', () => {
  it('a fallback API key never appears verbatim in redacted text, exactly like the primary key', () => {
    const cfg = getDefaultConfig({
      rpc: { httpUrl: 'https://primary.example', wsUrl: 'wss://primary.example' },
      aggregators: { jupiterQuoteBaseUrl: 'https://quote.example' },
      providers: {
        rpc: { apiKey: 'PRIMARY_SECRET_VALUE', fallbackUrls: ['https://fb.example'], fallbackApiKeys: ['FALLBACK_SECRET_VALUE'] },
        quote: {},
      },
    });
    createProviderStack(cfg);
    const text = `error talking to provider, header was x-api-key: PRIMARY_SECRET_VALUE and also FALLBACK_SECRET_VALUE somewhere`;
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('PRIMARY_SECRET_VALUE');
    expect(redacted).not.toContain('FALLBACK_SECRET_VALUE');
  });

  it('createProviderStack never throws for a single-primary config with no fallbacks (current VPS shape)', () => {
    const cfg = getDefaultConfig({ rpc: { httpUrl: 'https://primary.example', wsUrl: 'wss://primary.example' } });
    expect(() => createProviderStack(cfg).shutdown()).not.toThrow();
  });
});
