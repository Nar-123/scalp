import { ConfigSchema, type AppConfig } from './schema.js';

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

function envNum(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    for (const key of Object.keys(obj as object)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Loads and validates the application config from environment variables.
 * Throws (fatal) on invalid/missing required values rather than silently
 * falling back, per the spec's "fail closed" posture. The returned object
 * is deep-frozen.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const input = {
    dryRun: env.DRY_RUN === undefined ? undefined : envBool(env.DRY_RUN, true),
    rpc: {
      httpUrl: env.SOLANA_RPC_URL || env.RPC_HTTP_URL || 'https://api.mainnet-beta.solana.com',
      wsUrl: env.SOLANA_RPC_WS_URL || env.RPC_WS_URL || 'wss://api.mainnet-beta.solana.com',
    },
    aggregators: {
      birdeyeApiKey: env.BIRDEYE_API_KEY || undefined,
      // Read-only quote endpoint override (e.g. https://lite-api.jup.ag/swap/v1). Quotes only; nothing here can execute a swap.
      jupiterQuoteBaseUrl: env.JUPITER_BASE_URL || env.JUPITER_QUOTE_BASE_URL || undefined,
    },
    safety: {
      // Phase 5.6E safeguards of the verified-vault holder policy (unset = OFF; no default policy value)
      // A set-but-unparseable value must fail validation loudly (NaN is rejected), never silently switch a safeguard off.
      minCirculatingSharePct: env.SAFETY_MIN_CIRCULATING_SHARE_PCT ? Number(env.SAFETY_MIN_CIRCULATING_SHARE_PCT) : undefined,
      minVisibleHolders: env.SAFETY_MIN_VISIBLE_HOLDERS ? Number(env.SAFETY_MIN_VISIBLE_HOLDERS) : undefined,
    },
    shadow: {
      enabled: env.SHADOW_TRADING_ENABLED === undefined ? undefined : envBool(env.SHADOW_TRADING_ENABLED, false),
    },
    execution: {
      liveTradingExplicitlyEnabled:
        env.LIVE_TRADING_EXPLICITLY_ENABLED === undefined
          ? undefined
          : envBool(env.LIVE_TRADING_EXPLICITLY_ENABLED, false),
      walletCredentialPath: env.WALLET_CREDENTIAL_PATH || undefined,
    },
    providers: {
      rpc: {
        apiKey: env.SOLANA_RPC_API_KEY || undefined,
        fallbackUrls: envList(env.SOLANA_RPC_FALLBACK_URLS),
        timeoutMs: envNum(env.SOLANA_RPC_TIMEOUT_MS),
        maxRequestsPerSecond: envNum(env.SOLANA_RPC_MAX_RPS),
        maxConcurrent: envNum(env.SOLANA_RPC_MAX_CONCURRENT),
        maxRetries: envNum(env.SOLANA_RPC_MAX_RETRIES),
      },
      quote: {
        apiKey: env.JUPITER_API_KEY || undefined,
        fallbackUrls: envList(env.JUPITER_FALLBACK_URLS),
        timeoutMs: envNum(env.JUPITER_TIMEOUT_MS),
        maxRequestsPerSecond: envNum(env.JUPITER_MAX_RPS),
        maxConcurrent: envNum(env.JUPITER_MAX_CONCURRENT),
        maxRetries: envNum(env.JUPITER_MAX_RETRIES),
        cacheTtlMs: envNum(env.JUPITER_QUOTE_CACHE_TTL_MS),
      },
    },
    volume: {
      pumpfunNativeEnabled: env.PUMPFUN_NATIVE_VOLUME_ENABLED === undefined ? undefined : envBool(env.PUMPFUN_NATIVE_VOLUME_ENABLED, true),
      recordTradeEvents: env.PUMPFUN_RECORD_TRADE_EVENTS === undefined ? undefined : envBool(env.PUMPFUN_RECORD_TRADE_EVENTS, true),
      tradeEventRetentionHours: envNum(env.PUMPFUN_TRADE_EVENT_RETENTION_HOURS),
      nativeMarketEnabled: env.PUMPFUN_NATIVE_MARKET_ENABLED === undefined ? undefined : envBool(env.PUMPFUN_NATIVE_MARKET_ENABLED, true),
      nativeMaxSnapshotSkewSec: envNum(env.PUMPFUN_NATIVE_MAX_SKEW_SEC),
      dexscreenerFallbackForCurveTokens: env.DEXSCREENER_FALLBACK_FOR_CURVE_TOKENS === undefined ? undefined : envBool(env.DEXSCREENER_FALLBACK_FOR_CURVE_TOKENS, false),
    },
    ledger: {
      dbPath: env.LEDGER_DB_PATH ?? undefined,
    },
    logging: {
      level: env.LOG_LEVEL ?? undefined,
    },
  };

  // JSON round-trip drops all `undefined` leaves so zod's own .default()
  // values apply for anything not explicitly set via env.
  const cleaned = JSON.parse(JSON.stringify(input));
  const parsed = ConfigSchema.parse(cleaned);
  return deepFreeze(parsed);
}

// Re-exported so callers touching env-derived numeric knobs elsewhere can
// reuse the same lenient parsing convention.
export { envBool, envNum };
