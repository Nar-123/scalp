import { Connection } from '@solana/web3.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { JupiterQuoteClient } from '../execution/jupiterQuoteClient.js';
import { CachedSafetyDataSource, DirectSafetyDataSource, type SafetyDataSource } from '../safety/dataSource.js';
import { ProviderError, ProviderGate, type ProviderEndpoint } from './providerGate.js';
import { ProviderMetrics } from './providerMetrics.js';
import { redactUrl, registerSecret, secretsInUrl } from './redact.js';

/** Hosts of keyless public endpoints known NOT to serve the safety gate's methods (see docs/PHASE_5_6A_PROVIDER_RELIABILITY.md). */
const KNOWN_PUBLIC_RPC_HOSTS = new Set(['api.mainnet-beta.solana.com', 'api.devnet.solana.com', 'api.testnet.solana.com', 'solana-rpc.publicnode.com', 'rpc.ankr.com', 'solana.drpc.org']);

export function classifyRpcEndpoint(url: string): 'public_keyless' | 'configured' {
  try {
    return KNOWN_PUBLIC_RPC_HOSTS.has(new URL(url).host) ? 'public_keyless' : 'configured';
  } catch {
    return 'configured';
  }
}

type RpcCfg = Pick<AppConfig, 'rpc' | 'providers'>;

/** Endpoint list for the RPC gate: the primary first, then the explicitly configured fallbacks, in order. */
export function rpcEndpoints(cfg: RpcCfg): ProviderEndpoint[] {
  const headers = cfg.providers.rpc.apiKey ? { 'x-api-key': cfg.providers.rpc.apiKey } : undefined;
  const urls = [cfg.rpc.httpUrl, ...cfg.providers.rpc.fallbackUrls];
  return urls.map((baseUrl) => ({ baseUrl, ...(headers ? { headers } : {}) }));
}

export function quoteEndpoints(cfg: Pick<AppConfig, 'aggregators' | 'providers'>): ProviderEndpoint[] {
  const headers = cfg.providers.quote.apiKey ? { 'x-api-key': cfg.providers.quote.apiKey } : undefined;
  const urls = [cfg.aggregators.jupiterQuoteBaseUrl, ...cfg.providers.quote.fallbackUrls];
  return urls.map((baseUrl) => ({ baseUrl, ...(headers ? { headers } : {}) }));
}

/** A `fetch` for web3.js that sends every JSON-RPC HTTP call through the gate (limits, retries, fallback, shutdown). */
export function gateFetch(gate: ProviderGate): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    void input; // the URL is chosen by the gate (primary, then fallbacks); web3.js only knows the primary
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let rpcMethod: string | undefined;
    try {
      const parsed = body ? (JSON.parse(body) as { method?: string } | Array<{ method?: string }>) : undefined;
      rpcMethod = Array.isArray(parsed) ? parsed[0]?.method : parsed?.method;
    } catch {
      // not JSON: no method-level tracking
    }
    const res = await gate.execute({ method: 'POST', ...(body !== undefined ? { body } : {}), headers: { 'content-type': 'application/json' }, ...(rpcMethod ? { rpcMethod } : {}) });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }) as unknown as typeof fetch;
}

export interface ProviderStack {
  metrics: ProviderMetrics;
  rpcGate: ProviderGate;
  quoteGate: ProviderGate;
  connection: Connection;
  jupiter: JupiterQuoteClient;
  safetyData: SafetyDataSource;
  /** 'public_keyless' when the primary RPC is a known keyless public endpoint (which cannot serve getTokenLargestAccounts). */
  rpcClass: 'public_keyless' | 'configured';
  /** Aborts every in-flight provider request and refuses new ones. Bounded and idempotent. */
  shutdown(): void;
}

/**
 * Builds the provider layer once, from configuration. The safety gate keeps its own semantics; it simply receives a
 * Connection whose HTTP goes through the RPC gate, a quote client that goes through the quote gate, and a cached,
 * deduplicated safety data source.
 */
export function createProviderStack(cfg: Pick<AppConfig, 'rpc' | 'providers' | 'aggregators'>, logger?: Logger): ProviderStack {
  for (const url of [cfg.rpc.httpUrl, ...cfg.providers.rpc.fallbackUrls, cfg.aggregators.jupiterQuoteBaseUrl, ...cfg.providers.quote.fallbackUrls]) for (const s of secretsInUrl(url)) registerSecret(s);
  registerSecret(cfg.providers.rpc.apiKey);
  registerSecret(cfg.providers.quote.apiKey);

  const metrics = new ProviderMetrics();
  const r = cfg.providers.rpc;
  const q = cfg.providers.quote;
  const rpcGate = new ProviderGate(
    { kind: 'rpc', endpoints: rpcEndpoints(cfg), timeoutMs: r.timeoutMs, maxConcurrent: r.maxConcurrent, maxRequestsPerSecond: r.maxRequestsPerSecond, maxRetries: r.maxRetries, baseBackoffMs: r.baseBackoffMs, maxBackoffMs: r.maxBackoffMs, maxTotalMs: r.maxTotalMs, circuitFailureThreshold: r.circuitFailureThreshold, circuitCooldownMs: r.circuitCooldownMs, unsupportedCooldownMs: r.unsupportedCooldownMs },
    metrics,
    logger,
  );
  const quoteGate = new ProviderGate(
    { kind: 'quote', endpoints: quoteEndpoints(cfg), timeoutMs: q.timeoutMs, maxConcurrent: q.maxConcurrent, maxRequestsPerSecond: q.maxRequestsPerSecond, maxRetries: q.maxRetries, baseBackoffMs: q.baseBackoffMs, maxBackoffMs: q.maxBackoffMs, maxTotalMs: q.maxTotalMs, circuitFailureThreshold: q.circuitFailureThreshold, circuitCooldownMs: q.circuitCooldownMs, unsupportedCooldownMs: q.unsupportedCooldownMs },
    metrics,
    logger,
  );
  const connection = new Connection(cfg.rpc.httpUrl, { wsEndpoint: cfg.rpc.wsUrl, commitment: 'confirmed', fetch: gateFetch(rpcGate), disableRetryOnRateLimit: true });
  const jupiter = new JupiterQuoteClient({ jupiterQuoteBaseUrl: cfg.aggregators.jupiterQuoteBaseUrl, requestTimeoutMs: q.timeoutMs }, logger, { gate: quoteGate, metrics, cacheTtlMs: q.cacheTtlMs });
  const direct = new DirectSafetyDataSource(connection);
  const safetyData = r.safetyDataTtlMs > 0 ? new CachedSafetyDataSource(direct, { ttlMs: r.safetyDataTtlMs, metrics }) : direct;
  const rpcClass = classifyRpcEndpoint(cfg.rpc.httpUrl);
  logger?.info(
    { rpcHost: redactUrl(cfg.rpc.httpUrl), rpcClass, rpcFallbacks: cfg.providers.rpc.fallbackUrls.map(redactUrl), quoteHost: redactUrl(cfg.aggregators.jupiterQuoteBaseUrl), quoteFallbacks: cfg.providers.quote.fallbackUrls.map(redactUrl) },
    'provider stack configured',
  );
  if (rpcClass === 'public_keyless') {
    logger?.warn({ rpcHost: redactUrl(cfg.rpc.httpUrl) }, 'RPC is a keyless public endpoint: getTokenLargestAccounts is not served there, so holder data will be unavailable and the safety gate will fail closed');
  }
  return {
    metrics,
    rpcGate,
    quoteGate,
    connection,
    jupiter,
    safetyData,
    rpcClass,
    shutdown(): void {
      rpcGate.shutdown();
      quoteGate.shutdown();
    },
  };
}

export { ProviderError };
