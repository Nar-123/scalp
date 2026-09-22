import { Connection, PublicKey, type Logs } from '@solana/web3.js';
import { runBounded } from '../lifecycle/shutdown.js';
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

/** One raw `onLogs` notification, forwarded untouched to an observer (Phase 5.4B trade-event stream). */
export interface PumpFunLogTapEvent {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
  receivedAtMs: number;
}

export interface PumpFunLogSubscriberOptions {
  programId: string;
  /**
   * Optional observer of EVERY notification on this (single, shared) program
   * subscription -- creation or not, success or failure. It is how the native
   * trade-volume stream reuses this subscription instead of opening a second
   * one. Exceptions inside the tap are swallowed: it can never break discovery.
   */
  logTap?: (event: PumpFunLogTapEvent) => void;
  creationLogMarkers?: string[];
  commitment?: 'confirmed' | 'finalized';
  /** Upper bound on the RPC unsubscribe during stop() (default 3000 ms). */
  stopTimeoutMs?: number;
}

export class PumpFunLogSubscriber implements TokenDiscoverySource {
  readonly name = 'pumpfun';
  private subscriptionId: number | null = null;
  private stopped = false;
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
      (logs, ctx) => {
        const tap = this.options.logTap;
        if (tap) {
          try {
            // `err` is passed through untouched: undefined (unknown status) is discarded downstream, never assumed to be success.
            tap({ signature: logs.signature, slot: ctx.slot, err: logs.err, logs: logs.logs, receivedAtMs: Date.now() });
          } catch (err) {
            this.logger?.warn({ err: String(err) }, 'pumpfun log tap failed');
          }
        }
        void this.handleLogs(logs, onEvent);
      },
      this.options.commitment ?? 'confirmed',
    );
    this.logger?.info({ source: this.name, subscriptionId: this.subscriptionId }, 'discovery source started');
  }

  /**
   * Bounded: the RPC unsubscribe is best-effort. On a rate-limited or stalled websocket it can hang indefinitely
   * (measured in Phase 5.6), so it is raced against a timeout and never blocks shutdown. After stop() no new log is
   * processed, so no provider request is started once shutdown has begun.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const id = this.subscriptionId;
    this.subscriptionId = null;
    if (id !== null) {
      await runBounded(() => this.connection.removeOnLogsListener(id), this.options.stopTimeoutMs ?? 3000);
    }
  }

  private mightBeCreation(logs: Logs): boolean {
    if (logs.err) return false;
    return ownLogsMatchAnyMarker(logs.logs, this.options.programId, this.markers);
  }

  private async handleLogs(logs: Logs, onEvent: (event: DiscoveredTokenEvent) => void): Promise<void> {
    if (this.stopped) return;
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
        detectedAtMs: Date.now(),
      });
    } catch (err) {
      this.logger?.warn({ err: String(err), signature: logs.signature }, 'failed handling pumpfun log event');
    }
  }
}
