import { redactUrl } from './redact.js';
import type { ProviderKind, ProviderMetrics } from './providerMetrics.js';

/**
 * ProviderGate -- request discipline for ONE kind of upstream provider (RPC or quote) with one or more endpoints.
 *
 *  - per-endpoint request spacing (a rate limit) and a concurrency bound;
 *  - a per-attempt timeout and an overall time budget for the whole logical request (retries + fallback included);
 *  - bounded retries with exponential backoff + jitter; HTTP 429 honors `Retry-After` (a wait that would exceed the
 *    remaining budget is not taken: the endpoint is given up on instead);
 *  - a method the endpoint will never serve (`x-ratelimit-method-limit: 0` on a 429 -- the public Solana RPC answers
 *    getTokenLargestAccounts that way -- or HTTP 403) is remembered and not retried or hammered;
 *  - a per-endpoint circuit breaker (fail fast while an endpoint is down);
 *  - explicit, ordered fallback endpoints, observable (`fallbackUsed`) and bounded (each endpoint at most once per
 *    logical request); the answering endpoint host and the response time are returned so a caller can timestamp it;
 *  - shutdown: every in-flight attempt and every wait is aborted, new requests are refused.
 *
 * It never invents data: when nothing can answer it throws ProviderError and the caller fails closed. Secrets
 * (endpoint URLs, headers) live only inside `ProviderEndpoint`; logs and metrics carry the host at most.
 */

export type ProviderFailureReason = 'rate_limited' | 'timeout' | 'unavailable' | 'unsupported' | 'shutdown' | 'circuit_open' | 'deadline_exceeded';

export class ProviderError extends Error {
  constructor(
    readonly providerKind: ProviderKind,
    readonly reason: ProviderFailureReason,
    message: string,
    readonly attempts: number,
    readonly host: string | null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderEndpoint {
  /** May contain a credential (query/path). Never logged; only its host is. */
  baseUrl: string;
  /** May contain a credential (for example x-api-key). Never logged. */
  headers?: Record<string, string>;
}

export interface GateRequest {
  method: 'GET' | 'POST';
  /** Appended to the endpoint base URL (quote APIs). Omit for JSON-RPC (POST to the base URL). */
  path?: string;
  body?: string;
  headers?: Record<string, string>;
  /** JSON-RPC method name, used for per-method unsupported tracking; parameters are never logged. */
  rpcMethod?: string;
}

export interface GateResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Host of the endpoint that answered (no credentials). */
  host: string;
  /** Wall-clock time the response finished arriving: the as-of time of the data. */
  asOfMs: number;
  latencyMs: number;
  /** HTTP attempts spent on this logical request. */
  attempts: number;
  fromFallback: boolean;
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{
    status: number;
    headers: { get(name: string): string | null; forEach?(cb: (value: string, key: string) => void): void };
    text(): Promise<string>;
  }>;
}

export interface ProviderGateOptions {
  kind: ProviderKind;
  endpoints: ProviderEndpoint[];
  timeoutMs: number;
  maxConcurrent: number;
  maxRequestsPerSecond: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Budget for one logical request including every retry, wait and fallback. */
  maxTotalMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  unsupportedCooldownMs: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_GATE_LIMITS = {
  timeoutMs: 4000,
  maxConcurrent: 4,
  maxRequestsPerSecond: 8,
  maxRetries: 2,
  baseBackoffMs: 250,
  maxBackoffMs: 2000,
  maxTotalMs: 8000,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 15_000,
  unsupportedCooldownMs: 10 * 60_000,
} as const;

interface EndpointState {
  endpoint: ProviderEndpoint;
  host: string;
  nextSlotAt: number;
  active: number;
  waiters: Array<() => void>;
  consecutiveFailures: number;
  openUntil: number;
  unsupportedUntil: Map<string, number>;
}

type AttemptResult = Omit<GateResponse, 'attempts' | 'latencyMs' | 'fromFallback'>;

/**
 * What happened trying this ONE endpoint for this logical request (bug fix, Phase 5.6J, extended by the P2
 * starvation fix below). `execute()` used to treat every non-success outcome the same way -- a bare `null` -- and
 * count it toward `consecutiveFailures`/the circuit breaker. That conflated situations that must be told apart:
 *
 *  - 'failed': at least one real HTTP attempt was made (and its retries, if any, exhausted) without success, WITH a
 *    fair (non-truncated) per-attempt timeout budget throughout. This is genuine evidence the endpoint may be
 *    unhealthy and is what the circuit breaker exists to react to.
 *  - 'not_attempted': the local gate (rate-limit spacing, or the concurrency queue) never handed out a slot before
 *    the logical request's own deadline -- `fetchImpl` was never called. This says something about OUR OWN configured
 *    capacity versus offered load, never about the upstream provider, and must never count toward the circuit.
 *  - 'local_deadline': a slot WAS granted and an HTTP attempt WAS dispatched, but this logical request's own
 *    remaining budget (`maxTotalMs`) left less than a full `timeoutMs` for it, our own abort timer fired first, and
 *    the endpoint never got a fair chance to answer within its normal per-attempt window. Exactly like
 *    'not_attempted', this is never evidence the endpoint is unhealthy -- see the P2 fix in `acquire()`/`tryEndpoint`
 *    below for why this must be judged AFTER the attempt (by whether the timeout window was cut short), not by
 *    refusing the slot up front.
 */
type EndpointOutcome =
  | { kind: 'ok'; response: AttemptResult }
  | { kind: 'failed' }
  | { kind: 'not_attempted' }
  | { kind: 'local_deadline' };

interface Seen {
  rate: boolean;
  timeout: boolean;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return null;
}

export class ProviderGate {
  private readonly states: EndpointState[];
  private readonly shutdownController = new AbortController();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private inFlight = 0;

  constructor(
    private readonly o: ProviderGateOptions,
    private readonly metrics: ProviderMetrics,
    private readonly log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  ) {
    if (o.endpoints.length === 0) throw new Error('ProviderGate needs at least one endpoint');
    this.states = o.endpoints.map((endpoint) => ({
      endpoint,
      host: redactUrl(endpoint.baseUrl),
      nextSlotAt: 0,
      active: 0,
      waiters: [],
      consecutiveFailures: 0,
      openUntil: 0,
      unsupportedUntil: new Map<string, number>(),
    }));
    this.fetchImpl = o.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? realSleep;
    this.random = o.random ?? Math.random;
  }

  /** Logical requests currently in flight (0 after shutdown has drained). */
  get pending(): number {
    return this.inFlight;
  }

  get isShutdown(): boolean {
    return this.shutdownController.signal.aborted;
  }

  /** Aborts every in-flight attempt and wait, and refuses new requests. Idempotent. */
  shutdown(): void {
    if (!this.shutdownController.signal.aborted) this.shutdownController.abort();
  }

  hosts(): string[] {
    return this.states.map((s) => s.host);
  }

  async execute(req: GateRequest): Promise<GateResponse> {
    const kind = this.o.kind;
    this.metrics.inc(kind, 'logicalRequests');
    if (this.isShutdown) {
      this.metrics.inc(kind, 'logicalFailures');
      this.metrics.inc(kind, 'shutdownAborted');
      throw new ProviderError(kind, 'shutdown', `${kind} provider is shut down`, 0, null);
    }
    this.inFlight += 1;
    const startedAt = this.now();
    const deadline = startedAt + this.o.maxTotalMs;
    let attempts = 0;
    const seen: Seen = { rate: false, timeout: false };
    let considered = 0;
    let unsupported = 0;
    let circuit = 0;
    let lastHost: string | null = null;
    try {
      for (let i = 0; i < this.states.length; i += 1) {
        const st = this.states[i] as EndpointState;
        const t = this.now();
        if (st.openUntil > t) {
          this.metrics.inc(kind, 'circuitSkipped');
          circuit += 1;
          continue;
        }
        if (req.rpcMethod && (st.unsupportedUntil.get(req.rpcMethod) ?? 0) > t) {
          unsupported += 1;
          continue;
        }
        considered += 1;
        if (i > 0) this.metrics.inc(kind, 'fallbackUsed');
        lastHost = st.host;
        const out = await this.tryEndpoint(st, req, deadline, () => {
          attempts += 1;
        }, seen);
        if (out.kind === 'ok') {
          st.consecutiveFailures = 0;
          this.metrics.recordProvider(kind, st.host, out.response.asOfMs);
          return { ...out.response, attempts, latencyMs: out.response.asOfMs - startedAt, fromFallback: i > 0 };
        }
        if (this.isShutdown) break;
        // a method the endpoint will never serve is not an outage: it must not trip the circuit for other methods
        const structural = req.rpcMethod !== undefined && (st.unsupportedUntil.get(req.rpcMethod) ?? 0) > this.now();
        if (structural) {
          unsupported += 1;
        } else if (out.kind === 'not_attempted' || out.kind === 'local_deadline') {
          // Either the LOCAL gate never handed this endpoint a slot in time (no HTTP attempt happened), or it did
          // but our own remaining budget cut the attempt's timeout window short before the endpoint got a fair
          // chance to answer. Neither is evidence the endpoint is unhealthy: neither counts toward
          // consecutiveFailures or opens the circuit.
          this.metrics.inc(kind, 'gateCapacityRejected');
        } else {
          st.consecutiveFailures += 1;
          if (st.consecutiveFailures >= this.o.circuitFailureThreshold && st.openUntil <= this.now()) {
            st.openUntil = this.now() + this.o.circuitCooldownMs;
            this.metrics.inc(kind, 'circuitOpened');
            this.log?.warn({ host: st.host, kind }, 'provider circuit opened');
          }
        }
        if (this.now() >= deadline) break;
      }
      this.metrics.inc(kind, 'logicalFailures');
      if (this.isShutdown) {
        this.metrics.inc(kind, 'shutdownAborted');
        throw new ProviderError(kind, 'shutdown', `${kind} request aborted by shutdown`, attempts, lastHost);
      }
      let reason: ProviderFailureReason = 'unavailable';
      if (considered === 0) reason = unsupported > 0 && circuit === 0 ? 'unsupported' : 'circuit_open';
      else if (unsupported >= considered && !seen.rate && !seen.timeout) reason = 'unsupported';
      else if (seen.rate) reason = 'rate_limited';
      else if (seen.timeout) reason = 'timeout';
      else if (this.now() >= deadline) reason = 'deadline_exceeded';
      throw new ProviderError(kind, reason, `${kind} request failed: ${reason}`, attempts, lastHost);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async tryEndpoint(st: EndpointState, req: GateRequest, deadline: number, countAttempt: () => void, seen: Seen): Promise<EndpointOutcome> {
    const kind = this.o.kind;
    const signal = this.shutdownController.signal;
    // Whether at least one HTTP attempt actually happened for this endpoint this logical request. Every early
    // return before this becomes true is therefore 'not_attempted' -- never counted as a failed endpoint interaction.
    let attemptedAtLeastOnce = false;
    const notAttempted = (): EndpointOutcome => (attemptedAtLeastOnce ? { kind: 'failed' } : { kind: 'not_attempted' });
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt += 1) {
      if (signal.aborted) return notAttempted();
      if (attempt > 0) this.metrics.inc(kind, 'retries');
      try {
        if (!(await this.acquire(st, deadline, signal))) return notAttempted();
      } catch {
        return notAttempted();
      }
      attemptedAtLeastOnce = true;
      let outcome: 'ok' | 'retry' | 'giveup' | 'local_deadline';
      let delayMs = 0;
      let response: AttemptResult | null = null;
      countAttempt();
      this.metrics.inc(kind, 'requests');
      this.metrics.endpointInc(st.host, 'requests');
      const t0 = this.now();
      const attemptController = new AbortController();
      let timedOut = false;
      // P2 fix: the per-attempt timeout window this ONE attempt actually gets, clamped to whatever remains of the
      // logical request's own `maxTotalMs` budget. When remaining budget is less than the full configured
      // `timeoutMs`, this attempt is TRUNCATED -- not because the endpoint is slow, but because our own scheduling
      // (rate spacing, concurrency queueing, or earlier retries in this same logical request) already spent some of
      // the budget. See the `timedOut` handling below: whether THIS abort timer firing is treated as genuine
      // provider evidence depends on whether the attempt got a fair (non-truncated) window.
      const effectiveTimeoutMs = Math.max(1, Math.min(this.o.timeoutMs, deadline - t0));
      const budgetTruncated = effectiveTimeoutMs < this.o.timeoutMs;
      const timer = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, effectiveTimeoutMs);
      const onShutdown = (): void => attemptController.abort();
      signal.addEventListener('abort', onShutdown, { once: true });
      try {
        const url = req.path !== undefined ? st.endpoint.baseUrl.replace(/\/+$/, '') + req.path : st.endpoint.baseUrl;
        const res = await this.fetchImpl(url, {
          method: req.method,
          headers: { ...(st.endpoint.headers ?? {}), ...(req.headers ?? {}) },
          ...(req.body !== undefined ? { body: req.body } : {}),
          signal: attemptController.signal,
        });
        const body = await res.text();
        const headers: Record<string, string> = {};
        res.headers.forEach?.((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        const asOfMs = this.now();
        this.metrics.recordLatency(kind, asOfMs - t0);
        if (res.status >= 200 && res.status < 300) {
          this.metrics.inc(kind, 'successes');
          this.metrics.endpointInc(st.host, 'successes');
          response = { status: res.status, headers, body, host: st.host, asOfMs };
          outcome = 'ok';
        } else if (res.status === 429) {
          this.metrics.inc(kind, 'http429');
          this.metrics.inc(kind, 'failures');
          this.metrics.endpointInc(st.host, 'http429');
          this.metrics.endpointInc(st.host, 'failures');
          if (headers['x-ratelimit-method-limit'] === '0' && req.rpcMethod) {
            // The endpoint's limit for this method is 0: it will NEVER serve it on this plan. No retry, no hammering.
            st.unsupportedUntil.set(req.rpcMethod, this.now() + this.o.unsupportedCooldownMs);
            this.metrics.inc(kind, 'unsupported');
            outcome = 'giveup';
          } else {
            seen.rate = true;
            delayMs = parseRetryAfterMs(headers['retry-after'] ?? null, asOfMs) ?? this.backoff(attempt);
            outcome = 'retry';
          }
        } else if (res.status === 403 && req.rpcMethod) {
          st.unsupportedUntil.set(req.rpcMethod, this.now() + this.o.unsupportedCooldownMs);
          this.metrics.inc(kind, 'unsupported');
          this.metrics.inc(kind, 'failures');
          this.metrics.endpointInc(st.host, 'failures');
          outcome = 'giveup';
        } else if (res.status >= 500) {
          this.metrics.inc(kind, 'http5xx');
          this.metrics.inc(kind, 'failures');
          this.metrics.endpointInc(st.host, 'failures');
          delayMs = parseRetryAfterMs(headers['retry-after'] ?? null, asOfMs) ?? this.backoff(attempt);
          outcome = 'retry';
        } else {
          // Other 4xx (bad request, no route, ...): the provider ANSWERED; the caller interprets it. Not a provider failure.
          this.metrics.inc(kind, 'successes');
          this.metrics.endpointInc(st.host, 'successes');
          response = { status: res.status, headers, body, host: st.host, asOfMs };
          outcome = 'ok';
        }
      } catch {
        if (signal.aborted) {
          this.metrics.inc(kind, 'failures');
          this.metrics.endpointInc(st.host, 'failures');
          outcome = 'giveup';
        } else if (timedOut && budgetTruncated) {
          // P2 fix: OUR OWN remaining budget, not the upstream's health, is what cut this attempt short -- it never
          // got the full configured `timeoutMs` to answer in. Never counted as `failures`/`timeouts`, never treated
          // as evidence the endpoint is unhealthy (see EndpointOutcome 'local_deadline' above). A genuine HTTP
          // timeout that DID receive its full budget still falls through to the branch below, unaffected.
          outcome = 'local_deadline';
        } else if (timedOut) {
          this.metrics.inc(kind, 'failures');
          this.metrics.endpointInc(st.host, 'failures');
          this.metrics.inc(kind, 'timeouts');
          this.metrics.endpointInc(st.host, 'timeouts');
          seen.timeout = true;
          delayMs = this.backoff(attempt);
          outcome = 'retry';
        } else {
          // A network error (connection refused, DNS failure, ...) is genuine evidence regardless of how much
          // budget remained -- it does not depend on our own timer, only on the network/endpoint right now.
          this.metrics.inc(kind, 'failures');
          this.metrics.endpointInc(st.host, 'failures');
          this.metrics.inc(kind, 'networkErrors');
          delayMs = this.backoff(attempt);
          outcome = 'retry';
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onShutdown);
        this.release(st);
      }
      if (outcome === 'ok') return { kind: 'ok', response: response as AttemptResult };
      if (outcome === 'local_deadline') return { kind: 'local_deadline' };
      if (outcome === 'giveup') return { kind: 'failed' };
      // retry only if the wait fits in the remaining budget (a Retry-After beyond the budget means: give up on this endpoint)
      if (attempt >= this.o.maxRetries) return { kind: 'failed' };
      if (this.now() + delayMs >= deadline) return { kind: 'failed' };
      try {
        await this.sleep(delayMs, signal);
      } catch {
        return { kind: 'failed' };
      }
    }
    return notAttempted();
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.o.maxBackoffMs, this.o.baseBackoffMs * 2 ** attempt);
    return Math.round(exp * (0.75 + this.random() * 0.5));
  }

  /**
   * Hands out a slot for ONE HTTP attempt, or refuses because there is genuinely no time (or capacity) left before
   * this logical request's own deadline.
   *
   * P2 starvation fix (this replaces an earlier version of this method that ALSO refused a slot whenever less than
   * a full `timeoutMs` remained after waiting on rate-limit spacing or the concurrency queue -- intended to stop a
   * truncated-timeout attempt from looking like a genuine provider failure, Phase 5.6J-adjacent). That check was
   * itself the bug behind a VPS RPC-throughput freeze: under real, sustained contention, a request that has to wait
   * ANY amount for a slot will almost always have less than a full `timeoutMs` left by the time it is granted one --
   * so once contention began, EVERY subsequent waiter self-rejected, no attempt ever completed, no slot was ever
   * genuinely used or freed for reuse, and (compounding it) `st.nextSlotAt` had already been advanced for each of
   * those calls before they rejected themselves, permanently outracing real wall-clock time. The result was a
   * one-way, non-recovering freeze -- confirmed on the VPS: RPC `requests`/`successes` frozen for 15+ minutes while
   * `gateCapacityRejected` absorbed 100% of new demand.
   *
   * The fix moves the "was this a fair test of the endpoint" judgment from HERE (before the attempt, based on a
   * blanket "did you wait" flag) to `tryEndpoint`, AFTER the attempt, based on whether ITS OWN timeout window was
   * actually truncated (`budgetTruncated`, computed from real remaining budget at attempt time, not from whether
   * `acquire()` happened to wait). This method now grants a slot to every caller with any genuine time left --
   * exactly its pre-Phase-5.6J shape -- so a granted slot is ALWAYS used for a real HTTP attempt: `st.active` is
   * always incremented before returning `true` and always properly released afterward (in `tryEndpoint`'s `finally`
   * block), so capacity is never silently lost and the concurrency queue keeps draining even under sustained load.
   */
  private async acquire(st: EndpointState, deadline: number, signal: AbortSignal): Promise<boolean> {
    // Concurrency is secured FIRST; the rate-limit spacing reservation (`st.nextSlotAt`) is committed LAST, only
    // once a concurrency slot is actually in hand -- deliberately reordered from a naive "reserve the rate slot,
    // then wait for concurrency" shape.
    //
    // Reserving a rate-limit slot BEFORE knowing whether a concurrency slot will even become available lets a call
    // that ultimately times out waiting for concurrency still permanently push the shared rate-limit clock ahead of
    // real time -- for a request that never reached the network. Under SUSTAINED overload (offered load exceeding
    // serviceable capacity for an extended period -- e.g. many watched tokens ticking indefinitely, never stopping,
    // exactly the real orchestrator's shape), that drift from purely-phantom reservations compounds without bound:
    // minutes of accumulated drift make the rate-limit clock permanently outrun real time, so EVERY future caller's
    // reserved slot keeps landing beyond its own deadline regardless of how much real capacity is actually free.
    // This is what turns an ordinary, bounded local-scheduling backlog into a one-way, non-recovering freeze (the
    // VPS pattern: RPC `requests`/`successes` frozen for 15+ minutes while `gateCapacityRejected` absorbed 100% of
    // new demand). Committing the rate-limit reservation only once a concurrency slot is genuinely secured keeps
    // that clock truthful: it only ever advances for logical requests that are actually about to dispatch an HTTP
    // attempt, never for phantom reservations behind work that never happened.
    if (st.active >= this.o.maxConcurrent) {
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      const got = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          const i = st.waiters.indexOf(wake);
          if (i >= 0) st.waiters.splice(i, 1);
          resolve(false);
        }, remaining);
        const wake = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        signal.addEventListener('abort', () => wake(), { once: true });
        st.waiters.push(wake);
      });
      if (!got || signal.aborted) return false;
      // Winning the wake-up IS claiming the concurrency slot: commit `st.active` immediately, before any further
      // await, so no other caller can race in and also see room during the rate-limit spacing step below.
      st.active += 1;
    } else {
      st.active += 1;
    }
    let claimed = true; // whether the concurrency slot above still needs to be given back on this path
    try {
      const spacing = this.o.maxRequestsPerSecond > 0 ? 1000 / this.o.maxRequestsPerSecond : 0;
      const t = this.now();
      const slot = Math.max(t, st.nextSlotAt);
      if (slot >= deadline) return false; // rate-limit spacing cannot be honored within what remains of the budget
      st.nextSlotAt = slot + spacing;
      if (slot > t) await this.sleep(slot - t, signal);
      if (signal.aborted) return false;
      claimed = false; // committed: the caller now owns the slot and will `release()` it after the HTTP attempt
      return true;
    } finally {
      // Rate-limit spacing failed, or the wait was aborted: give the concurrency slot straight to the next queued
      // waiter instead of leaving it silently idle -- exactly as if a genuine attempt had just finished.
      if (claimed) this.release(st);
    }
  }

  private release(st: EndpointState): void {
    st.active = Math.max(0, st.active - 1);
    const next = st.waiters.shift();
    if (next) next();
  }
}
