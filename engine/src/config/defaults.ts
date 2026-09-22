import { ConfigSchema, type AppConfig } from './schema.js';

/**
 * Minimal input needed to satisfy required fields; everything else comes from
 * the zod schema's own .default() values. Useful for tests and for
 * documenting what a bare-minimum config looks like.
 */
export const MINIMAL_CONFIG_INPUT = {
  rpc: {
    httpUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
  },
};

export function getDefaultConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return ConfigSchema.parse({ ...MINIMAL_CONFIG_INPUT, ...overrides });
}
