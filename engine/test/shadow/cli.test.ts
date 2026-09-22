import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../../src/shadow/cli.js';
import { openLedger } from '../../src/ledger/db.js';
import { ShadowLedger } from '../../src/shadow/shadowLedger.js';
import { ShadowRunner } from '../../src/shadow/shadowRunner.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_CONFIG, entryEligibleTick } from './fixtures.js';

describe('shadow status CLI', () => {
  it('parses repeated --strategy-version flags', () => {
    expect(parseArgs(['--db', 'x.sqlite', '--strategy-version', 'V1', '--strategy-version', 'V2'])).toEqual({
      dbPath: 'x.sqlite',
      strategyVersions: ['V1', 'V2'],
    });
  });

  it('requires --db and at least one strategy version, and rejects unknown flags', () => {
    expect(() => parseArgs(['--strategy-version', 'V1'])).toThrow('--db is required');
    expect(() => parseArgs(['--db', 'x'])).toThrow('at least one --strategy-version');
    expect(() => parseArgs(['--db', 'x', '--strategy-version', 'V1', '--bogus'])).toThrow('Unknown argument');
  });

  describe('end to end against a real ledger file', () => {
    let dir: string;
    let originalArgv: string[];
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'scalp-shadow-cli-'));
      originalArgv = process.argv;
    });
    afterEach(() => {
      process.argv = originalArgv;
      vi.restoreAllMocks();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: main() keeps its own sqlite handle open on Windows
      }
    });

    it('prints a read-only JSON status report', () => {
      const dbPath = join(dir, 'ledger.sqlite');
      const db = openLedger(dbPath);
      const runner = new ShadowRunner({ ledger: new ShadowLedger(db), strategies: [{ strategyVersion: 'V1', config: DEFAULT_CONFIG }], assumptions: DEFAULT_ASSUMPTIONS });
      runner.onMarketTick(entryEligibleTick({ observedAtMs: 40_000 }));
      db.close();

      process.argv = [process.argv[0]!, process.argv[1]!, '--db', dbPath, '--strategy-version', 'V1'];
      const writes: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
      main();
      const report = JSON.parse(writes.join(''));
      expect(report.strategies[0].strategyVersion).toBe('V1');
      expect(report.strategies[0].openPositions).toBe(1);
    });
  });
});
