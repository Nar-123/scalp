import { describe, expect, it, vi } from 'vitest';
import type { VersionedTransaction } from '@solana/web3.js';
import { DryRunGuardedSigner, LiveSigningNotPermittedError } from '../../../src/execution/signer/dryRunGuardedSigner.js';
import type { Signer } from '../../../src/execution/signer/types.js';

function fakeInnerSigner(overrides: Partial<Signer> = {}): Signer {
  return {
    getPublicKey: vi.fn().mockResolvedValue('SomePublicKey11111111111111111111111111111'),
    signTransaction: vi.fn().mockImplementation(async (tx: VersionedTransaction) => tx),
    isAvailable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const fakeTx = {} as VersionedTransaction;

describe('DryRunGuardedSigner -- DRY_RUN protection', () => {
  it('refuses to sign when DRY_RUN=true, even though a credential is available', async () => {
    const inner = fakeInnerSigner();
    const guarded = new DryRunGuardedSigner(inner, { dryRun: true, liveTradingExplicitlyEnabled: true });

    await expect(guarded.signTransaction(fakeTx)).rejects.toThrow(LiveSigningNotPermittedError);
    expect(inner.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses to sign when DRY_RUN=false but liveTradingExplicitlyEnabled=false (never infers live mode)', async () => {
    const inner = fakeInnerSigner();
    const guarded = new DryRunGuardedSigner(inner, { dryRun: false, liveTradingExplicitlyEnabled: false });

    await expect(guarded.signTransaction(fakeTx)).rejects.toThrow(LiveSigningNotPermittedError);
    expect(inner.signTransaction).not.toHaveBeenCalled();
  });

  it('only signs when BOTH dryRun=false AND liveTradingExplicitlyEnabled=true', async () => {
    const inner = fakeInnerSigner();
    const guarded = new DryRunGuardedSigner(inner, { dryRun: false, liveTradingExplicitlyEnabled: true });

    await guarded.signTransaction(fakeTx);
    expect(inner.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses even when the credential is available and DRY_RUN is true (existence of a key never overrides DRY_RUN)', async () => {
    const inner = fakeInnerSigner({ isAvailable: vi.fn().mockResolvedValue(true) });
    const guarded = new DryRunGuardedSigner(inner, { dryRun: true, liveTradingExplicitlyEnabled: true });

    expect(await guarded.isAvailable()).toBe(true); // availability check itself is fine
    await expect(guarded.signTransaction(fakeTx)).rejects.toThrow(LiveSigningNotPermittedError);
  });
});

describe('DryRunGuardedSigner -- read-only operations are not gated', () => {
  it('allows getPublicKey() regardless of DRY_RUN (not a signing/broadcast action)', async () => {
    const inner = fakeInnerSigner();
    const guardedDryRun = new DryRunGuardedSigner(inner, { dryRun: true, liveTradingExplicitlyEnabled: false });
    const guardedLive = new DryRunGuardedSigner(inner, { dryRun: false, liveTradingExplicitlyEnabled: true });

    await expect(guardedDryRun.getPublicKey()).resolves.toBe('SomePublicKey11111111111111111111111111111');
    await expect(guardedLive.getPublicKey()).resolves.toBe('SomePublicKey11111111111111111111111111111');
  });

  it('allows isAvailable() regardless of DRY_RUN', async () => {
    const inner = fakeInnerSigner({ isAvailable: vi.fn().mockResolvedValue(false) });
    const guarded = new DryRunGuardedSigner(inner, { dryRun: true, liveTradingExplicitlyEnabled: false });
    expect(await guarded.isAvailable()).toBe(false);
  });
});
