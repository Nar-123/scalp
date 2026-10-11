import type { FetchLimiterStats } from './fetchRateLimiter.js';

/** A discovery source that can report its caller-side fetch limiter counters. */
export interface LimiterStatsSource {
  readonly name: string;
  getFetchLimiterStats(): FetchLimiterStats;
}

type InfoLogger = { info: (obj: Record<string, unknown>, msg: string) => void };

/**
 * Periodically logs the discovery fetch limiters' counters (one line per interval, one entry per source) and once more
 * on stop. OBSERVATION ONLY: it reads `getFetchLimiterStats()`, owns one unref'd timer, performs no I/O other than the
 * log line, and swallows every error -- it cannot change which events are fetched or dropped (Stage 1).
 */
export class DiscoveryLimiterReporter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sources: readonly LimiterStatsSource[],
    private readonly logger: InfoLogger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer !== null || !(this.intervalMs > 0)) return;
    this.timer = setInterval(() => this.report('periodic'), this.intervalMs);
    this.timer.unref?.();
  }

  /** Stops the timer (idempotent) and logs the final totals. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.report('final');
    }
  }

  /** One structured log line with every source's counters. Never throws. */
  report(kind: 'periodic' | 'final'): void {
    try {
      const discoveryLimiter: Record<string, FetchLimiterStats> = {};
      for (const s of this.sources) discoveryLimiter[s.name] = s.getFetchLimiterStats();
      this.logger.info({ kind, discoveryLimiter }, 'discovery limiter');
    } catch {
      // observability only
    }
  }
}
