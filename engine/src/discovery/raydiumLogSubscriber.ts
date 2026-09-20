import { Connection, PublicKey, type Logs } from '@solana/web3.js';
import type { DiscoveredTokenEvent } from '../types/token.js';
import type { TokenDiscoverySource } from './types.js';
import type { Logger } from '../logging/logger.js';
import { detectRaydiumAmmV4PoolCreation, RAYDIUM_AMM_V4_PROGRAM_ID } from './creationDetector.js';

export interface RaydiumLogSubscriberOptions {
  programId: string;
  commitment?: 'confirmed' | 'finalized';
  /**
   * Raydium AMM V4 is a native, non-Anchor program: live sampling during
   * Phase 1.1 showed it logs almost nothing distinctive per-instruction
   * (mostly "Program log: Program ID: ...", "Number of accounts: N", and an
   * opaque base64 "ray_log" blob), so there is no reliable cheap log-text
   * pre-filter the way pump.fun has (an Anchor program that logs
   * "Instruction: <Name>"). Every log notification is therefore fetched and
   * checked at the instruction level, which is expensive against a
   * high-traffic program on a rate-limited public RPC -- this throttle caps
   * how many of those fetches run per second so the subscriber degrades
   * gracefully (missing some events) instead of getting rate-limited into
   * uselessness. Kept deliberately low by default (1/s): live validation in
   * Phase 1.1 found that even a 5/s Raydium throttle was enough to consume
   * most of the public RPC's shared rate-limit budget and starve the
   * higher-value pump.fun subscriber's own fetches on the same endpoint
   * (152 Raydium 429s vs. 3 pump.fun 429s in one 45s sample -- see
   * docs/PHASE_1_1_DISCOVERY_VALIDATION.md). Use a dedicated low-latency RPC
   * provider (with its own separate budget from pump.fun's) and raise this
   * in production.
   */
  maxFetchesPerSecond?: number;
}

const DEFAULT_MAX_FETCHES_PER_SECOND = 1;

export class RaydiumLogSubscriber implements TokenDiscoverySource {
  readonly name = 'raydium';
  private subscriptionId: number | null = null;
  private readonly programPubkey: PublicKey;
  private readonly maxFetchesPerSecond: number;
  private fetchesThisWindow = 0;
  private windowStartMs = Date.now();

  constructor(
    private readonly connection: Connection,
    private readonly options: RaydiumLogSubscriberOptions,
    private readonly logger?: Logger,
  ) {
    this.programPubkey = new PublicKey(options.programId);
    this.maxFetchesPerSecond = options.maxFetchesPerSecond ?? DEFAULT_MAX_FETCHES_PER_SECOND;
  }

  async start(onEvent: (event: DiscoveredTokenEvent) => void): Promise<void> {
    if (this.options.programId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
      this.logger?.warn(
        { configuredProgramId: this.options.programId, supportedProgramId: RAYDIUM_AMM_V4_PROGRAM_ID },
        'RaydiumLogSubscriber is configured with a program ID other than the supported Raydium AMM V4 -- ' +
          'creation detection will never fire for it (CPMM/CLMM/other Raydium programs are not supported; see docs/PHASE_1_1_1_RAYDIUM_HARDENING.md)',
      );
    }
    this.subscriptionId = this.connection.onLogs(
      this.programPubkey,
      (logs) => {
        void this.handleLogs(logs, onEvent);
      },
      this.options.commitment ?? 'confirmed',
    );
    this.logger?.info({ source: this.name, subscriptionId: this.subscriptionId }, 'discovery source started');
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  private allowFetch(): boolean {
    const now = Date.now();
    if (now - this.windowStartMs >= 1000) {
      this.windowStartMs = now;
      this.fetchesThisWindow = 0;
    }
    if (this.fetchesThisWindow >= this.maxFetchesPerSecond) return false;
    this.fetchesThisWindow += 1;
    return true;
  }

  private async handleLogs(logs: Logs, onEvent: (event: DiscoveredTokenEvent) => void): Promise<void> {
    try {
      if (logs.err) return;
      if (!this.allowFetch()) return;

      const tx = await this.connection.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      });
      if (!tx) return;

      const result = detectRaydiumAmmV4PoolCreation(tx, this.options.programId);
      if (!result.detected || !result.mint) return;

      const createdAtMs = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
      this.logger?.debug(
        { signature: logs.signature, mint: result.mint, pool: result.pool, evidence: result.evidence },
        'raydium pool creation confirmed',
      );
      onEvent({
        mint: result.mint,
        poolAddress: result.pool ?? null,
        source: 'raydium',
        createdAtSlot: tx.slot,
        createdAtMs,
        initialLiquiditySol: null,
      });
    } catch (err) {
      this.logger?.warn({ err: String(err), signature: logs.signature }, 'failed handling raydium log event');
    }
  }
}
