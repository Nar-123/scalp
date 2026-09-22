/**
 * Bounded shutdown. Every step gets a hard time limit; a step that never settles (Phase 5.6 measured an RPC log
 * unsubscription hanging for over four minutes on a rate-limited endpoint) is reported as timed out and the sequence
 * MOVES ON, so process termination can never be held hostage by one dependency. Steps run in order.
 */

export type StepOutcome = 'ok' | 'timed_out' | 'error';

export interface StepReport {
  name: string;
  outcome: StepOutcome;
  ms: number;
}

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | unknown;
  /** Overrides the default per-step limit. */
  timeoutMs?: number;
}

/** Resolves with the outcome; never rejects and never outlives `timeoutMs` (the timer is always cleared). */
export async function runBounded(fn: () => Promise<unknown> | unknown, timeoutMs: number): Promise<StepOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StepOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
  });
  const work = (async (): Promise<StepOutcome> => {
    try {
      await fn();
      return 'ok';
    } catch {
      return 'error';
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runShutdown(steps: ShutdownStep[], defaults: { stepTimeoutMs: number; now?: () => number }): Promise<StepReport[]> {
  const now = defaults.now ?? Date.now;
  const reports: StepReport[] = [];
  for (const step of steps) {
    const t0 = now();
    const outcome = await runBounded(step.run, step.timeoutMs ?? defaults.stepTimeoutMs);
    reports.push({ name: step.name, outcome, ms: now() - t0 });
  }
  return reports;
}
