import bs58 from 'bs58';
import { Keypair, type VersionedTransaction } from '@solana/web3.js';
import type { SecretProvider, Signer } from './types.js';

/**
 * A Signer backed by an in-memory Solana Keypair, sourced lazily from a
 * SecretProvider (e.g. WindowsDpapiSecretProvider). The decrypted secret is
 * used exactly once to construct the Keypair and is never retained,
 * returned, or logged beyond that.
 *
 * Uses real ECMAScript private fields (`#`), not TypeScript's `private`
 * keyword, deliberately: TS `private` is compile-time only and the
 * underlying field is still an ordinary enumerable JS property at runtime,
 * which means `JSON.stringify(signer)`, `console.log(signer)`, and
 * `util.inspect` would all walk into it. Verified empirically that
 * `@solana/web3.js`'s own `Keypair` serializes its raw secret key bytes
 * under `JSON.stringify` (its `_keypair.secretKey` field has no `toJSON`
 * guard) -- so if `keypair` here were a plain class field, any accidental
 * `logger.info(signerInstance)` or similar would risk leaking it. `#`
 * fields are invisible to all of the above by language design.
 *
 * This class alone is NOT safe to use for live trading -- it has no
 * DRY_RUN awareness at all. It must always be wrapped in
 * DryRunGuardedSigner before being handed to anything that calls
 * signTransaction, per this project's "never infer live mode from the
 * existence of a wallet key" rule.
 */
export class KeypairSigner implements Signer {
  #keypair: Keypair | null = null;
  readonly #secretProvider: SecretProvider;

  constructor(secretProvider: SecretProvider) {
    this.#secretProvider = secretProvider;
  }

  async isAvailable(): Promise<boolean> {
    return this.#secretProvider.isAvailable();
  }

  async getPublicKey(): Promise<string> {
    await this.#ensureLoaded();
    return this.#keypair!.publicKey.toBase58();
  }

  async signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    await this.#ensureLoaded();
    tx.sign([this.#keypair!]);
    return tx;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#keypair) return;
    // Note: the intermediate base58 string cannot be securely zeroed (JS
    // strings are immutable); this is a known limitation of doing crypto in
    // JS, not something this class can fully close. The derived byte array
    // is wiped below, and neither value is ever logged or returned.
    const secretBase58 = await this.#secretProvider.getSecretBase58();
    let secretBytes: Uint8Array;
    try {
      // bs58.decode() returns a Node Buffer, whose .slice() is overridden to
      // return a VIEW (not a copy) unlike plain Uint8Array.slice(). Verified
      // empirically that Keypair.fromSecretKey(buffer) then ends up sharing
      // memory with it, so the fill(0) wipe below silently corrupts the
      // live keypair's secret key. Forcing a real independent Uint8Array
      // copy here (not a Buffer) avoids that aliasing entirely.
      secretBytes = new Uint8Array(bs58.decode(secretBase58));
    } catch {
      throw new Error('Stored credential is not valid base58 -- refusing to construct a keypair from it.');
    }
    try {
      this.#keypair = Keypair.fromSecretKey(secretBytes);
    } catch {
      throw new Error('Stored credential is not a valid Solana secret key.');
    } finally {
      secretBytes.fill(0);
    }
  }
}
