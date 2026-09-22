export type ProviderKind = 'rpc' | 'quote';

export interface KindCounters {
  /** LOGICAL requests (one per caller request, however many HTTP attempts it took) and how many ended in failure. */
  logicalRequests: number;
  logicalFailures: number;
  /** HTTP ATTEMPTS. */
  requests: number;
  successes: number;
  failures: number;
  http429: number;
  http5xx: number;
  timeouts: number;
  networkErrors: number;
  unsupported: number;
  retries: number;
  fallbackUsed: number;
  circuitOpened: number;
  circuitSkipped: number;
  shutdownAborted: number;
  /**
   * Category D (bug fix following the Phase 5.6J VPS incident): a logical request never even made an HTTP attempt at
   * this endpoint because the LOCAL gate (rate-limit spacing or the concurrency queue) could not get it a slot
   * before the logical request's own deadline. This is never evidence the upstream provider is unhealthy -- it never
   * increments `consecutiveFailures` and can never open the circuit on its own. High counts here mean the gate's own
   * `maxRequestsPerSecond`/`maxConcurrent`/`maxTotalMs` are undersized for the offered load, not that the provider is failing.
   */
  gateCapacityRejected: number;
  cacheHits: number;
  cacheMisses: number;
  dedupHits: number;
}

const zero = (): KindCounters => ({
  logicalRequests: 0,
  logicalFailures: 0,
  requests: 0,
  successes: 0,
  failures: 0,
  http429: 0,
  http5xx: 0,
  timeouts: 0,
  networkErrors: 0,
  unsupported: 0,
  retries: 0,
  fallbackUsed: 0,
  circuitOpened: 0,
  circuitSkipped: 0,
  shutdownAborted: 0,
  gateCapacityRejected: 0,
  cacheHits: 0,
  cacheMisses: 0,
  dedupHits: 0,
});

class Reservoir {
  private readonly samples: number[] = [];
  private idx = 0;
  count = 0;
  private sum = 0;
  max = 0;
  constructor(private readonly capacity = 2048) {}
  add(v: number): void {
    this.count += 1;
    this.sum += v;
    if (v > this.max) this.max = v;
    if (this.samples.length < this.capacity) this.samples.push(v);
    else this.samples[this.idx++ % this.capacity] = v;
  }
  summary(): { count: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number } {
    const s = [...this.samples].sort((a, b) => a - b);
    const q = (p: number): number => (s.length ? (s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] as number) : 0);
    return { count: this.count, meanMs: this.count ? this.sum / this.count : 0, p50Ms: q(0.5), p95Ms: q(0.95), maxMs: this.max };
  }
}

export interface MetricsSnapshot {
  atMs: number;
  kinds: Record<ProviderKind, KindCounters & { latency: ReturnType<Reservoir['summary']> }>;
  /** Per endpoint HOST (never a full URL, key or path). */
  endpoints: Record<string, Pick<KindCounters, 'requests' | 'successes' | 'failures' | 'http429' | 'timeouts'>>;
  /** Why the safety gate could not obtain data (counts by data source and reason). */
  safetyUnavailable: Record<string, number>;
  /** Which endpoint host answered the most recent request of each kind, and when (event time of the response). */
  lastProvider: Partial<Record<ProviderKind, { host: string; asOfMs: number }>>;
}

/** Structured provider metrics. Holds counters only: never a URL, header or secret. */
export class ProviderMetrics {
  private readonly kinds: Record<ProviderKind, KindCounters> = { rpc: zero(), quote: zero() };
  private readonly latency: Record<ProviderKind, Reservoir> = { rpc: new Reservoir(), quote: new Reservoir() };
  private readonly endpoints = new Map<string, Pick<KindCounters, 'requests' | 'successes' | 'failures' | 'http429' | 'timeouts'>>();
  private readonly safety = new Map<string, number>();
  private readonly last: Partial<Record<ProviderKind, { host: string; asOfMs: number }>> = {};

  inc(kind: ProviderKind, field: keyof KindCounters, by = 1): void {
    this.kinds[kind][field] += by;
  }

  endpointInc(host: string, field: 'requests' | 'successes' | 'failures' | 'http429' | 'timeouts'): void {
    let e = this.endpoints.get(host);
    if (!e) {
      e = { requests: 0, successes: 0, failures: 0, http429: 0, timeouts: 0 };
      this.endpoints.set(host, e);
    }
    e[field] += 1;
  }

  recordLatency(kind: ProviderKind, ms: number): void {
    this.latency[kind].add(ms);
  }

  recordProvider(kind: ProviderKind, host: string, asOfMs: number): void {
    this.last[kind] = { host, asOfMs };
  }

  recordSafetyUnavailable(source: string, reason: string): void {
    const k = `${source}:${reason}`;
    this.safety.set(k, (this.safety.get(k) ?? 0) + 1);
  }

  counters(kind: ProviderKind): Readonly<KindCounters> {
    return this.kinds[kind];
  }

  snapshot(nowMs: number = Date.now()): MetricsSnapshot {
    return {
      atMs: nowMs,
      kinds: {
        rpc: { ...this.kinds.rpc, latency: this.latency.rpc.summary() },
        quote: { ...this.kinds.quote, latency: this.latency.quote.summary() },
      },
      endpoints: Object.fromEntries([...this.endpoints.entries()].map(([k, v]) => [k, { ...v }])),
      safetyUnavailable: Object.fromEntries(this.safety),
      lastProvider: { ...this.last },
    };
  }
}
