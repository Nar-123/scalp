import type { ProviderKind, ProviderMetrics } from './providerMetrics.js';

/** A cached value together with the wall-clock time it was obtained (its as-of time). */
export interface Timed<T> {
  value: T;
  fetchedAtMs: number;
  /** true when this call was served from the cache or joined an in-flight request. */
  cached: boolean;
}

/**
 * Short-lived cache + request deduplication ("single flight").
 *
 *  - Identical concurrent requests share ONE upstream call.
 *  - A successful result is reused for at most `ttlMs`, and never longer than `maxAgeMs` (the freshness bound the
 *    decision rules require: 10 s). The as-of time travels with the value, so consumers can check coherence.
 *  - Failures are NEVER cached: a null / thrown result is returned to every waiter of that flight and the next call
 *    goes upstream again (the ProviderGate's circuit and backoff limit how hard that can hit a provider).
 *  - The cache is bounded (`maxEntries`, oldest evicted).
 */
export class SingleFlightCache<T> {
  private readonly entries = new Map<string, { value: T; fetchedAtMs: number }>();
  private readonly inflight = new Map<string, Promise<Timed<T> | null>>();

  constructor(
    private readonly opts: { ttlMs: number; maxAgeMs: number; maxEntries?: number; now?: () => number; metrics?: ProviderMetrics; kind?: ProviderKind },
  ) {
    if (opts.ttlMs > opts.maxAgeMs) throw new Error('ttlMs must not exceed maxAgeMs (a cached value would outlive the freshness bound)');
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * `loader` returns the value or null (unavailable). Rejections are converted to null: callers fail closed.
   * `cacheable(value)` decides whether a loaded value may be REUSED later; a non-cacheable value (for example a
   * "no route" answer) is still shared with the callers that joined that very flight.
   */
  async get(key: string, loader: () => Promise<T | null>, cacheable: (value: T) => boolean = () => true): Promise<Timed<T> | null> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.fetchedAtMs <= this.opts.ttlMs) {
      this.count('cacheHits');
      return { value: hit.value, fetchedAtMs: hit.fetchedAtMs, cached: true };
    }
    if (hit) this.entries.delete(key);
    const pending = this.inflight.get(key);
    if (pending) {
      this.count('dedupHits');
      const r = await pending;
      return r ? { ...r, cached: true } : null;
    }
    this.count('cacheMisses');
    const flight = (async (): Promise<Timed<T> | null> => {
      try {
        const value = await loader();
        if (value === null) return null;
        const fetchedAtMs = this.now();
        if (this.opts.ttlMs > 0 && cacheable(value)) {
          this.entries.set(key, { value, fetchedAtMs });
          const max = this.opts.maxEntries ?? 512;
          while (this.entries.size > max) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
          }
        }
        return { value, fetchedAtMs, cached: false };
      } catch {
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, flight);
    return flight;
  }

  /** Drops entries older than the TTL (also happens lazily on read). */
  prune(): void {
    const t = this.now();
    for (const [k, v] of this.entries) if (t - v.fetchedAtMs > this.opts.ttlMs) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get inFlight(): number {
    return this.inflight.size;
  }

  private count(field: 'cacheHits' | 'cacheMisses' | 'dedupHits'): void {
    if (this.opts.metrics && this.opts.kind) this.opts.metrics.inc(this.opts.kind, field);
  }
}
