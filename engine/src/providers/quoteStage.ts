import { evaluationSlotContext } from './evaluationSlotContext.js';
import { ProviderError, ProviderGate, type GateRequest, type GateResponse, type ProviderGateOptions } from './providerGate.js';
import type { ProviderMetrics } from './providerMetrics.js';

/**
 * Admission for evaluations that must wait on the (rate-limited) QUOTE provider, placed ABOVE an otherwise
 * unmodified `ProviderGate` -- the same pattern as `PriorityAdmissionGate`. P1.
 *
 * The problem: an evaluation waiting for a Jupiter quote (keyless = 0.5 req/s, so a few waiters already means ~8 s)
 * kept one of the scheduler's few global slots the whole time. About 30 such evaluations a minute were enough to
 * keep every slot taken and stretch every other token's 2 s tick to 12-26 s, although the other ~97 % of ticks need
 * no network at all. Raising the provider budget is not an option (and would not be a fix); the waiting simply must
 * not occupy the slots that exist to bound WORK.
 *
 * What it does, for a call made by an evaluation (found through `evaluationSlotContext`):
 *   1. give the evaluation's global slot back (`suspend`) -- everything else can run;
 *   2. take one of `maxConcurrent` quote PERMITS, waiting in a short line (`maxQueued` places, `maxQueueWaitMs` at
 *      most). FAIRNESS: the line is ordered by who was admitted LEAST RECENTLY (a token never admitted goes first),
 *      and a newcomer who has waited longer for the provider than the least deserving waiter takes that place (the
 *      displaced one is refused). A plain arrival-order line starves tokens whose tick phase is always late -- every
 *      token ticks at a fixed offset, so the same few win every cycle (caught by the cadence test). No permit and no
 *      place in line, or the wait ran out, or displaced, or shutdown: refuse at once, FAIL CLOSED, with a
 *      `ProviderError` the quote client already turns into "quote unavailable";
 *   3. run the real `ProviderGate.execute` (its own concurrency, rate spacing, retries and 8 s deadline unchanged);
 *   4. give the permit back, then take a global slot again (`resume`) before the evaluation continues.
 *
 * Bounds that replace "the scheduler's slots happen to cap it": at most `maxConcurrent` evaluations are inside the
 * provider gate at once (so its waiter queue stays as short as it was), at most `maxQueued` more are waiting for a
 * permit, every wait is time-limited, and `shutdown()` refuses everything still waiting. Calls that did not come
 * from an evaluation (position monitoring, start-up, tests) pass straight through, exactly as before. Cache hits in
 * `JupiterQuoteClient` never reach this class (it sits below the cache), so they cost no permit and no slot.
 */
export interface QuoteStageOptions {
  /** Evaluations allowed inside the quote gate at once. */
  maxConcurrent: number;
  /** Evaluations allowed to wait in line for a permit; one more is refused immediately. */
  maxQueued: number;
  /** Longest an evaluation waits in line before it is refused. */
  maxQueueWaitMs: number;
}

export interface QuoteStageStats {
  permitsInUse: number;
  queued: number;
  maxPermitsInUse: number;
  maxQueued: number;
  admitted: number;
  admittedAfterWait: number;
  rejectedQueueFull: number;
  rejectedWaitTimeout: number;
  rejectedDisplaced: number;
  rejectedShutdown: number;
  passedThrough: number;
  waitMsTotal: number;
  waitMsMax: number;
}

/**
 * Sizes the stage from the quote gate's EXISTING configuration only -- no new tunables, no change to any limit.
 *
 * PERMITS: no more evaluations inside the gate than it can serve within ONE request timeout at its configured rate
 * (`rps * timeoutMs`, at least 1, at most the gate's own concurrency). This is not about throughput (2 permits already
 * keep a 0.5 req/s gate fully busy) but about the request's own time budget: inside the gate a request first waits for
 * its rate slot and only then fetches, with whatever is left of `maxTotalMs` as its attempt window. With P requests
 * inside, the wait is about `P * spacing - (previous latency)`; at P = 4 and 2 s spacing that leaves a window equal
 * to the PREVIOUS request's latency (a few hundred ms), so about half of all attempts aborted as
 * `gateCapacityRejected`/`fetchAbandoned` -- measured live: 28 % rejected and 83 abandoned fetches against 1 % / 1 for
 * the old code, which never kept the gate that saturated. P = `rps * timeoutMs` bounds the wait to one timeout, so
 * every attempt keeps a full `timeoutMs` window.
 * WAIT BUDGET: one request timeout. PLACES IN LINE: as many as the gate can serve inside that budget (rounded up,
 * never fewer than 1 nor more than twice the permits), because a longer line only collects waiters that are certain
 * to be refused.
 */
export function quoteStageOptions(q: { maxConcurrent: number; maxRequestsPerSecond: number; timeoutMs: number }): QuoteStageOptions {
  const maxQueueWaitMs = q.timeoutMs;
  const servable = Math.ceil(q.maxRequestsPerSecond * (maxQueueWaitMs / 1000));
  const maxConcurrent = Math.max(1, Math.min(q.maxConcurrent, Math.floor(q.maxRequestsPerSecond * (q.timeoutMs / 1000))));
  return { maxConcurrent, maxQueued: Math.min(2 * maxConcurrent, Math.max(1, servable)), maxQueueWaitMs };
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  /** Admission sequence number of this token's last admission (-1 = never): lower = has waited longer = goes first. */
  lastAdmit: number;
  key: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounds the per-token memory the fairness rule needs (oldest entries are forgotten first; a forgotten token counts as never admitted). */
const MAX_REMEMBERED_TOKENS = 4096;

export class QuoteStage {
  private permits = 0;
  private stopped = false;
  /** Kept sorted: most deserving first (lowest lastAdmit, then earliest enqueue). */
  private readonly queue: Waiter[] = [];
  private admitSeq = 0;
  private readonly lastAdmit = new Map<string, number>();
  /** Evaluations (slot handles) that already went through the stage once; weak, so finished evaluations vanish by themselves. */
  private readonly served = new WeakSet<object>();
  private readonly c: Omit<QuoteStageStats, 'permitsInUse' | 'queued'> = {
    maxPermitsInUse: 0,
    maxQueued: 0,
    admitted: 0,
    admittedAfterWait: 0,
    rejectedQueueFull: 0,
    rejectedWaitTimeout: 0,
    rejectedDisplaced: 0,
    rejectedShutdown: 0,
    passedThrough: 0,
    waitMsTotal: 0,
    waitMsMax: 0,
  };

  constructor(private readonly o: QuoteStageOptions) {
    if (!(o.maxConcurrent > 0) || !(o.maxQueued >= 0) || !(o.maxQueueWaitMs > 0)) throw new Error('QuoteStage needs maxConcurrent > 0, maxQueued >= 0 and maxQueueWaitMs > 0');
  }

  stats(): QuoteStageStats {
    return { permitsInUse: this.permits, queued: this.queue.length, ...this.c };
  }

  /** Runs `fn` (a real provider call) under the stage if the caller is an evaluation; otherwise just runs it. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const slot = evaluationSlotContext.getStore();
    if (!slot || !slot.isLive()) {
      this.c.passedThrough += 1;
      return fn();
    }
    slot.suspend();
    const continuation = this.served.has(slot);
    this.served.add(slot);
    try {
      await this.acquire(slot.key, continuation);
    } catch (err) {
      await slot.resume(); // keep the invariant: evaluation code only runs holding a slot (immediate during shutdown)
      throw err;
    }
    try {
      return await fn();
    } finally {
      this.release();
      await slot.resume();
    }
  }

  /** Refuses everything still waiting for a permit and every later request. Calls already inside the gate finish on their own. */
  shutdown(): void {
    this.stopped = true;
    for (const w of this.queue.splice(0)) {
      clearTimeout(w.timer);
      this.c.rejectedShutdown += 1;
      w.reject(refusal('shutdown', 'quote stage is shut down'));
    }
  }

  private acquire(key: string, continuation: boolean): Promise<void> {
    if (this.stopped) {
      this.c.rejectedShutdown += 1;
      return Promise.reject(refusal('shutdown', 'quote stage is shut down'));
    }
    if (this.permits < this.o.maxConcurrent) {
      this.take(key);
      return Promise.resolve();
    }
    // A CONTINUATION (the second leg of a round trip, or a later quote of an evaluation that was already admitted) goes
    // ahead of everyone who has not been served yet: refusing it would throw away the provider call its evaluation
    // already spent. Bounded: each evaluation has a handful of quote calls, and every admission of a new token is what
    // creates them, so new tokens still get a share of every cycle.
    const lastAdmit = continuation ? -2 : (this.lastAdmit.get(key) ?? -1);
    if (this.queue.length >= this.o.maxQueued) {
      const worst = this.queue[this.queue.length - 1];
      // Full line: the newcomer may only take the place of the LEAST deserving waiter, and only if it has waited longer.
      if (!worst || lastAdmit >= worst.lastAdmit) {
        this.c.rejectedQueueFull += 1;
        return Promise.reject(refusal('rate_limited', 'quote stage is full (all permits taken, no place in line)'));
      }
      this.queue.pop();
      clearTimeout(worst.timer);
      this.c.rejectedDisplaced += 1;
      worst.reject(refusal('rate_limited', 'quote stage place given to a token that has waited longer'));
    }
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        key,
        lastAdmit,
        enqueuedAt: performance.now(),
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(w);
          if (idx >= 0) this.queue.splice(idx, 1);
          this.c.rejectedWaitTimeout += 1;
          reject(refusal('rate_limited', 'quote stage wait timed out'));
        }, this.o.maxQueueWaitMs),
      };
      w.timer.unref?.();
      let at = this.queue.length;
      while (at > 0 && this.queue[at - 1]!.lastAdmit > lastAdmit) at -= 1; // stable: equal priority keeps arrival order
      this.queue.splice(at, 0, w);
      if (this.queue.length > this.c.maxQueued) this.c.maxQueued = this.queue.length;
    });
  }

  private take(key: string): void {
    this.admitSeq += 1;
    this.lastAdmit.delete(key); // re-insert so the map stays in admission order for the size cap below
    this.lastAdmit.set(key, this.admitSeq);
    if (this.lastAdmit.size > MAX_REMEMBERED_TOKENS) this.lastAdmit.delete(this.lastAdmit.keys().next().value as string);
    this.permits += 1;
    this.c.admitted += 1;
    if (this.permits > this.c.maxPermitsInUse) this.c.maxPermitsInUse = this.permits;
  }

  private release(): void {
    this.permits -= 1;
    const next = this.queue.shift();
    if (!next) return;
    clearTimeout(next.timer);
    const waited = performance.now() - next.enqueuedAt;
    this.c.admittedAfterWait += 1;
    this.c.waitMsTotal += waited;
    if (waited > this.c.waitMsMax) this.c.waitMsMax = waited;
    this.take(next.key);
    next.resolve();
  }
}

function refusal(reason: 'rate_limited' | 'shutdown', message: string): ProviderError {
  return new ProviderError('quote', reason, message, 0, null);
}

/** The quote `ProviderGate` with the stage applied to `execute`; everything else about the gate is untouched. */
export class StagedProviderGate extends ProviderGate {
  constructor(
    options: ProviderGateOptions,
    metrics: ProviderMetrics,
    log: { warn: (obj: Record<string, unknown>, msg: string) => void } | undefined,
    private readonly stage: QuoteStage,
  ) {
    super(options, metrics, log);
  }

  override execute(req: GateRequest): Promise<GateResponse> {
    return this.stage.run(() => super.execute(req));
  }

  override shutdown(): void {
    this.stage.shutdown();
    super.shutdown();
  }
}
