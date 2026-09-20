import type { VersionedTransaction } from '@solana/web3.js';
import type { Signer } from './types.js';

/**
 * Placeholder Signer used everywhere in this pass. It never has a real key
 * and always refuses to sign -- this is intentional: real signing is a
 * later pass (Windows Credential Manager), and DRY_RUN mode never calls
 * signTransaction at all.
 */
export class NullSigner implements Signer {
  async getPublicKey(): Promise<string> {
    throw new Error('NullSigner has no key. Live signing is not implemented in this pass.');
  }

  async signTransaction(_tx: VersionedTransaction): Promise<VersionedTransaction> {
    throw new Error('NullSigner cannot sign. Live signing is not implemented in this pass.');
  }
}
