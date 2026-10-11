import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';
import { ConfigSchema } from '../../src/config/schema.js';
import { getDefaultConfig } from '../../src/config/defaults.js';

/** Stage 2: SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE defaults to false, parses strictly, and a bad value is rejected (never defaulted). */

const REQUIRED = { SOLANA_RPC_URL: 'https://rpc.example', SOLANA_RPC_WS_URL: 'wss://rpc.example' };
const env = (o: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...REQUIRED, ...o }) as NodeJS.ProcessEnv;

describe('providers.skipQuoteWhenVolumeUnavailable / SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE', () => {
  it('defaults to false in the schema, the default config and an env without the variable', () => {
    expect(ConfigSchema.parse({ rpc: { httpUrl: 'https://rpc.example', wsUrl: 'wss://rpc.example' } }).providers.skipQuoteWhenVolumeUnavailable).toBe(false);
    expect(getDefaultConfig().providers.skipQuoteWhenVolumeUnavailable).toBe(false);
    expect(loadConfig(env()).providers.skipQuoteWhenVolumeUnavailable).toBe(false);
  });

  it('a blank value is "not set" (default false)', () => {
    expect(loadConfig(env({ SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE: '' })).providers.skipQuoteWhenVolumeUnavailable).toBe(false);
    expect(loadConfig(env({ SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE: '   ' })).providers.skipQuoteWhenVolumeUnavailable).toBe(false);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['True', true],
    [' true ', true],
    ['false', false],
    ['FALSE', false],
  ])('accepts %j', (raw, expected) => {
    expect(loadConfig(env({ SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE: raw })).providers.skipQuoteWhenVolumeUnavailable).toBe(expected);
  });

  it.each(['yes', 'no', '1', '0', 'on', 'off', 'ture', 'enabled', 'truee', 'null', '2'])('rejects %j (never silently false)', (raw) => {
    expect(() => loadConfig(env({ SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE: raw }))).toThrow(/SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE/);
  });

  it('the schema itself rejects a non-boolean value', () => {
    expect(() => getDefaultConfig({ providers: { skipQuoteWhenVolumeUnavailable: 'yes' } })).toThrow();
    expect(getDefaultConfig({ providers: { skipQuoteWhenVolumeUnavailable: true } }).providers.skipQuoteWhenVolumeUnavailable).toBe(true);
  });

  it('turning it on changes nothing else in the configuration', () => {
    const off = loadConfig(env());
    const on = loadConfig(env({ SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE: 'true' }));
    expect({ ...on, providers: { ...on.providers, skipQuoteWhenVolumeUnavailable: false } }).toEqual(off);
  });
});
