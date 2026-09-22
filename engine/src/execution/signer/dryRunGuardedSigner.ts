import type { VersionedTransaction } from '@solana/web3.js';
import type { Signer } from './types.js';

export class LiveSigningNotPermittedError extends Error {}

export interface DryRunGuardConfig {
  dryRun: boolean;
  /**
   * A second, independent switch that must ALSO be true before signing is
   * permitted -- DRY_RUN=false alone is not enough. This is the "live
   * signing must require explicit configuration" requirement: live mode is
   * never inferred from DRY_RUN=false alone, and never from the mere
   * existence of a wallet credential.
   */
  liveTradingExplicitlyEnabled: boolean;
}

/**
 * Wraps any Signer and enforces, independently of whatever the caller
 * intended: if DRY_RUN=true, signTransaction always throws, even if a real
 * credential is loaded and available. If DRY_RUN=false, signTransaction
 * additionally requires `liveTradingExplicitlyEnabled`. This is
 * defense-in-depth -- the orchestrator is not expected to ever construct a
 * real Signer while DRY_RUN=true in the first place (see src/index.ts's own
 * startup refusal), but this guard means even a future bug that did so
 * still cannot broadcast a real transaction.
 *
 * getPublicKey() is NOT gated: reading a public key is not a signing or
 * broadcast action, and is useful for read-only diagnostics (checking a
 * configured wallet's balance, say) before ever going live.
 */
export class DryRunGuardedSigner implements Signer {
  constructor(
    private readonly inner: Signer,
    private readonly cfg: DryRunGuardConfig,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async getPublicKey(): Promise<string> {
    return this.inner.getPublicKey();
  }

  async signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    if (this.cfg.dryRun) {
      throw new LiveSigningNotPermittedError(
        'Refusing to sign: DRY_RUN=true. No real transaction may be signed or broadcast while DRY_RUN is true, even though a wallet credential exists.',
      );
    }
    if (!this.cfg.liveTradingExplicitlyEnabled) {
      throw new LiveSigningNotPermittedError(
        'Refusing to sign: live trading requires execution.liveTradingExplicitlyEnabled=true in addition to DRY_RUN=false. Live mode is never inferred from DRY_RUN=false alone, or from the presence of a wallet credential.',
      );
    }
    return this.inner.signTransaction(tx);
  }
}
