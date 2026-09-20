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
      httpUrl: env.RPC_HTTP_URL ?? 'https://api.mainnet-beta.solana.com',
      wsUrl: env.RPC_WS_URL ?? 'wss://api.mainnet-beta.solana.com',
    },
    aggregators: {
      birdeyeApiKey: env.BIRDEYE_API_KEY || undefined,
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
