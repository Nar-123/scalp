/**
 * Fixed-window, synchronous, CALLER-SIDE rate limiter for discovery's own outbound RPC calls (e.g.
 * `getParsedTransaction` per matching WS log event) -- extracted, byte-identical in behavior, from
 * `RaydiumLogSubscriber`'s original inline `allowFetch()` (Phase 1.1), and now reused by
 * `PumpFunLogSubscriber` too (the discovery RPC capacity freeze fix: see
 * docs/-- investigation branch `investigate/discovery-rpc-capacity-freeze` -- Pump.fun's per-log-event
 * `getParsedTransaction` call previously had NO caller-side bound at all, unlike Raydium's, and could offer
 * unbounded RPC demand to the shared `ProviderGate` that the safety gate's evaluations also depend on).
 *
 * Deliberately simple and synchronous: `allow()` either returns `true` immediately (and counts against the
 * current window) or `false` immediately -- it never queues, waits, sleeps, or creates a Promise. A caller whose
 * call is rejected is expected to skip/drop that one event (exactly as `RaydiumLogSubscriber` already does, and
 * as `PumpFunLogSubscriber` now does too) -- this is what keeps a caller-side throttle from ever creating an
 * unbounded-pending-promise problem of its own: there is nothing here TO wait on.
 *
 * A fixed 1-second window (reset on first use after the window elapses), not a sliding window: this matches the
 * original Raydium behavior exactly, and is precise enough for its purpose (a coarse cap on offered discovery RPC
 * load, not a precise rate contract -- `ProviderGate`'s own `maxRequestsPerSecond` remains the precise contract
 * with the actual provider).
 *
 * OBSERVABILITY (Stage 1, added after the 6 h validation run showed ~35 % of Pump.fun creations never reached
 * evaluation because of this limit, while the drops themselves were invisible -- they were only logged at debug):
 * every decision is now COUNTED, per limiter, so the offered/allowed/rejected load is visible in the periodic
 * metrics. The counting is strictly observational:
 *   - it reads the same single `now()` value `allow()` already used (no extra clock call, no timer, no I/O);
 *   - the admit/reject decision is computed from `countThisWindow` and `maxPerWindow` exactly as before and is
 *     never influenced by any counter; the bookkeeping is wrapped so it can never throw into `allow()`;
 *   - memory is bounded (a fixed ring of completed 60 s intervals plus scalar aggregates).
 * It changes NO limit and has no configuration of its own.
 */

/** Length of one decision window. Part of the limiter's contract; not configurable. */
const WINDOW_MS = 1000;
const DEFAULT_INTERVAL_MS = 60_000;
/** 360 completed 60 s intervals = the last 6 h, used only for the quantiles. */
const DEFAULT_RING_SIZE = 360;

export interface FetchRateLimiterOptions {
  /** Name of the event source this limiter guards (e.g. 'pumpfun', 'raydium'); reported in `stats()`. */
  label?: string;
  /** Length of one reporting interval for the per-interval distribution. Default 60 000 ms. */
  intervalMs?: number;
  /** How many completed intervals are kept for the quantiles (the totals/min/mean/max cover ALL intervals). */
  ringSize?: number;
}

export interface IntervalDistribution {
  min: number | null;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

export interface FetchLimiterStats {
  label: string;
  /** The effective limit: decisions admitted per 1 s window. */
  maxPerWindow: number;
  windowMs: number;
  intervalMs: number;
  /** Every call to `allow()`: allowed + rejected. */
  offeredTotal: number;
  allowedTotal: number;
  rejectedTotal: number;
  /** rejected / offered in percent (0 when nothing was offered). */
  rejectedPct: number;
  /** Number of 1 s windows in which at least one event was rejected. */
  windowsWithRejection: number;
  /** The most events offered inside one 1 s window (allowed + rejected): the burst the limit had to absorb. */
  peakOfferedInWindow: number;
  /** The interval currently being filled (its index counts from the limiter's creation). */
  currentInterval: { index: number; allowed: number; rejected: number };
  /** Completed intervals, including intervals in which nothing was offered. */
  completedIntervals: number;
  lastCompletedInterval: { allowed: number; rejected: number } | null;
  /** Per-interval distribution over completed intervals; quantiles use the most recent `quantileSampleIntervals`. */
  perInterval: { allowed: IntervalDistribution; rejected: IntervalDistribution };
  quantileSampleIntervals: number;
}

export class FetchRateLimiter {
  private windowStartMs: number;
  private countThisWindow = 0;

  // ---- observability state (never read by allow()'s decision) ----
  private readonly label: string;
  private readonly intervalMs: number;
  private readonly ringSize: number;
  private readonly originMs: number;
  private offeredThisWindow = 0;
  private windowHadRejection = false;
  private allowedTotal = 0;
  private rejectedTotal = 0;
  private windowsWithRejection = 0;
  private peakOfferedInWindow = 0;
  private currentIndex = 0;
  private curAllowed = 0;
  private curRejected = 0;
  private completed = 0;
  private sumAllowed = 0;
  private sumRejected = 0;
  private minAllowed: number | null = null;
  private maxAllowed: number | null = null;
  private minRejected: number | null = null;
  private maxRejected: number | null = null;
  private lastCompleted: { allowed: number; rejected: number } | null = null;
  private readonly ringAllowed: number[];
  private readonly ringRejected: number[];
  private ringNext = 0;
  private ringFill = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly now: () => number = Date.now,
    options: FetchRateLimiterOptions = {},
  ) {
    if (!(maxPerWindow > 0)) throw new Error('FetchRateLimiter maxPerWindow must be positive');
    this.windowStartMs = this.now();
    this.originMs = this.windowStartMs;
    this.label = options.label ?? 'unnamed';
    this.intervalMs = options.intervalMs !== undefined && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
    this.ringSize = options.ringSize !== undefined && options.ringSize >= 1 ? Math.floor(options.ringSize) : DEFAULT_RING_SIZE;
    this.ringAllowed = new Array<number>(this.ringSize).fill(0);
    this.ringRejected = new Array<number>(this.ringSize).fill(0);
  }

  /** true: allowed, and counted against the current window. false: reject -- the caller must not start the fetch. */
  allow(): boolean {
    const now = this.now();
    if (now - this.windowStartMs >= WINDOW_MS) {
      this.windowStartMs = now;
      this.countThisWindow = 0;
      this.offeredThisWindow = 0;
      this.windowHadRejection = false;
    }
    const allowed = this.countThisWindow < this.maxPerWindow;
    if (allowed) this.countThisWindow += 1;
    try {
      this.observe(now, allowed);
    } catch {
      // observability must never be able to change or break the decision
    }
    return allowed;
  }

  /** Cumulative counters and the per-interval distribution. Pure read apart from closing elapsed intervals. */
  stats(): FetchLimiterStats {
    try {
      this.rollTo(this.indexFor(this.now()));
    } catch {
      // keep whatever was recorded
    }
    const offered = this.allowedTotal + this.rejectedTotal;
    const sampleA = this.ringAllowed.slice(0, this.ringFill);
    const sampleR = this.ringRejected.slice(0, this.ringFill);
    return {
      label: this.label,
      maxPerWindow: this.maxPerWindow,
      windowMs: WINDOW_MS,
      intervalMs: this.intervalMs,
      offeredTotal: offered,
      allowedTotal: this.allowedTotal,
      rejectedTotal: this.rejectedTotal,
      rejectedPct: offered > 0 ? Math.round((1000 * this.rejectedTotal) / offered) / 10 : 0,
      windowsWithRejection: this.windowsWithRejection,
      peakOfferedInWindow: this.peakOfferedInWindow,
      currentInterval: { index: this.currentIndex, allowed: this.curAllowed, rejected: this.curRejected },
      completedIntervals: this.completed,
      lastCompletedInterval: this.lastCompleted ? { ...this.lastCompleted } : null,
      perInterval: {
        allowed: distribution(sampleA, this.completed, this.sumAllowed, this.minAllowed, this.maxAllowed),
        rejected: distribution(sampleR, this.completed, this.sumRejected, this.minRejected, this.maxRejected),
      },
      quantileSampleIntervals: sampleA.length,
    };
  }

  private indexFor(nowMs: number): number {
    const i = Math.floor((nowMs - this.originMs) / this.intervalMs);
    return i > this.currentIndex ? i : this.currentIndex; // a clock that steps backwards never reopens a closed interval
  }

  private observe(nowMs: number, allowed: boolean): void {
    this.rollTo(this.indexFor(nowMs));
    if (allowed) {
      this.allowedTotal += 1;
      this.curAllowed += 1;
    } else {
      this.rejectedTotal += 1;
      this.curRejected += 1;
      if (!this.windowHadRejection) {
        this.windowHadRejection = true;
        this.windowsWithRejection += 1;
      }
    }
    this.offeredThisWindow += 1;
    if (this.offeredThisWindow > this.peakOfferedInWindow) this.peakOfferedInWindow = this.offeredThisWindow;
  }

  /** Closes the current interval and any fully idle intervals up to (not including) `index`. */
  private rollTo(index: number): void {
    if (index <= this.currentIndex) return;
    this.closeInterval(this.curAllowed, this.curRejected);
    const idle = index - this.currentIndex - 1; // intervals in which nothing was offered
    if (idle > 0) {
      // bounded work: only the last `ringSize` idle intervals can still be visible in the quantile sample
      const visible = Math.min(idle, this.ringSize);
      for (let k = 0; k < visible; k += 1) this.pushRing(0, 0);
      this.completed += idle;
      this.minAllowed = 0;
      this.minRejected = 0;
      if (this.maxAllowed === null) this.maxAllowed = 0;
      if (this.maxRejected === null) this.maxRejected = 0;
      this.lastCompleted = { allowed: 0, rejected: 0 };
    }
    this.currentIndex = index;
    this.curAllowed = 0;
    this.curRejected = 0;
  }

  private closeInterval(allowed: number, rejected: number): void {
    this.completed += 1;
    this.sumAllowed += allowed;
    this.sumRejected += rejected;
    this.minAllowed = this.minAllowed === null ? allowed : Math.min(this.minAllowed, allowed);
    this.maxAllowed = this.maxAllowed === null ? allowed : Math.max(this.maxAllowed, allowed);
    this.minRejected = this.minRejected === null ? rejected : Math.min(this.minRejected, rejected);
    this.maxRejected = this.maxRejected === null ? rejected : Math.max(this.maxRejected, rejected);
    this.lastCompleted = { allowed, rejected };
    this.pushRing(allowed, rejected);
  }

  private pushRing(allowed: number, rejected: number): void {
    this.ringAllowed[this.ringNext] = allowed;
    this.ringRejected[this.ringNext] = rejected;
    this.ringNext = (this.ringNext + 1) % this.ringSize;
    if (this.ringFill < this.ringSize) this.ringFill += 1;
  }
}

function distribution(sample: number[], completed: number, sum: number, min: number | null, max: number | null): IntervalDistribution {
  if (completed === 0 || sample.length === 0) return { min: null, mean: null, p50: null, p90: null, p99: null, max: null };
  const s = [...sample].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
  return { min, mean: Math.round((100 * sum) / completed) / 100, p50: q(0.5), p90: q(0.9), p99: q(0.99), max };
}
