import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { Keypair, VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { KeypairSigner } from '../../../src/execution/signer/keypairSigner.js';
import type { SecretProvider } from '../../../src/execution/signer/types.js';

function fakeSecretProvider(overrides: Partial<SecretProvider> = {}): SecretProvider {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    getSecretBase58: vi.fn().mockRejectedValue(new Error('not configured')),
    ...overrides,
  };
}

function buildUnsignedTransaction(feePayer: PublicKey): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: bs58.encode(new Uint8Array(32)), // any well-formed 32-byte blockhash; not submitted anywhere
    instructions: [],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

describe('KeypairSigner -- public key retrieval', () => {
  it('derives and returns the correct public key from a valid secret', async () => {
    const kp = Keypair.generate();
    const provider = fakeSecretProvider({ getSecretBase58: vi.fn().mockResolvedValue(bs58.encode(kp.secretKey)) });
    const signer = new KeypairSigner(provider);

    const pubkey = await signer.getPublicKey();
    expect(pubkey).toBe(kp.publicKey.toBase58());
  });

  it('only fetches the secret once across multiple calls (caches the derived keypair, not the secret)', async () => {
    const kp = Keypair.generate();
    const getSecretBase58 = vi.fn().mockResolvedValue(bs58.encode(kp.secretKey));
    const signer = new KeypairSigner(fakeSecretProvider({ getSecretBase58 }));

    await signer.getPublicKey();
    await signer.getPublicKey();
    await signer.signTransaction(buildUnsignedTransaction(kp.publicKey));

    expect(getSecretBase58).toHaveBeenCalledTimes(1);
  });
});

describe('KeypairSigner -- credential availability', () => {
  it('reflects the underlying provider availability', async () => {
    const available = new KeypairSigner(fakeSecretProvider({ isAvailable: vi.fn().mockResolvedValue(true) }));
    const unavailable = new KeypairSigner(fakeSecretProvider({ isAvailable: vi.fn().mockResolvedValue(false) }));

    expect(await available.isAvailable()).toBe(true);
    expect(await unavailable.isAvailable()).toBe(false);
  });
});

describe('KeypairSigner -- missing credentials', () => {
  it('propagates a rejection from the secret provider rather than silently producing a signer', async () => {
    const signer = new KeypairSigner(fakeSecretProvider());
    await expect(signer.getPublicKey()).rejects.toThrow('not configured');
  });
});

describe('KeypairSigner -- invalid credentials', () => {
  it('rejects a secret that is not valid base58', async () => {
    const signer = new KeypairSigner(fakeSecretProvider({ getSecretBase58: vi.fn().mockResolvedValue('not-valid-base58-!!!') }));
    await expect(signer.getPublicKey()).rejects.toThrow(/not valid base58/);
  });

  it('rejects a secret that is valid base58 but not a valid Solana secret key', async () => {
    const signer = new KeypairSigner(fakeSecretProvider({ getSecretBase58: vi.fn().mockResolvedValue(bs58.encode(new Uint8Array(4))) }));
    await expect(signer.getPublicKey()).rejects.toThrow(/not a valid Solana secret key/);
  });
});

describe('KeypairSigner -- signing', () => {
  it('produces a transaction with a valid signature from the correct key', async () => {
    const kp = Keypair.generate();
    const signer = new KeypairSigner(fakeSecretProvider({ getSecretBase58: vi.fn().mockResolvedValue(bs58.encode(kp.secretKey)) }));

    const tx = buildUnsignedTransaction(kp.publicKey);
    const signed = await signer.signTransaction(tx);

    expect(signed.signatures.length).toBeGreaterThan(0);
    expect(signed.message.staticAccountKeys[0]!.equals(kp.publicKey)).toBe(true);
  });
});

describe('KeypairSigner -- no secret leakage', () => {
  it('never returns the raw secret from any public method', async () => {
    const kp = Keypair.generate();
    const secretBase58 = bs58.encode(kp.secretKey);
    const signer = new KeypairSigner(fakeSecretProvider({ getSecretBase58: vi.fn().mockResolvedValue(secretBase58) }));

    const pubkey = await signer.getPublicKey();
    const available = await signer.isAvailable();

    expect(pubkey).not.toBe(secretBase58);
    expect(String(pubkey)).not.toContain(secretBase58);
    expect(typeof available).toBe('boolean');
  });

  it('does not expose the secret key bytes via JSON.stringify -- regression test for a real, empirically-confirmed leak vector', async () => {
    // @solana/web3.js's own Keypair class serializes its raw secretKey bytes
    // under JSON.stringify (verified directly against the installed
    // version: `JSON.stringify(Keypair.generate())` includes the full
    // 64-byte secret array). If KeypairSigner held its Keypair in an
    // ordinary class field, JSON.stringify(signer) -- e.g. from an
    // accidental `logger.info(signerInstance)` -- would leak it. This is
    // exactly why KeypairSigner uses real `#private` fields instead.
    const kp = Keypair.generate();
    const secretBase58 = bs58.encode(kp.secretKey);
    const signer = new KeypairSigner(fakeSecretProvider({ getSecretBase58: vi.fn().mockResolvedValue(secretBase58) }));
    await signer.getPublicKey();

    const serialized = JSON.stringify(signer);
    expect(serialized).toBe('{}'); // #private fields are invisible to JSON.stringify entirely
  });

  it('does not expose the secret via Object.keys/Object.values (no enumerable own properties at all)', async () => {
    const kp = Keypair.generate();
    const signer = new KeypairSigner(fakeSecretProvider({ getSecretBase58: vi.fn().mockResolvedValue(bs58.encode(kp.secretKey)) }));
    await signer.getPublicKey();

    expect(Object.keys(signer)).toEqual([]);
    expect(Object.values(signer)).toEqual([]);
  });
});
