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
 */
export class FetchRateLimiter {
  private windowStartMs: number;
  private countThisWindow = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!(maxPerWindow > 0)) throw new Error('FetchRateLimiter maxPerWindow must be positive');
    this.windowStartMs = this.now();
  }

  /** true: allowed, and counted against the current window. false: reject -- the caller must not start the fetch. */
  allow(): boolean {
    const now = this.now();
    if (now - this.windowStartMs >= 1000) {
      this.windowStartMs = now;
      this.countThisWindow = 0;
    }
    if (this.countThisWindow >= this.maxPerWindow) return false;
    this.countThisWindow += 1;
    return true;
  }
}
