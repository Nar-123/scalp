import type { VersionedTransaction } from '@solana/web3.js';

/**
 * Injected signing abstraction so the execution engine never hardcodes how a
 * key is sourced. The real implementation (Windows Credential Manager
 * backed) is deferred to a later pass; only NullSigner exists today.
 */
export interface Signer {
  getPublicKey(): Promise<string>;
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>;
}
