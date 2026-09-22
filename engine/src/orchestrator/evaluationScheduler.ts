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
 *  - At most `maxConcurrent` DISPATCHES run at once, GLOBALLY, across every watched token.
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
 *  - When a dispatch finishes, exactly one pending token (the OLDEST waiting one) is promoted and run with ITS
 *    LATEST closure -- so a token that was pending for several ticks evaluates on the CURRENT market state the
 *    moment it finally runs, never stale data from when it first queued.
 *  - `forget(mint)` drops any pending signal for a token that has aged out, so a token no longer watched can never
 *    consume a future slot.
 *  - `stop()` clears the pending set and refuses new dispatches; already-active evaluations are left to finish on
 *    their own (each already bounded by the existing per-provider-call `maxTotalMs` and the per-token
 *    `EvaluationGuard`'s stale-lease takeover -- nothing here needs its own timeout).
 *
 * Discovery (`watchToken`) and aging out (`stopWatching`) are entirely unaffected: both are driven by the WS log
 * stream and local clock checks, never by this scheduler or by ProviderGate.
 */
export interface EvaluationSchedulerOptions {
  /** Maximum number of evaluation dispatches allowed to run concurrently, across every watched token. */
  maxConcurrent: number;
}

export class EvaluationScheduler {
  private active = 0;
  /** How many of the current dispatches belong to each mint (almost always 0 or 1; briefly 2 during a stale-lease takeover). */
  private readonly activeByMint = new Map<string, number>();
  /** Insertion-ordered: iteration order is FIFO by first-queued time, and re-setting an existing key never changes it. */
  private readonly pending = new Map<string, () => Promise<void>>();
  private stopped = false;

  constructor(private readonly o: EvaluationSchedulerOptions) {
    if (!(o.maxConcurrent > 0)) throw new Error('EvaluationScheduler maxConcurrent must be positive');
  }

  /** Dispatches currently running (never exceeds maxConcurrent). */
  get activeCount(): number {
    return this.active;
  }

  /** Tokens with a coalesced tick waiting for a free global slot. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** true while at least one dispatch for this mint is currently running. */
  isActive(mint: string): boolean {
    return (this.activeByMint.get(mint) ?? 0) > 0;
  }

  isPending(mint: string): boolean {
    return this.pending.has(mint);
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
  }

  /** Drops a pending signal for a token that is no longer watched (called from stopWatching). A no-op if it wasn't pending. */
  forget(mint: string): void {
    this.pending.delete(mint);
  }

  /** Stops accepting new dispatches and drops every pending signal. Already-active evaluations run to their own completion. */
  stop(): void {
    this.stopped = true;
    this.pending.clear();
  }

  private dispatch(mint: string, run: () => Promise<void>): void {
    this.active += 1;
    this.activeByMint.set(mint, (this.activeByMint.get(mint) ?? 0) + 1);
    void run()
      .catch(() => undefined) // evaluateToken() already catches its own errors; this is belt-and-suspenders so a scheduler slot can never leak
      .finally(() => {
        this.active -= 1;
        const n = (this.activeByMint.get(mint) ?? 1) - 1;
        if (n > 0) this.activeByMint.set(mint, n);
        else this.activeByMint.delete(mint);
        this.promoteNext();
      });
  }

  private promoteNext(): void {
    if (this.stopped || this.active >= this.o.maxConcurrent) return;
    const next = this.pending.entries().next();
    if (next.done) return;
    const [mint, run] = next.value;
    this.pending.delete(mint);
    this.dispatch(mint, run);
  }
}
