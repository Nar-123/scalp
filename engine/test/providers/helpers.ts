import { ProviderGate, type FetchLike, type ProviderGateOptions } from '../../src/providers/providerGate.js';
import { ProviderMetrics } from '../../src/providers/providerMetrics.js';

export interface FakeResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** never resolves (until aborted) */
  hang?: boolean;
  /** rejects with a network error */
  throws?: boolean;
}

export function makeResponse(r: FakeResponse) {
  const h = r.headers ?? {};
  return {
    status: r.status ?? 200,
    headers: {
      get: (n: string) => h[n.toLowerCase()] ?? null,
      forEach: (cb: (v: string, k: string) => void) => Object.entries(h).forEach(([k, v]) => cb(v, k)),
    },
    text: async () => r.body ?? '{}',
  };
}

export interface FakeFetch {
  fn: FetchLike;
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
}

/** `script` maps a call (index, url) to a response; a function lets a test vary by URL. */
export function fakeFetch(script: FakeResponse[] | ((i: number, url: string) => FakeResponse)): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const fn: FetchLike = (url, init) => {
    const i = calls.length;
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const r = typeof script === 'function' ? script(i, url) : (script[Math.min(i, script.length - 1)] as FakeResponse);
    if (r.hang) {
      return new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
    }
    if (r.throws) return Promise.reject(new Error('ECONNRESET'));
    return Promise.resolve(makeResponse(r));
  };
  return { fn, calls };
}

export const instantSleep = async (): Promise<void> => undefined;

export function gate(over: Partial<ProviderGateOptions> & { fetchImpl: FetchLike }, metrics = new ProviderMetrics()): { gate: ProviderGate; metrics: ProviderMetrics } {
  const g = new ProviderGate(
    {
      kind: 'rpc',
      endpoints: [{ baseUrl: 'https://primary.example/KEYSEGMENT1234567890?api-key=SECRETKEY123' }],
      timeoutMs: 200,
      maxConcurrent: 4,
      maxRequestsPerSecond: 1000,
      maxRetries: 2,
      baseBackoffMs: 1,
      maxBackoffMs: 4,
      maxTotalMs: 2000,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 60_000,
      unsupportedCooldownMs: 600_000,
      sleep: instantSleep,
      random: () => 0.5,
      ...over,
    },
    metrics,
  );
  return { gate: g, metrics };
}
