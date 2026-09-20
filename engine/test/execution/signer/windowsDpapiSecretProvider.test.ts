import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsDpapiSecretProvider } from '../../../src/execution/signer/windowsDpapiSecretProvider.js';

// DPAPI is Windows-only. On any other platform these are skipped rather
// than faked, since the whole point is exercising the real OS mechanism.
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
  }, 20_000);

  it('the on-disk protected file never contains the plaintext test value', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-dpapi-'));
    const filePath = join(dir, 'test2.dpapi');
    const testValue = 'ANOTHER-TEST-VALUE-DO-NOT-USE-IN-PRODUCTION';

    await WindowsDpapiSecretProvider.protectAndStore(testValue, filePath);

    const fs = await import('node:fs');
    const onDisk = fs.readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain(testValue);
  }, 20_000);

  it('rejects with an error (does not throw the plaintext) when the protected file is corrupted', async () => {
    dir = mkdtempSync(join(tmpdir(), 'scalp-dpapi-'));
    const filePath = join(dir, 'corrupt.dpapi');
    const fs = await import('node:fs');
    fs.writeFileSync(filePath, 'not-a-real-dpapi-blob');

    const provider = new WindowsDpapiSecretProvider(filePath);
    await expect(provider.getSecretBase58()).rejects.toThrow();
  }, 20_000);
});
