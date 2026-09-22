import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectBaselineFilterFailures } from '../../src/orchestrator/baselineFilters.js';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { loadConfig } from '../../src/config/loader.js';
import { assertHardRiskUnmodified, HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';

const SRC = join(__dirname, '..', '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

describe('security: the native volume path is read-only', () => {
  const volumeFiles = files(join(SRC, 'volume'));
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('src/volume has files to check', () => {
    expect(volumeFiles.length).toBeGreaterThanOrEqual(9);
  });

  it('never imports the signer, keypair, wallet or execution modules', () => {
    for (const f of volumeFiles) {
      const code = stripComments(readFileSync(f, 'utf8'));
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      for (const spec of imports) {
        expect(spec, `${f} imports ${spec}`).not.toMatch(/execution|signer|keypair|wallet|secret/i);
      }
    }
  });

  it('contains no signing, sending, broadcasting, simulation or swap-building calls', () => {
    const forbidden = /(signTransaction|sendTransaction|sendRawTransaction|sendAndConfirm|simulateTransaction|Keypair|secretKey|getAccountInfo|getParsedTransaction|getTransaction|getSignaturesForAddress|fetch\(|undici)/;
    for (const f of volumeFiles) {
      expect(stripComments(readFileSync(f, 'utf8')), f).not.toMatch(forbidden);
    }
  });

  it('Phase 5.5 additions in the orchestrator (source policy, native-first wrappers) are read-only getters: no signer, wallet, sending or account reads', () => {
    for (const f of ['orchestrator/marketSourcePolicy.ts', 'orchestrator/nativeFirst.ts']) {
      const code = stripComments(readFileSync(join(SRC, f), 'utf8'));
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      for (const spec of imports) expect(spec, `${f} imports ${spec}`).not.toMatch(/signer|keypair|wallet|secret|dryRunExecutor|liveExecutor/i);
      expect(code, f).not.toMatch(/(signTransaction|sendTransaction|sendRawTransaction|simulateTransaction|Keypair|getAccountInfo|getParsedTransaction)/);
    }
  });

  it('the account decoder only decodes bytes it is given (no RPC, no connection)', () => {
    const code = stripComments(readFileSync(join(SRC, 'volume', 'bondingCurveAccount.ts'), 'utf8'));
    expect(code).not.toMatch(/Connection|getAccountInfo|getMultipleAccounts|fetch\(/);
  });

  it('performs no RPC request of its own (no Connection method is called anywhere in src/volume except the private websocket hook)', () => {
    for (const f of volumeFiles) {
      const code = stripComments(readFileSync(f, 'utf8'));
      expect(code, f).not.toMatch(/connection\.(get|send|simulate|request)[A-Za-z]*\(/);
    }
  });
});

describe('V1 strategy and hard risk are unchanged by Phase 5.4B', () => {
  it('filter thresholds: volume1mSol >= 5, volumeAccelerationX >= 1.5, and nothing else moved', () => {
    const cfg = getDefaultConfig();
    expect(cfg.filters).toEqual({ minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 });
    expect(cfg.exits.maxHoldTimeSec).toBe(30);
    expect(cfg.strategyVersion).toBe('baseline-v1');
    expect(cfg.dryRun).toBe(true);
    expect(cfg.execution.liveTradingExplicitlyEnabled).toBe(false);
  });

  it('the filter comparison itself is unchanged (>= 5 passes, just below fails; >= 1.5x passes, just below fails; +Infinity passes)', () => {
    const cfg = getDefaultConfig();
    const base = { liquiditySol: 25, buySellRatio: 3 };
    const run = (vol: number | null, accel: number | null) => collectBaselineFilterFailures({ ...base, volume1mSol: vol }, 5, accel, 0.1, cfg);
    expect(run(5, 1.5)).toEqual([]);
    expect(run(4.999999, 1.5)).toEqual(['volume_below_minimum']);
    expect(run(5, 1.499999)).toEqual(['volume_acceleration_below_minimum']);
    expect(run(5, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(run(null, null)).toEqual(['volume_1m_unavailable', 'volume_acceleration_unavailable']);
  });

  it('hard risk parameters are frozen at the V1 values', () => {
    expect(() => assertHardRiskUnmodified()).not.toThrow();
    expect(HARD_RISK_PARAMETERS).toMatchObject({ positionSizeSol: 0.3, dailyLossLimitPct: 10, maxReentriesPerToken: 5 });
    expect(Object.isFrozen(HARD_RISK_PARAMETERS)).toBe(true);
  });

  it('the new volume config only toggles the data source; it cannot reach any strategy or risk field', () => {
    const cfg = loadConfig({ PUMPFUN_NATIVE_VOLUME_ENABLED: 'false', PUMPFUN_RECORD_TRADE_EVENTS: 'false' } as never);
    expect(cfg.volume).toMatchObject({ pumpfunNativeEnabled: false, recordTradeEvents: false });
    expect(cfg.filters.minVolume1mSol).toBe(5);
    expect(cfg.filters.minVolumeAccelerationX).toBe(1.5);
    expect(getDefaultConfig().volume.pumpfunNativeEnabled).toBe(true);
  });
});
