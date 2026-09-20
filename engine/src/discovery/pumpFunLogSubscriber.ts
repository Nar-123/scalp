import { Connection, PublicKey, type Logs } from '@solana/web3.js';
import type { DiscoveredTokenEvent } from '../types/token.js';
import type { TokenDiscoverySource } from './types.js';
import type { Logger } from '../logging/logger.js';
import { ownLogsMatchAnyMarker } from './programLogs.js';
import { detectPumpFunCreation } from './creationDetector.js';

/**
 * Cheap PRE-FILTER only, applied to the free `onLogs` push before spending
 * an RPC call on the full transaction -- NOT the final evidence. The final
 * decision is `detectPumpFunCreation()` (instruction discriminator +
 * account-relationship check). Both "Create" and "CreateV2" are confirmed
 * real pump.fun instruction names (read from pump.fun's own on-chain Anchor
 * IDL during Phase 1.1); live traffic sampled during that pass showed
 * CreateV2 as the dominant creation path today, with legacy "Create" not
 * observed at all in that sample -- kept anyway since it's a real,
 * IDL-confirmed instruction, just not seen live. See
 * docs/PHASE_1_1_DISCOVERY_VALIDATION.md.
 */
const DEFAULT_PUMPFUN_CREATION_MARKERS = ['Instruction: Create', 'Instruction: CreateV2'];

export interface PumpFunLogSubscriberOptions {
  programId: string;
  creationLogMarkers?: string[];
  commitment?: 'confirmed' | 'finalized';
}

export class PumpFunLogSubscriber implements TokenDiscoverySource {
  readonly name = 'pumpfun';
  private subscriptionId: number | null = null;
  private readonly programPubkey: PublicKey;
  private readonly markers: string[];

  constructor(
    private readonly connection: Connection,
    private readonly options: PumpFunLogSubscriberOptions,
    private readonly logger?: Logger,
  ) {
    this.programPubkey = new PublicKey(options.programId);
    this.markers = options.creationLogMarkers ?? DEFAULT_PUMPFUN_CREATION_MARKERS;
  }

  async start(onEvent: (event: DiscoveredTokenEvent) => void): Promise<void> {
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

  private mightBeCreation(logs: Logs): boolean {
    if (logs.err) return false;
    return ownLogsMatchAnyMarker(logs.logs, this.options.programId, this.markers);
  }

  private async handleLogs(logs: Logs, onEvent: (event: DiscoveredTokenEvent) => void): Promise<void> {
    try {
      if (!this.mightBeCreation(logs)) return;

      const tx = await this.connection.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      });
      if (!tx) return;

      const result = detectPumpFunCreation(tx, this.options.programId);
      if (!result.detected || !result.mint) {
        this.logger?.debug(
          { signature: logs.signature },
          'pumpfun creation log matched but instruction-level evidence check rejected it',
        );
        return;
      }

      const createdAtMs = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
      this.logger?.debug({ signature: logs.signature, mint: result.mint, evidence: result.evidence }, 'pumpfun creation confirmed');
      onEvent({
        mint: result.mint,
        poolAddress: null,
        source: 'pumpfun',
        createdAtSlot: tx.slot,
        createdAtMs,
        initialLiquiditySol: null,
      });
    } catch (err) {
      this.logger?.warn({ err: String(err), signature: logs.signature }, 'failed handling pumpfun log event');
    }
  }
}
