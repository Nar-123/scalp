import type { VersionedTransaction } from '@solana/web3.js';
import type { Signer } from './types.js';

/**
 * Placeholder Signer used by LiveExecutorStub. It never has a real key and
 * always refuses to sign -- DRY_RUN mode never calls signTransaction at all,
 * and the real WalletSigner infrastructure (signer/keypairSigner.ts +
 * signer/windowsDpapiSecretProvider.ts) is not wired into the orchestrator
 * in this phase.
 */
export class NullSigner implements Signer {
  async getPublicKey(): Promise<string> {
    throw new Error('NullSigner has no key. Live signing is not implemented in this pass.');
  }

  async signTransaction(_tx: VersionedTransaction): Promise<VersionedTransaction> {
    throw new Error('NullSigner cannot sign. Live signing is not implemented in this pass.');
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
