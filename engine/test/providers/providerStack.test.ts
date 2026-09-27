import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { rpcEndpoints, quoteEndpoints, createProviderStack } from '../../src/providers/providerStack.js';
import { PriorityAdmissionGate } from '../../src/providers/priorityAdmissionGate.js';
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

/**
 * fix/priority-admission-rpc: `createProviderStack(...).shutdown()` must cascade to the internal
 * `rpcAdmission.shutdown()`, cleanly rejecting any caller still WAITING for an admission ticket. `rpcAdmission`
 * itself is a private local inside `createProviderStack` -- not part of the `ProviderStack` interface, and there is
 * no reason to widen that interface just for this -- so it is observed here by spying on
 * `PriorityAdmissionGate.prototype.shutdown` (capturing the real instance `createProviderStack` constructs,
 * `mockImplementation` still calling straight through to the real, unmodified method) rather than by trying to
 * infer it indirectly from web3.js's own error handling: a waiter rejected by `PriorityAdmissionGate.shutdown()`
 * and a waiter that happens to get naturally released once an unrelated in-flight call is aborted by
 * `rpcGate.shutdown()` are, once past several layers of `@solana/web3.js`'s own error wrapping, NOT reliably
 * distinguishable from `DirectSafetyDataSource`'s side by error shape alone -- confirmed empirically while writing
 * this test. Observing the call directly, on the real instance, is the reliable way to test this specific wiring.
 * "Rejected cleanly" (no waiter left dangling, no slot leak) is proven separately and thoroughly, in isolation, by
 * `priorityAdmissionGate.test.ts`'s own `shutdown` describe block -- this test only needs to prove the cascade
 * actually happens.
 */
describe('shutdown cascades to the priority-admission layer (fix/priority-admission-rpc)', () => {
  it('createProviderStack(...).shutdown() calls the real rpcAdmission instance\'s own shutdown(), which clears its waiter queues', async () => {
    const originalFetch = globalThis.fetch;
    let firstCallStarted = false;
    let capturedAdmission: PriorityAdmissionGate | undefined;
    const captureInstance = (instance: PriorityAdmissionGate): void => {
      capturedAdmission = instance; // the REAL instance createProviderStack constructed -- not a fake/stand-in
    };
    const originalAdmissionShutdown = PriorityAdmissionGate.prototype.shutdown;
    const shutdownSpy = vi.spyOn(PriorityAdmissionGate.prototype, 'shutdown').mockImplementation(function (this: PriorityAdmissionGate) {
      captureInstance(this);
      return originalAdmissionShutdown.call(this);
    });
    // `rpcGate` (constructed inside createProviderStack with no explicit `fetchImpl`) falls back to the GLOBAL
    // `fetch` -- stubbing it here lets this test occupy the one admission slot without a real network call.
    globalThis.fetch = ((_url: string, init: { signal: AbortSignal }) => {
      firstCallStarted = true;
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch;

    try {
      // maxConcurrent: 1 makes the SECOND call below queue purely at the admission layer (it never reaches
      // `rpcGate.execute()`). safetyDataTtlMs: 0 means `providers.safetyData` is the bare `DirectSafetyDataSource`
      // (no single-flight cache to interfere with two independent calls).
      const cfg = getDefaultConfig({
        rpc: { httpUrl: 'https://primary.example', wsUrl: 'wss://primary.example' },
        providers: { rpc: { maxConcurrent: 1, safetyDataTtlMs: 0 } },
      });
      const providers = createProviderStack(cfg);
      expect(shutdownSpy).not.toHaveBeenCalled(); // constructing the stack must never itself shut anything down

      // Two REAL, valid, distinct PublicKeys -- an arbitrary base58 string of the right length (e.g. all-digit
      // placeholders) fails `new PublicKey(...)`'s own decode/length check SYNCHRONOUSLY, before either call ever
      // reaches the network or the admission layer at all, which would make this test pass for the wrong reason.
      const mintA = Keypair.generate().publicKey.toBase58();
      const mintB = Keypair.generate().publicKey.toBase58();

      // First call: admitted immediately, occupies the one admission slot, and hangs deliberately (our stub never
      // resolves on its own) so the second call below is guaranteed to find the slot taken.
      const firstCall = providers.safetyData.getMintSummary(mintA);
      await vi.waitFor(() => {
        if (!firstCallStarted) throw new Error('first call has not reached fetch yet');
      });

      // Second call, a DIFFERENT mint: with the one admission slot already taken, this becomes a genuine
      // ADMISSION-layer waiter -- it must still be PENDING here, never having reached `gate.execute()` at all.
      const secondCall = providers.safetyData.getMintSummary(mintB);
      const secondSettledEarly = await Promise.race([secondCall.then(() => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
      expect(secondSettledEarly).toBe(false); // must still be queued, not already settled, before shutdown() is even called

      providers.shutdown();

      expect(shutdownSpy).toHaveBeenCalledTimes(1); // the cascade this test exists to prove
      expect(capturedAdmission?.isShutdown).toBe(true);
      expect(capturedAdmission?.pendingHigh).toBe(0); // the queued waiter was cleared, not left dangling

      // Sanity check only (not the primary assertion above): the caller-visible side settles too, promptly, never hanging.
      const second = await secondCall;
      expect(second.value).toBeNull();
      expect(second.failure?.kind).toBe('provider');

      await firstCall.catch(() => undefined); // the first call was already in flight; rpcGate.shutdown() (unrelated, pre-existing) aborts it
    } finally {
      globalThis.fetch = originalFetch;
      shutdownSpy.mockRestore();
    }
  });
});
