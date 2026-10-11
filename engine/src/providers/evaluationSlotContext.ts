import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The global-evaluation-slot handle of the evaluation that is currently running, as seen by the code it calls.
 *
 * Why this exists (P1): `EvaluationScheduler` bounds how many evaluations run at once (`maxConcurrent`, = the RPC
 * gate's concurrency) and that bound is what keeps the provider gates' queues bounded. But an evaluation that is
 * merely WAITING for a rate-limited quote (Jupiter keyless = 0.5 req/s, up to the 8 s gate deadline) used to keep its
 * slot the whole time, so a handful of quote waiters starved every other token of its ~2 s tick (observed cadence
 * 12-26 s). The quote gate wrapper (`quoteStage.ts`) uses this handle to give the slot back for exactly the time it
 * waits on the provider, under a bound of its own, and to take a slot again before the evaluation continues.
 *
 * It travels as AsyncLocalStorage so no evaluation, safety, strategy or execution code has to know about it.
 */
export interface EvaluationSlot {
  /** Identifies the token being evaluated; the quote stage uses it to be fair across tokens (least recently admitted first). */
  readonly key: string;
  /** True while the evaluation this handle belongs to is still running (a leftover reference is inert). */
  isLive(): boolean;
  /** Give the global slot back (idempotent). Promotes the next waiting tick / resumer. */
  suspend(): void;
  /** Wait for a global slot again (FIFO, ahead of brand-new ticks). Resolves immediately after shutdown or if never suspended. */
  resume(): Promise<void>;
}

export const evaluationSlotContext = new AsyncLocalStorage<EvaluationSlot>();
