import { Connection } from '@solana/web3.js';
import type { AppConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { JupiterQuoteClient } from '../execution/jupiterQuoteClient.js';
import { CachedSafetyDataSource, DirectSafetyDataSource, type SafetyDataSource } from '../safety/dataSource.js';
import { ProviderError, ProviderGate, type ProviderEndpoint, type GateResponse } from './providerGate.js';
import { ProviderMetrics } from './providerMetrics.js';
import { PriorityAdmissionGate, type AdmissionPriority } from './priorityAdmissionGate.js';
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

/**
 * Endpoint list for the RPC gate: the primary first, then the explicitly configured fallbacks, in order.
 *
 * P1 credential-isolation fix: `cfg.providers.rpc.apiKey` is a credential for the PRIMARY endpoint only -- it used
 * to be attached to every endpoint returned here, including every fallback, which meant a fallback provider
 * (potentially a different company entirely) silently received the primary provider's API key on every request. A
 * fallback now gets no credential at all unless one is explicitly configured for THAT fallback, index-aligned via
 * `fallbackApiKeys` (empty/absent entries mean "no credential for this endpoint", never "reuse the primary's").
 */
export function rpcEndpoints(cfg: RpcCfg): ProviderEndpoint[] {
  const r = cfg.providers.rpc;
  return [endpointWithOwnCredential(cfg.rpc.httpUrl, r.apiKey), ...fallbackEndpoints(r.fallbackUrls, r.fallbackApiKeys)];
}

/** Same isolation rule as `rpcEndpoints`, for the quote (Jupiter) gate's primary + configured fallbacks. */
export function quoteEndpoints(cfg: Pick<AppConfig, 'aggregators' | 'providers'>): ProviderEndpoint[] {
  const q = cfg.providers.quote;
  return [endpointWithOwnCredential(cfg.aggregators.jupiterQuoteBaseUrl, q.apiKey), ...fallbackEndpoints(q.fallbackUrls, q.fallbackApiKeys)];
}

function endpointWithOwnCredential(baseUrl: string, apiKey: string | undefined): ProviderEndpoint {
  return apiKey ? { baseUrl, headers: { 'x-api-key': apiKey } } : { baseUrl };
}

function fallbackEndpoints(urls: readonly string[], apiKeys: readonly string[]): ProviderEndpoint[] {
  return urls.map((baseUrl, i) => endpointWithOwnCredential(baseUrl, apiKeys[i] || undefined));
}

function gateRequestFromInit(init?: { body?: unknown; headers?: unknown }): { method: 'POST'; body?: string; headers: Record<string, string>; rpcMethod?: string } {
  const body = typeof init?.body === 'string' ? init.body : undefined;
  let rpcMethod: string | undefined;
  try {
    const parsed = body ? (JSON.parse(body) as { method?: string } | Array<{ method?: string }>) : undefined;
    rpcMethod = Array.isArray(parsed) ? parsed[0]?.method : parsed?.method;
  } catch {
    // not JSON: no method-level tracking
  }
  return { method: 'POST', ...(body !== undefined ? { body } : {}), headers: { 'content-type': 'application/json' }, ...(rpcMethod ? { rpcMethod } : {}) };
}

function gateResponseToFetchResponse(res: GateResponse): Response {
  return new Response(res.body, { status: res.status, headers: res.headers });
}

/** A `fetch` for web3.js that sends every JSON-RPC HTTP call through the gate (limits, retries, fallback, shutdown). */
export function gateFetch(gate: ProviderGate): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    void input; // the URL is chosen by the gate (primary, then fallbacks); web3.js only knows the primary
    const res = await gate.execute(gateRequestFromInit(init));
    return gateResponseToFetchResponse(res);
  }) as unknown as typeof fetch;
}

/**
 * Same as `gateFetch`, but every logical request first passes through a shared `PriorityAdmissionGate` (the
 * shared-RPC-capacity fix, `investigate/shared-rpc-capacity`) before it ever reaches `gate.execute()`. `gate`
 * itself -- its rate limit, concurrency bound, retries, circuit breaker -- is completely unchanged; this only
 * decides ORDERING among callers contending for `gate`'s own `maxConcurrent` admission slots, always promoting a
 * waiting 'high' (evaluation) caller ahead of a waiting 'low' (discovery) caller. See `priorityAdmissionGate.ts`
 * for why this is safe from starvation and unbounded queueing.
 */
export function priorityGateFetch(gate: ProviderGate, admission: PriorityAdmissionGate, priority: AdmissionPriority): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    void input;
    const res = await admission.run(priority, () => gate.execute(gateRequestFromInit(init)));
    return gateResponseToFetchResponse(res);
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
  for (const k of cfg.providers.rpc.fallbackApiKeys) registerSecret(k);
  for (const k of cfg.providers.quote.fallbackApiKeys) registerSecret(k);

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
  // Shared-RPC-capacity fix (`investigate/shared-rpc-capacity`, Option A): evaluation and discovery both call
  // `rpcGate.execute()` (directly or via `connection`'s fetch), and `rpcGate`'s own FIFO queue has no concept of
  // caller identity -- under sustained combined load, discovery's contention could starve evaluation even after
  // discovery's own offered rate was independently bounded (PR #6). `rpcAdmission` sits above `rpcGate`
  // (completely unmodified) and always promotes a waiting evaluation ('high') caller ahead of a waiting discovery
  // ('low') caller. Sized to `rpcGate`'s own `maxConcurrent`: no new capacity pool, no change to
  // maxRequestsPerSecond/timeoutMs/maxTotalMs/maxConcurrent -- this only reorders who gets to attempt
  // `rpcGate.execute()` next when more callers are ready than `rpcGate` can admit at once.
  const rpcAdmission = new PriorityAdmissionGate(r.maxConcurrent);
  // `connection`: used for discovery's WS log subscriptions (`onLogs`, unaffected -- `fetch` plays no part in
  // that) AND discovery's own `getParsedTransaction` HTTP calls, both 'low' priority.
  const connection = new Connection(cfg.rpc.httpUrl, { wsEndpoint: cfg.rpc.wsUrl, commitment: 'confirmed', fetch: priorityGateFetch(rpcGate, rpcAdmission, 'low'), disableRetryOnRateLimit: true });
  // `evaluationConnection`: HTTP-only (never subscribes -- web3.js's WebSocket client is constructed with
  // `autoconnect: false` and only ever connects when a subscribe method is called, so this never opens a second
  // socket to the RPC provider), used solely by `DirectSafetyDataSource`'s evaluation-time RPC calls, 'high' priority.
  const evaluationConnection = new Connection(cfg.rpc.httpUrl, { commitment: 'confirmed', fetch: priorityGateFetch(rpcGate, rpcAdmission, 'high'), disableRetryOnRateLimit: true });
  const jupiter = new JupiterQuoteClient({ jupiterQuoteBaseUrl: cfg.aggregators.jupiterQuoteBaseUrl, requestTimeoutMs: q.timeoutMs }, logger, { gate: quoteGate, metrics, cacheTtlMs: q.cacheTtlMs });
  const direct = new DirectSafetyDataSource(evaluationConnection);
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
      // Admission first: any caller still WAITING for a ticket (never reached `rpcGate.execute()`) is rejected
      // cleanly here rather than left waiting on a gate that's about to refuse everything anyway.
      rpcAdmission.shutdown();
      rpcGate.shutdown();
      quoteGate.shutdown();
    },
  };
}

export { ProviderError };
