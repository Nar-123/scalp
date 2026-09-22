import type { OpenPositionSummary } from '../risk/types.js';

/**
 * Per-token in-flight guard for the evaluation loop.
 *
 * The loop starts a new evaluation for every watched token every 2 s and never waited for the previous one. Whenever an
 * evaluation takes longer than the tick (the safety gate waits on rate-limited providers), the SAME token could pass twice
 * and open two positions before either was recorded (measured: 4 identical trades for 2 tokens). This guard makes that
 * impossible by construction:
 *
 *  - `tryAcquire(mint)` is synchronous. JavaScript runs one task at a time, so two ticks can never both acquire: the check
 *    and the claim happen with no `await` in between. It is called BEFORE any asynchronous work of the evaluation starts.
 *  - Different tokens hold independent leases: nothing here serialises evaluations across tokens.
 *  - A lease is released by its holder in a `finally`, so success, rejection, quote failure, exception and shutdown all
 *    release it.
 *  - A lease older than `timeoutMs` is considered stuck (a provider call that never settles). The next tick takes it over
 *    with a NEW lease and the old holder becomes stale: `isCurrent(oldLease)` is false, so when it eventually resumes it
 *    cannot commit an entry, and its own `release` does not disturb the new holder.
 */

export interface EvaluationLease {
  readonly mint: string;
  readonly id: number;
}

export interface AcquireResult {
  lease: EvaluationLease;
  /** true when this acquisition replaced a stuck (timed-out) lease. */
  tookOverStale: boolean;
}

export class EvaluationGuard {
  private readonly held = new Map<string, { id: number; startedAtMs: number }>();
  private seq = 0;
  skipped = 0;
  takeovers = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(timeoutMs > 0)) throw new Error('EvaluationGuard timeoutMs must be positive');
  }

  /** Synchronous. Returns null when this token already has a live evaluation (the caller skips the tick). */
  tryAcquire(mint: string): AcquireResult | null {
    const t = this.now();
    const cur = this.held.get(mint);
    let tookOverStale = false;
    if (cur) {
      if (t - cur.startedAtMs < this.timeoutMs) {
        this.skipped += 1;
        return null;
      }
      tookOverStale = true;
      this.takeovers += 1;
    }
    this.seq += 1;
    this.held.set(mint, { id: this.seq, startedAtMs: t });
    return { lease: { mint, id: this.seq }, tookOverStale };
  }

  /** true while `lease` is the live holder for its token (false after release or after a stale takeover). */
  isCurrent(lease: EvaluationLease): boolean {
    return this.held.get(lease.mint)?.id === lease.id;
  }

  /** Releases only if `lease` is still the holder: a stale holder finishing late never frees a newer lease. */
  release(lease: EvaluationLease): void {
    if (this.isCurrent(lease)) this.held.delete(lease.mint);
  }

  get inFlight(): number {
    return this.held.size;
  }

  has(mint: string): boolean {
    return this.held.has(mint);
  }
}

/**
 * Entry reservations: the window between "risk allows the entry" and "the position is visible in the ledger" contains an
 * `await` (the execution call). A reservation is made synchronously with the risk decision and released after the position
 * is recorded, and it
 *  (a) blocks a second entry for the same mint even if a stale evaluation resumes, and
 *  (b) counts toward the concurrent-position and exposure limits of OTHER tokens deciding in that window, so the existing
 *      limits (unchanged) hold under concurrency. It changes no limit, only what the limits are checked against.
 */
export class EntryReservations {
  private readonly pending = new Map<string, number>();

  has(mint: string): boolean {
    return this.pending.has(mint);
  }

  /** Synchronous; false when this mint already has an entry in flight. */
  reserve(mint: string, sizeSol: number): boolean {
    if (this.pending.has(mint)) return false;
    this.pending.set(mint, sizeSol);
    return true;
  }

  release(mint: string): void {
    this.pending.delete(mint);
  }

  asOpenPositions(): OpenPositionSummary[] {
    return [...this.pending.entries()].map(([mint, entrySizeSol]) => ({ tradeId: `pending_entry:${mint}`, mint, entrySizeSol }));
  }

  get size(): number {
    return this.pending.size;
  }
}
