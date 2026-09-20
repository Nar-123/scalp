import type { VersionedTransaction } from '@solana/web3.js';

/**
 * Injected signing abstraction so the execution engine never hardcodes how a
 * key is sourced, and never reads private key material directly:
 *
 *   Trading Engine -> Execution Engine -> WalletSigner -> SecretProvider -> key
 *
 * Nothing above WalletSigner ever sees raw key bytes. `signTransaction`
 * returns a signed transaction object, never the key; `getPublicKey` is the
 * only identity-revealing method, and a public key is not secret.
 */
export interface Signer {
  getPublicKey(): Promise<string>;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
  /**
   * Cheap health/availability check -- can this signer currently produce a
   * signature (credential present, provider reachable) without actually
   * touching the secret. Used for startup diagnostics and pre-trade checks;
   * must never throw for "not available", only return false.
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Supplies raw secret key bytes (as a base58 string, matching Solana's
 * conventional secret-key encoding) to a Signer implementation. This is the
 * ONLY layer that ever touches plaintext key material, and only for the
 * instant it takes to hand it to `Keypair.fromSecretKey`. Implementations
 * must never log, print, or otherwise persist the returned value, and
 * callers must not retain a copy of it beyond constructing a Keypair.
 */
export interface SecretProvider {
  /** True if the underlying credential exists and looks retrievable, without decrypting it. */
  isAvailable(): Promise<boolean>;
  /** Retrieves and decrypts the secret. Throws if unavailable or decryption fails. Never logs the result. */
  getSecretBase58(): Promise<string>;
}
