import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';
import { createLogger } from '../../src/logging/logger.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';
import { classifyRpcEndpoint, createProviderStack, quoteEndpoints, rpcEndpoints } from '../../src/providers/providerStack.js';
import { clearRegisteredSecrets, redactSecrets, redactUrl, registerSecret } from '../../src/providers/redact.js';
import { ProviderMetricsRecorder } from '../../src/providers/metricsRecorder.js';
import { openLedger } from '../../src/ledger/db.js';
import { Writable } from 'node:stream';

const RPC_KEY = 'rpcSecretKey_9f8e7d6c5b4a';
const JUP_KEY = 'jupSecretKey_1a2b3c4d5e6f';

describe('dedicated RPC and quote configuration (environment only)', () => {
  const env = {
    SOLANA_RPC_URL: `https://rpc.dedicated.example/v2/${RPC_KEY}`,
    SOLANA_RPC_WS_URL: `wss://rpc.dedicated.example/v2/${RPC_KEY}`,
    SOLANA_RPC_API_KEY: RPC_KEY,
    SOLANA_RPC_FALLBACK_URLS: 'https://rpc.backup.example/x, https://rpc.backup2.example',
    SOLANA_RPC_MAX_RPS: '20',
    JUPITER_BASE_URL: 'https://quote.dedicated.example/swap/v1',
    JUPITER_API_KEY: JUP_KEY,
    JUPITER_MAX_RPS: '10',
  } as NodeJS.ProcessEnv;

  it('reads the dedicated endpoints, keys, fallbacks and limits from the environment', () => {
    const cfg = loadConfig(env);
    expect(cfg.rpc.httpUrl).toBe(env.SOLANA_RPC_URL);
    expect(cfg.rpc.wsUrl).toBe(env.SOLANA_RPC_WS_URL);
    expect(cfg.aggregators.jupiterQuoteBaseUrl).toBe('https://quote.dedicated.example/swap/v1');
    expect(cfg.providers.rpc.apiKey).toBe(RPC_KEY);
    expect(cfg.providers.rpc.fallbackUrls).toEqual(['https://rpc.backup.example/x', 'https://rpc.backup2.example']);
    expect(cfg.providers.rpc.maxRequestsPerSecond).toBe(20);
    expect(cfg.providers.quote.maxRequestsPerSecond).toBe(10);
  });

  it('the older env names keep working, and with nothing set there is NO fallback endpoint and no key', () => {
    const old = loadConfig({ RPC_HTTP_URL: 'https://old.example', RPC_WS_URL: 'wss://old.example', JUPITER_QUOTE_BASE_URL: 'https://oldq.example' } as NodeJS.ProcessEnv);
    expect(old.rpc.httpUrl).toBe('https://old.example');
    expect(old.aggregators.jupiterQuoteBaseUrl).toBe('https://oldq.example');
    const d = loadConfig({} as NodeJS.ProcessEnv);
    expect(d.providers.rpc.fallbackUrls).toEqual([]);
    expect(d.providers.quote.fallbackUrls).toEqual([]);
    expect(d.providers.rpc.apiKey).toBeUndefined();
  });

  it('the credential is sent as a header, never appended to the URL', () => {
    const cfg = loadConfig(env);
    expect(rpcEndpoints(cfg)[0]?.headers).toEqual({ 'x-api-key': RPC_KEY });
    expect(quoteEndpoints(cfg)[0]?.headers).toEqual({ 'x-api-key': JUP_KEY });
    expect(quoteEndpoints(cfg)[0]?.baseUrl).not.toContain(JUP_KEY);
  });

  it('cache TTLs cannot be configured above the 10 s freshness bound', () => {
    expect(() => getDefaultConfig({ providers: { quote: { cacheTtlMs: 20_000 } } } as never)).toThrow();
    expect(() => getDefaultConfig({ providers: { rpc: { safetyDataTtlMs: 20_000 } } } as never)).toThrow();
  });

  it('a keyless public endpoint is classified as such (it cannot serve getTokenLargestAccounts)', () => {
    expect(classifyRpcEndpoint('https://api.mainnet-beta.solana.com')).toBe('public_keyless');
    expect(classifyRpcEndpoint(env.SOLANA_RPC_URL as string)).toBe('configured');
  });

  it('the default quote endpoint is the resolvable keyless one (the old quote-api.jup.ag host does not resolve in DNS)', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).aggregators.jupiterQuoteBaseUrl).toBe('https://lite-api.jup.ag/swap/v1');
  });

  it('V1 thresholds and hard risk are unchanged by this phase', () => {
    const c = getDefaultConfig();
    expect(c.filters).toMatchObject({ minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 });
    expect(HARD_RISK_PARAMETERS.positionSizeSol).toBe(0.3);
    expect(c.dryRun).toBe(true);
  });
});

describe('no secret leakage', () => {
  it('redactUrl keeps scheme and host only (no path token, no query key)', () => {
    expect(redactUrl(`https://rpc.dedicated.example/v2/${RPC_KEY}?api-key=${RPC_KEY}`)).toBe('https://rpc.dedicated.example');
    expect(redactUrl('not a url')).toBe('[invalid-url]');
  });

  it('redactSecrets scrubs registered secrets and common credential patterns', () => {
    clearRegisteredSecrets();
    registerSecret(RPC_KEY);
    const out = redactSecrets(`fail https://x/${RPC_KEY} api-key=abcdef123456 x-api-key: zzzzzz999999 Authorization: Bearer tok_tok_tok_tok`);
    expect(out).not.toContain(RPC_KEY);
    expect(out).not.toContain('abcdef123456');
    expect(out).not.toContain('zzzzzz999999');
    expect(out).not.toContain('tok_tok_tok_tok');
    clearRegisteredSecrets();
  });

  it('the provider stack logs hosts only: no API key, no URL path token appears in anything it logs, and metrics carry no secrets', async () => {
    clearRegisteredSecrets();
    const cfg = loadConfig({
      SOLANA_RPC_URL: `https://rpc.dedicated.example/v2/${RPC_KEY}`,
      SOLANA_RPC_WS_URL: `wss://rpc.dedicated.example/v2/${RPC_KEY}`,
      SOLANA_RPC_API_KEY: RPC_KEY,
      JUPITER_API_KEY: JUP_KEY,
      JUPITER_BASE_URL: `https://quote.dedicated.example/${JUP_KEY}`,
    } as NodeJS.ProcessEnv);
    let out = '';
    const sink = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } });
    const logger = createLogger(cfg.logging, sink);
    const stack = createProviderStack(cfg, logger);
    const db = openLedger(':memory:');
    const rec = new ProviderMetricsRecorder(stack.metrics, db, logger, 0);
    stack.metrics.recordSafetyUnavailable('holders', 'provider:rate_limited');
    rec.snapshot();
    logger.warn({ apiKey: RPC_KEY, providers: cfg.providers }, 'explicit secret-named fields are redacted by the logger too');
    const stored = (db.prepare('SELECT snapshot_json j FROM provider_metrics_snapshots').get() as { j: string }).j;
    stack.shutdown();
    db.close();
    for (const s of [RPC_KEY, JUP_KEY]) {
      expect(out).not.toContain(s);
      expect(stored).not.toContain(s);
    }
    expect(out).toContain('rpc.dedicated.example');
    expect(JSON.stringify(stack.metrics.snapshot())).not.toContain(RPC_KEY);
    clearRegisteredSecrets();
  });

  it('ProviderMetrics snapshot contains counters only', () => {
    const m = new ProviderMetrics();
    m.inc('rpc', 'requests');
    m.endpointInc('https://h.example', 'requests');
    expect(Object.keys(m.snapshot())).toEqual(['atMs', 'kinds', 'endpoints', 'safetyUnavailable', 'lastProvider']);
  });
});
