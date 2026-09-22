import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsDpapiSecretProvider } from '../../../src/execution/signer/windowsDpapiSecretProvider.js';

// DPAPI is Windows-only. On any other platform these are skipped rather
// than faked, since the whole point is exercising the real OS mechanism.
/**
 * Why this is not 20s: every DPAPI operation here spawns a fresh
 * powershell.exe, and on this machine a bare `powershell -NoProfile -Command 1`
 * takes ~8s to START (measured: cmd.exe spawn 0.1s; PowerShell no-op 7.8-8.0s;
 * the actual DPAPI protect/unprotect adds <1s). A protect + retrieve
 * round-trip is therefore two ~8s process starts (~16-19s in isolation),
 * which sat right at the old 20s limit and tipped over whenever the full
 * suite loaded the machine. The DPAPI implementation and test parallelism
 * were not the cause; the timeout simply did not budget for measured
 * subprocess startup cost. 90s = 2 spawns x ~15s (loaded) x 3 margin.
 * The test is unchanged otherwise -- it still exercises real DPAPI.
 */
const POWERSHELL_ROUND_TRIP_TIMEOUT_MS = 90_000;

const describeWindowsOnly = process.platform === 'win32' ? describe : describe.skip;

describeWindowsOnly('WindowsDpapiSecretProvider (real DPAPI round-trip, Windows only)', () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports unavailable when no protected file exists yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-dpapi-'));
    const provider = new WindowsDpapiSecretProvider(join(dir, 'missing.dpapi'));
    expect(await provider.isAvailable()).toBe(false);
  });

  it('throws (never returns a value) when getSecretBase58 is called with no protected file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-dpapi-'));
    const provider = new WindowsDpapiSecretProvider(join(dir, 'missing.dpapi'));
    await expect(provider.getSecretBase58()).rejects.toThrow();
  });

  it('round-trips a TEST value through real DPAPI protect + retrieve', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-dpapi-'));
    const filePath = join(dir, 'test.dpapi');
    const testValue = 'THIS-IS-A-TEST-VALUE-NOT-A-REAL-KEY-1234567890';

    await WindowsDpapiSecretProvider.protectAndStore(testValue, filePath);
    expect(existsSync(filePath)).toBe(true);

    const provider = new WindowsDpapiSecretProvider(filePath);
    expect(await provider.isAvailable()).toBe(true);
    const retrieved = await provider.getSecretBase58();
    expect(retrieved).toBe(testValue);
  }, POWERSHELL_ROUND_TRIP_TIMEOUT_MS);

  it('the on-disk protected file never contains the plaintext test value', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-dpapi-'));
    const filePath = join(dir, 'test2.dpapi');
    const testValue = 'ANOTHER-TEST-VALUE-DO-NOT-USE-IN-PRODUCTION';

    await WindowsDpapiSecretProvider.protectAndStore(testValue, filePath);

    const fs = await import('node:fs');
    const onDisk = fs.readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain(testValue);
  }, POWERSHELL_ROUND_TRIP_TIMEOUT_MS);

  it('rejects with an error (does not throw the plaintext) when the protected file is corrupted', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-dpapi-'));
    const filePath = join(dir, 'corrupt.dpapi');
    const fs = await import('node:fs');
    fs.writeFileSync(filePath, 'not-a-real-dpapi-blob');

    const provider = new WindowsDpapiSecretProvider(filePath);
    await expect(provider.getSecretBase58()).rejects.toThrow();
  }, POWERSHELL_ROUND_TRIP_TIMEOUT_MS);
});
