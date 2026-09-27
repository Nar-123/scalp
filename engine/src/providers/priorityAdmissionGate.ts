/**
 * Priority-aware ADMISSION layer placed ABOVE an existing, completely UNMODIFIED `ProviderGate` (Option A of the
 * `investigate/shared-rpc-capacity` investigation, chosen over Option B/partitioned capacity based on a measured
 * reproduction: Option A gave evaluation 100% success at zero `gateCapacityRejected`, while a plausible-looking
 * static partition split made evaluation WORSE than doing nothing -- see that investigation's report).
 *
 * The problem: discovery (Raydium + Pump.fun, each throttled to 1/s by `FetchRateLimiter`, PR #6) and evaluation
 * (`DirectSafetyDataSource`, via `EvaluationScheduler`) share ONE `ProviderGate`/`connection` for RPC. That gate's
 * own internal waiter queue is plain FIFO with no concept of caller identity, so once combined offered load
 * sustains above the gate's shared ceiling (`maxRequestsPerSecond`), queueing delay grows until requests miss
 * their own `maxTotalMs` deadline and get capacity-rejected -- with NO distinction between which caller type loses
 * the slot. PR #6 bounded discovery's own offered rate but did nothing to protect evaluation from discovery's
 * residual contention on the shared queue; this is that protection.
 *
 * This class does not touch `ProviderGate` at all -- it only decides, when multiple callers are simultaneously
 * trying to begin a logical request, which one gets to call `gate.execute()` NEXT, always preferring a waiting
 * 'high' (evaluation) caller over a waiting 'low' (discovery) caller. `ProviderGate`'s own FIFO queue is left
 * exactly as-is; this layer resolves fairness earlier, before contention ever reaches ProviderGate's own queue, by
 * bounding how many logical requests are allowed to even ATTEMPT `gate.execute()` at once to (at most) the gate's
 * own `maxConcurrent` -- so under sustained contention, ProviderGate's queue itself rarely needs to arbitrate at
 * all; this layer already did.
 *
 * Why this cannot grow an unbounded queue of its own (both `highWaiters`/`lowWaiters` stay bounded in practice,
 * even though nothing here enforces a hard cap): the only two callers wired to this gate (`providerStack.ts`) are
 * each ALREADY bounded upstream, independently of this class --
 *  - evaluation: `EvaluationScheduler` already bounds concurrent evaluation dispatches to `cfg.providers.rpc.
 *    maxConcurrent`, so at most that many 'high' callers can ever be in flight (active + waiting) at once;
 *  - discovery: each subscriber's own `FetchRateLimiter` (1/s) already bounds how often a 'low' caller is even
 *    OFFERED to this gate.
 * And every ADMITTED caller is itself bounded: `fn` is `() => gate.execute(...)`, and `ProviderGate.execute()`
 * always settles (success or `ProviderError`) within its own `maxTotalMs` budget, so a granted slot is always
 * released in bounded time. A hung/never-resolving caller is already handled at the orchestrator level (a stuck
 * evaluation is superseded by the next tick, independent of this class) -- there is intentionally no separate
 * admission-wait deadline here, since one is unnecessary given the above and would only duplicate `maxTotalMs`.
 */
export type AdmissionPriority = 'high' | 'low';

interface Waiter {
  wake: () => void;
  reject: (err: Error) => void;
}

export class PriorityAdmissionGate {
  private active = 0;
  private readonly highWaiters: Waiter[] = [];
  private readonly lowWaiters: Waiter[] = [];
  private shutdownFlag = false;

  constructor(private readonly maxConcurrentAdmissions: number) {
    if (!(maxConcurrentAdmissions > 0)) throw new Error('PriorityAdmissionGate maxConcurrentAdmissions must be positive');
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingHigh(): number {
    return this.highWaiters.length;
  }

  get pendingLow(): number {
    return this.lowWaiters.length;
  }

  get isShutdown(): boolean {
    return this.shutdownFlag;
  }

  /** Runs `fn` once an admission ticket is available, preferring 'high' priority callers when both queues are non-empty. */
  async run<T>(priority: AdmissionPriority, fn: () => Promise<T>): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(priority: AdmissionPriority): Promise<void> {
    if (this.shutdownFlag) return Promise.reject(new Error('PriorityAdmissionGate is shut down'));
    if (this.active < this.maxConcurrentAdmissions) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        wake: (): void => {
          this.active += 1;
          resolve();
        },
        reject,
      };
      (priority === 'high' ? this.highWaiters : this.lowWaiters).push(waiter);
    });
  }

  /** Always promotes a HIGH-priority waiter first, however many LOW-priority waiters arrived earlier. */
  private release(): void {
    this.active -= 1;
    const next = this.highWaiters.shift() ?? this.lowWaiters.shift();
    if (next) next.wake();
  }

  /**
   * Cleanly cancels every caller currently WAITING for an admission ticket (none of them ever reached `fn`, so
   * there is nothing to release for them -- `active` is untouched by this) and refuses every future `run()` call.
   * Idempotent. Callers already past `acquire()` and inside `fn` are unaffected here -- they are expected to
   * observe the underlying `ProviderGate`'s own `shutdown()` (aborting their in-flight attempt) and unwind through
   * `run()`'s normal `finally` -> `release()` path, exactly as on any other error.
   */
  shutdown(): void {
    if (this.shutdownFlag) return;
    this.shutdownFlag = true;
    const pending = [...this.highWaiters, ...this.lowWaiters];
    this.highWaiters.length = 0;
    this.lowWaiters.length = 0;
    for (const w of pending) w.reject(new Error('PriorityAdmissionGate is shut down'));
  }
}
