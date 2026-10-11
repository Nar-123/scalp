import { evaluationSlotContext, type EvaluationSlot } from '../providers/evaluationSlotContext.js';

/**
 * Global evaluation backpressure, ABOVE the existing per-token `EvaluationGuard` (Phase 5.6O, following the Phase
 * 5.6N investigation, `docs/PHASE_5_6N_PROVIDERGATE_SATURATION_INVESTIGATION.md`).
 *
 * Before this, every watched token's 2-second `setInterval` called `evaluateToken()` directly: hundreds of
 * independently-ticking timers could all try to enter the safety gate's RPC calls at once, with nothing above the
 * per-token guard to bound how many were ever in flight GLOBALLY. Individually each tick "did the right thing"
 * (fail closed on an unavailable provider), but collectively, offered load had no ceiling while ProviderGate's own
 * capacity does -- the result was an unbounded backlog of logical requests each waiting out its own 8 s deadline in
 * ProviderGate's FIFO waiter queue, which (per the reproduction in Phase 5.6N) collapses throughput toward zero
 * under sustained overload and cannot self-recover.
 *
 * This scheduler is a thin, synchronous gate in front of `evaluateToken()`:
 *
 *   watch tokens -> EvaluationScheduler.requestTick() -> (per-token EvaluationGuard, unchanged) -> evaluation
 *
 *  - At most `maxConcurrent` DISPATCHES hold a global slot at once, GLOBALLY, across every watched token.
 *  - Dispatch does NOT dedupe by mint: it is the existing, unchanged `EvaluationGuard` (`evaluateToken`'s own
 *    synchronous `guard.tryAcquire`) that decides whether a second concurrent tick for the SAME mint is rejected or
 *    takes over a stale lease -- exactly as it always did. A rejected duplicate returns almost instantly (a
 *    synchronous check, no provider call), so this never meaningfully spends a global slot. This is deliberate: an
 *    earlier version of this scheduler dropped a tick outright whenever its mint already had one dispatch in
 *    flight, which silently defeated `EvaluationGuard`'s stale-lease takeover (a token whose current evaluation is
 *    genuinely stuck must still be able to be re-tried) -- see `test/pipeline/entryRace.test.ts` test 5.
 *  - A tick that arrives while every global slot is taken is held as AT MOST ONE pending signal per token (a Map
 *    keyed by mint; a second tick for a still-pending token OVERWRITES the stored closure rather than adding a
 *    second entry -- `Map.set` on an existing key never changes its position in iteration order, so the token keeps
 *    its original place in the FIFO queue: no starvation, no growing list).
 *  - When a dispatch gives its slot back, exactly one waiter is promoted: first an evaluation that is resuming after
 *    a quote wait (see below), otherwise the OLDEST pending token, which runs with ITS LATEST closure -- so a token
 *    that was pending for several ticks evaluates on the CURRENT market state the moment it finally runs, never
 *    stale data from when it first queued.
 *  - `forget(mint)` drops any pending signal for a token that has aged out, so a token no longer watched can never
 *    consume a future slot.
 *  - `stop()` clears the pending set, lets every resuming evaluation continue (so shutdown never waits on a slot) and
 *    refuses new dispatches; already-active evaluations are left to finish on their own (each already bounded by the
 *    existing per-provider-call `maxTotalMs` and the per-token `EvaluationGuard`'s stale-lease takeover -- nothing
 *    here needs its own timeout).
 *
 * P1 -- a slot is for WORK, not for WAITING ON A RATE LIMIT. Each dispatch runs inside `evaluationSlotContext`, a
 * handle the quote gate wrapper (`providers/quoteStage.ts`) uses to `suspend()` (give the slot back) for exactly the
 * time an evaluation waits on the quote provider, and to `resume()` (queue for a slot again, FIFO, ahead of new
 * ticks) before the evaluation continues. Measured on the VPS: ~30 evaluations a minute waited ~8 s each on the
 * keyless Jupiter limit (0.5 req/s), which kept all 4 slots taken and stretched every token's 2 s tick to 12-26 s.
 * The invariants are unchanged: slots HELD never exceed `maxConcurrent`, and who may wait on the quote provider is
 * bounded by the quote stage itself (a hard cap + short FIFO + timeout), not by this class.
 */
export interface EvaluationSchedulerOptions {
  /** Maximum number of evaluation dispatches allowed to hold a global slot at once, across every watched token. */
  maxConcurrent: number;
}

export interface EvaluationSchedulerStats {
  /** gauges, now */
  active: number;
  suspended: number;
  pending: number;
  resumeQueue: number;
  /** high-water marks since construction */
  maxActive: number;
  maxSuspended: number;
  maxPending: number;
  maxResumeQueue: number;
  /** counters since construction */
  dispatched: number;
  suspends: number;
  resumes: number;
  resumeWaits: number;
  resumeWaitMsTotal: number;
  resumeWaitMsMax: number;
}

type SlotState = 'held' | 'suspended' | 'resuming' | 'done';

interface SlotRecord {
  mint: string;
  state: SlotState;
  handle: EvaluationSlot;
  resumePromise: Promise<void> | null;
  wake: (() => void) | null;
  waitStartedAt: number;
}

export class EvaluationScheduler {
  private active = 0;
  private suspended = 0;
  /** How many of the current dispatches belong to each mint (almost always 0 or 1; briefly 2 during a stale-lease takeover). */
  private readonly activeByMint = new Map<string, number>();
  /** Insertion-ordered: iteration order is FIFO by first-queued time, and re-setting an existing key never changes it. */
  private readonly pending = new Map<string, () => Promise<void>>();
  /** Evaluations done waiting on a provider and waiting for a global slot again; served before any pending tick. */
  private readonly resumeQueue: SlotRecord[] = [];
  private stopped = false;
  private readonly counters = {
    maxActive: 0,
    maxSuspended: 0,
    maxPending: 0,
    maxResumeQueue: 0,
    dispatched: 0,
    suspends: 0,
    resumes: 0,
    resumeWaits: 0,
    resumeWaitMsTotal: 0,
    resumeWaitMsMax: 0,
  };

  constructor(private readonly o: EvaluationSchedulerOptions) {
    if (!(o.maxConcurrent > 0)) throw new Error('EvaluationScheduler maxConcurrent must be positive');
  }

  /** Dispatches currently HOLDING a global slot (never exceeds maxConcurrent, except while shutting down). */
  get activeCount(): number {
    return this.active;
  }

  /** Dispatches that gave their slot back and are waiting on a provider (see the P1 note above). */
  get suspendedCount(): number {
    return this.suspended;
  }

  /** Tokens with a coalesced tick waiting for a free global slot. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** true while at least one dispatch for this mint is currently running (holding a slot or waiting on a provider). */
  isActive(mint: string): boolean {
    return (this.activeByMint.get(mint) ?? 0) > 0;
  }

  isPending(mint: string): boolean {
    return this.pending.has(mint);
  }

  stats(): EvaluationSchedulerStats {
    return {
      active: this.active,
      suspended: this.suspended,
      pending: this.pending.size,
      resumeQueue: this.resumeQueue.length,
      ...this.counters,
    };
  }

  /**
   * Synchronous. `run` is the evaluation closure for this tick (typically `() => evaluateToken(event)`), evaluated
   * against whatever the market state is at the moment it actually executes, not at the moment of this call.
   *
   *  - a global slot is free -> dispatches immediately (identical to calling `run()` directly, when the system is
   *    healthy; per-token exclusion/stale-takeover is entirely EvaluationGuard's job, unchanged).
   *  - no global slot is free -> the LATEST `run` is stored as this mint's one pending signal (coalesced).
   */
  requestTick(mint: string, run: () => Promise<void>): void {
    if (this.stopped) return;
    if (this.active < this.o.maxConcurrent) {
      this.dispatch(mint, run);
      return;
    }
    this.pending.set(mint, run);
    if (this.pending.size > this.counters.maxPending) this.counters.maxPending = this.pending.size;
  }

  /** Drops a pending signal for a token that is no longer watched (called from stopWatching). A no-op if it wasn't pending. */
  forget(mint: string): void {
    this.pending.delete(mint);
  }

  /**
   * Stops accepting new dispatches and drops every pending signal. Evaluations waiting for a slot to resume are let
   * through at once (they only have fail-closed bookkeeping left to do); already-active ones run to their own end.
   */
  stop(): void {
    this.stopped = true;
    this.pending.clear();
    for (const rec of this.resumeQueue.splice(0)) this.grant(rec);
  }

  private dispatch(mint: string, run: () => Promise<void>): void {
    this.active += 1;
    this.counters.dispatched += 1;
    if (this.active > this.counters.maxActive) this.counters.maxActive = this.active;
    this.activeByMint.set(mint, (this.activeByMint.get(mint) ?? 0) + 1);
    const rec: SlotRecord = { mint, state: 'held', handle: undefined as unknown as EvaluationSlot, resumePromise: null, wake: null, waitStartedAt: 0 };
    rec.handle = {
      key: mint,
      isLive: () => rec.state !== 'done',
      suspend: () => this.suspendSlot(rec),
      resume: () => this.resumeSlot(rec),
    };
    void evaluationSlotContext
      .run(rec.handle, run)
      .catch(() => undefined) // evaluateToken() already catches its own errors; this is belt-and-suspenders so a scheduler slot can never leak
      .finally(() => this.finish(rec));
  }

  private suspendSlot(rec: SlotRecord): void {
    if (rec.state !== 'held') return;
    rec.state = 'suspended';
    this.active -= 1;
    this.suspended += 1;
    this.counters.suspends += 1;
    if (this.suspended > this.counters.maxSuspended) this.counters.maxSuspended = this.suspended;
    this.promoteNext();
  }

  private resumeSlot(rec: SlotRecord): Promise<void> {
    if (rec.state === 'resuming' && rec.resumePromise) return rec.resumePromise;
    if (rec.state !== 'suspended') return Promise.resolve(); // never suspended, or already finished: nothing to wait for
    this.counters.resumes += 1;
    if (this.stopped || this.active < this.o.maxConcurrent) {
      this.grant(rec);
      return Promise.resolve();
    }
    rec.state = 'resuming';
    rec.waitStartedAt = performance.now();
    rec.resumePromise = new Promise<void>((resolve) => {
      rec.wake = resolve;
    });
    this.resumeQueue.push(rec);
    this.counters.resumeWaits += 1;
    if (this.resumeQueue.length > this.counters.maxResumeQueue) this.counters.maxResumeQueue = this.resumeQueue.length;
    return rec.resumePromise;
  }

  /** Hands a global slot to a suspended/resuming evaluation and lets it continue. */
  private grant(rec: SlotRecord): void {
    if (rec.state !== 'suspended' && rec.state !== 'resuming') return;
    if (rec.state === 'resuming') {
      const waited = performance.now() - rec.waitStartedAt;
      this.counters.resumeWaitMsTotal += waited;
      if (waited > this.counters.resumeWaitMsMax) this.counters.resumeWaitMsMax = waited;
    }
    rec.state = 'held';
    this.suspended -= 1;
    this.active += 1;
    // shutdown lets resumers through past the cap on purpose; that must not count as a breach of the bound
    if (!this.stopped && this.active > this.counters.maxActive) this.counters.maxActive = this.active;
    const wake = rec.wake;
    rec.wake = null;
    rec.resumePromise = null;
    wake?.();
  }

  private finish(rec: SlotRecord): void {
    const n = (this.activeByMint.get(rec.mint) ?? 1) - 1;
    if (n > 0) this.activeByMint.set(rec.mint, n);
    else this.activeByMint.delete(rec.mint);
    if (rec.state === 'held') {
      this.active -= 1;
    } else if (rec.state === 'suspended') {
      this.suspended -= 1;
    } else if (rec.state === 'resuming') {
      this.suspended -= 1;
      const i = this.resumeQueue.indexOf(rec);
      if (i >= 0) this.resumeQueue.splice(i, 1);
    }
    rec.state = 'done';
    this.promoteNext();
  }

  private promoteNext(): void {
    while (!this.stopped && this.active < this.o.maxConcurrent) {
      const resumer = this.resumeQueue.shift();
      if (resumer) {
        this.grant(resumer);
        continue;
      }
      const next = this.pending.entries().next();
      if (next.done) return;
      const [mint, run] = next.value;
      this.pending.delete(mint);
      this.dispatch(mint, run);
    }
  }
}
