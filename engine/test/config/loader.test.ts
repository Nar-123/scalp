import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';

/**
 * P1 fix #10: invalid numeric environment variables must fail closed. `envNum()` used to turn a malformed value
 * into `undefined`, which the JSON round-trip in `loadConfig` then drops entirely -- so `SOLANA_RPC_MAX_RPS=abc`
 * silently became the schema default (8) instead of a startup error, hiding a typo as if nothing were wrong.
 */

const REQUIRED = { SOLANA_RPC_URL: 'https://rpc.example', SOLANA_RPC_WS_URL: 'wss://rpc.example' };

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...REQUIRED, ...overrides } as NodeJS.ProcessEnv;
}

describe('loadConfig: numeric env vars fail closed on an invalid (present, non-blank) value', () => {
  it('absent -> the schema default applies', () => {
    const cfg = loadConfig(env());
    expect(cfg.providers.rpc.maxRequestsPerSecond).toBe(8);
    expect(cfg.providers.rpc.timeoutMs).toBe(4000);
  });

  it('valid -> the parsed value is used', () => {
    const cfg = loadConfig(env({ SOLANA_RPC_MAX_RPS: '25' }));
    expect(cfg.providers.rpc.maxRequestsPerSecond).toBe(25);
  });

  it('invalid (non-numeric) -> loadConfig throws, naming the exact variable', () => {
    expect(() => loadConfig(env({ SOLANA_RPC_MAX_RPS: 'abc' }))).toThrow(/SOLANA_RPC_MAX_RPS/);
  });

  it('invalid value does NOT silently fall back to the default -- it never even reaches zod', () => {
    let threw = false;
    try {
      loadConfig(env({ SOLANA_RPC_MAX_RPS: 'abc' }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // the old bug: this would have been false, with maxRequestsPerSecond silently = 8
  });

  it('empty string is explicitly treated as absent: default applies, no throw', () => {
    const cfg = loadConfig(env({ SOLANA_RPC_MAX_RPS: '' }));
    expect(cfg.providers.rpc.maxRequestsPerSecond).toBe(8);
  });

  it('whitespace-only is also treated as absent: default applies, no throw', () => {
    const cfg = loadConfig(env({ SOLANA_RPC_MAX_RPS: '   ' }));
    expect(cfg.providers.rpc.maxRequestsPerSecond).toBe(8);
  });

  it('the literal string "NaN" is invalid, not a number, and fails closed', () => {
    expect(() => loadConfig(env({ JUPITER_MAX_RETRIES: 'NaN' }))).toThrow(/JUPITER_MAX_RETRIES/);
  });

  it('"Infinity" is not a finite number and fails closed', () => {
    expect(() => loadConfig(env({ PUMPFUN_NATIVE_MAX_SKEW_SEC: 'Infinity' }))).toThrow(/PUMPFUN_NATIVE_MAX_SKEW_SEC/);
  });

  it('every numeric env var loadConfig reads is validated this way, not just one example', () => {
    const names = [
      'SOLANA_RPC_TIMEOUT_MS',
      'SOLANA_RPC_MAX_RPS',
      'SOLANA_RPC_MAX_CONCURRENT',
      'SOLANA_RPC_MAX_RETRIES',
      'JUPITER_TIMEOUT_MS',
      'JUPITER_MAX_RPS',
      'JUPITER_MAX_CONCURRENT',
      'JUPITER_MAX_RETRIES',
      'JUPITER_QUOTE_CACHE_TTL_MS',
      'PUMPFUN_TRADE_EVENT_RETENTION_HOURS',
      'PUMPFUN_NATIVE_MAX_SKEW_SEC',
    ];
    for (const name of names) {
      expect(() => loadConfig(env({ [name]: 'not-a-number' })), name).toThrow(new RegExp(name));
    }
  });

  it('a valid value for every numeric env var above is accepted and parsed correctly', () => {
    const cfg = loadConfig(
      env({
        SOLANA_RPC_TIMEOUT_MS: '5000',
        SOLANA_RPC_MAX_RPS: '12',
        SOLANA_RPC_MAX_CONCURRENT: '6',
        SOLANA_RPC_MAX_RETRIES: '3',
        JUPITER_TIMEOUT_MS: '6000',
        JUPITER_MAX_RPS: '7',
        JUPITER_MAX_CONCURRENT: '2',
        JUPITER_MAX_RETRIES: '1',
        JUPITER_QUOTE_CACHE_TTL_MS: '1500',
        PUMPFUN_TRADE_EVENT_RETENTION_HOURS: '48',
        PUMPFUN_NATIVE_MAX_SKEW_SEC: '90',
      }),
    );
    expect(cfg.providers.rpc.timeoutMs).toBe(5000);
    expect(cfg.providers.rpc.maxRequestsPerSecond).toBe(12);
    expect(cfg.providers.rpc.maxConcurrent).toBe(6);
    expect(cfg.providers.rpc.maxRetries).toBe(3);
    expect(cfg.providers.quote.timeoutMs).toBe(6000);
    expect(cfg.providers.quote.maxRequestsPerSecond).toBe(7);
    expect(cfg.providers.quote.maxConcurrent).toBe(2);
    expect(cfg.providers.quote.maxRetries).toBe(1);
    expect(cfg.providers.quote.cacheTtlMs).toBe(1500);
    expect(cfg.volume.tradeEventRetentionHours).toBe(48);
    expect(cfg.volume.nativeMaxSnapshotSkewSec).toBe(90);
  });

  it('the error message never leaks an unrelated secret from the environment', () => {
    let message = '';
    try {
      loadConfig(env({ SOLANA_RPC_MAX_RPS: 'abc', SOLANA_RPC_API_KEY: 'super-secret-key-value' }));
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('SOLANA_RPC_MAX_RPS');
    expect(message).not.toContain('super-secret-key-value');
  });

  it('a single invalid variable does not stop the config from correctly reporting WHICH one -- a second, unrelated invalid var is not blamed', () => {
    expect(() => loadConfig(env({ JUPITER_MAX_RPS: 'xyz' }))).toThrow(/JUPITER_MAX_RPS/);
    expect(() => loadConfig(env({ JUPITER_MAX_RPS: 'xyz' }))).not.toThrow(/SOLANA_RPC_MAX_RPS/);
  });
});
