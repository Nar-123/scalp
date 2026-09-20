import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/config/schema.js';
import { getDefaultConfig, MINIMAL_CONFIG_INPUT } from '../../src/config/defaults.js';

describe('ConfigSchema', () => {
  it('parses a minimal valid input and applies defaults', () => {
    const cfg = getDefaultConfig();
    expect(cfg.dryRun).toBe(true);
    expect(cfg.strategyVersion).toBe('baseline-v1');
    expect(cfg.filters.minLiquiditySol).toBe(20);
    expect(cfg.exits.maxHoldTimeSec).toBe(30);
  });

  it('rejects a missing rpc.httpUrl', () => {
    const result = ConfigSchema.safeParse({ rpc: { wsUrl: 'wss://example.com' } });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed rpc.httpUrl', () => {
    const result = ConfigSchema.safeParse({
      rpc: { httpUrl: 'not-a-url', wsUrl: MINIMAL_CONFIG_INPUT.rpc.wsUrl },
    });
    expect(result.success).toBe(false);
  });

  it('allows overriding individual tunables while keeping other defaults', () => {
    const cfg = getDefaultConfig({ filters: { minLiquiditySol: 50 } });
    expect(cfg.filters.minLiquiditySol).toBe(50);
    expect(cfg.filters.minVolume1mSol).toBe(5);
  });
});
