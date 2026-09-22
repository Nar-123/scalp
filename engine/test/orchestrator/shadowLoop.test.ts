import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { AggregatorClient, TokenDiscoverySource } from '../../src/discovery/types.js';
import type { PriceSource, QuoteFetchRecord } from '../../src/execution/types.js';
import { openLedger } from '../../src/ledger/db.js';
import { TradeLedger } from '../../src/ledger/tradeLedger.js';
import { startOrchestrator } from '../../src/orchestrator/loop.js';
import { createShadowActivation } from '../../src/shadow/activation.js';
import type { DiscoveredTokenEvent } from '../../src/types/token.js';

const MINT = 'So11111111111111111111111111111111111111112'; // any valid base58 pubkey

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger } as never;

function baseCfg(shadowEnabled: boolean, filterOverrides: Partial<AppConfig['filters']> = {}): AppConfig {
  const cfg = getDefaultConfig({ shadow: { enabled: shadowEnabled } });
  return { ...cfg, filters: { ...cfg.filters, ...filterOverrides } };
}

interface Harness {
  emit: () => void;
  stop: () => Promise<void>;
  db: ReturnType<typeof openLedger>;
  calls: { impactRequests: number; takeQuote: number; buys: number; safetyRpc: number };
  activation: ReturnType<typeof createShadowActivation>;
}

async function start(opts: {
  shadowEnabled: boolean;
  liquidityVolume?: { liquiditySol: number; volume1mSol: number; buySellRatio: number; txCount1m: number } | null;
  price?: number | null;
  quote?: QuoteFetchRecord | null;
  filters?: Partial<AppConfig['filters']>;
  detectedAtMs?: number;
}): Promise<Harness> {
  const cfg = baseCfg(opts.shadowEnabled, opts.filters);
  const db = openLedger(':memory:');
  const ledger = new TradeLedger(db);
  const calls = { impactRequests: 0, takeQuote: 0, buys: 0, safetyRpc: 0 };
  let onEvent: (e: DiscoveredTokenEvent) => void = noop;

  const source: TokenDiscoverySource = {
    name: 'fake',
    async start(cb) {
      onEvent = cb;
    },
    async stop() {},
  };
  const aggregator: AggregatorClient = {
    getPrice: async () => (opts.price === undefined ? 1 : opts.price),
    getHolderConcentration: async () => null,
    getLiquidityAndVolume: async () =>
      opts.liquidityVolume === undefined ? { liquiditySol: 5, volume1mSol: 1, buySellRatio: 1, txCount1m: 10 } : opts.liquidityVolume,
  };
  const priceSource: PriceSource = {
    getPrice: aggregator.getPrice,
    async getEstimatedPriceImpactPct() {
      calls.impactRequests += 1;
      return opts.quote?.priceImpactPct ?? null;
    },
    async getBuyExecutionQuote() {
      calls.impactRequests += 1;
      return opts.quote && opts.quote.priceImpactPct !== null ? { priceImpactPct: opts.quote.priceImpactPct, tokenAmountRaw: opts.quote.outAmountRaw ?? '1000000' } : null;
    },
    async getSellPriceImpactPct() {
      return opts.quote?.priceImpactPct ?? null;
    },
    takeLastQuoteFetch() {
      calls.takeQuote += 1;
      return opts.quote ?? null;
    },
  };
  const connection = {
    getAccountInfo: async () => {
      calls.safetyRpc += 1;
      return null; // mint account unreadable => RPC failure from the safety gate's point of view
    },
    getTokenLargestAccounts: async () => {
      throw new Error('rpc down');
    },
  };
  const activation = createShadowActivation(cfg, db, logger);

  const stop = await startOrchestrator(cfg, {
    discoverySources: [source],
    aggregator,
    connection: connection as never,
    executor: { buy: async () => { calls.buys += 1; throw new Error('production buy must not run in these tests'); }, sell: async () => { throw new Error('no'); } },
    priceSource,
    jupiterClient: { getRoundTripQuote: async () => null } as never,
    ledger,
    logger,
    shadowRunner: activation?.runner,
  });

  return {
    emit: () =>
      onEvent({
        mint: MINT,
        poolAddress: null,
        source: 'pumpfun',
        createdAtSlot: 1,
        createdAtMs: Date.now() - 60_000,
        initialLiquiditySol: null,
        detectedAtMs: opts.detectedAtMs ?? Date.now() - 59_500,
      }),
    stop,
    db,
    calls,
    activation,
  };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error('timed out waiting for condition');
}

const count = (db: ReturnType<typeof openLedger>, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

let running: Harness | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
  vi.restoreAllMocks();
});

const goodQuote: QuoteFetchRecord = {
  ok: true, startedAtMs: Date.now(), completedAtMs: Date.now(), requestLatencyMs: 42, inAmountLamports: '300000000',
  outAmountRaw: '123456789', priceImpactPct: 0.4, route: 'Raydium', slippageToleranceBps: 100,
};

describe('SHADOW_TRADING_ENABLED=false (default): existing behavior is unchanged', () => {
  it('defaults to disabled and constructs no ShadowRunner', () => {
    expect(getDefaultConfig().shadow.enabled).toBe(false);
    expect(createShadowActivation(baseCfg(false), openLedger(':memory:'), logger)).toBeNull();
  });

  it('runs a tick, records the production evaluation, and never touches the quote-observation path or shadow tables', async () => {
    running = await start({ shadowEnabled: false, quote: goodQuote });
    running.emit();
    await waitFor(() => count(running!.db, 'token_evaluations') === 1);
    expect(running.calls.takeQuote).toBe(0); // nothing observed/retained when shadow is off
    expect(running.calls.impactRequests).toBe(1); // production's own single quote request, as before
    expect(count(running.db, 'shadow_trades') + count(running.db, 'shadow_latency_samples') + count(running.db, 'shadow_health_counters')).toBe(0);
  });
});

describe('SHADOW_TRADING_ENABLED=true', () => {
  it('creates a V1-only read-only runner and logs only the three activation facts', () => {
    const info = vi.fn();
    const activation = createShadowActivation(baseCfg(true), openLedger(':memory:'), { info } as never);
    expect(activation).not.toBeNull();
    expect(activation!.strategyVersion).toBe('baseline-v1');
    const [fields, msg] = info.mock.calls[0]!;
    expect(fields).toEqual({ SHADOW_ENABLED: true, SHADOW_STRATEGY_VERSION: 'baseline-v1', SHADOW_MODE: 'READ_ONLY' });
    expect(msg).toBe('SHADOW_ENABLED=true SHADOW_STRATEGY_VERSION=baseline-v1 SHADOW_MODE=READ_ONLY');
  });

  it('observes the read-only quote already requested (no duplicate request) and records real latency + health', async () => {
    running = await start({ shadowEnabled: true, quote: goodQuote });
    running.emit();
    await waitFor(() => count(running!.db, 'shadow_latency_samples') === 1);

    expect(running.calls.impactRequests).toBe(1); // ONE quote request serves production AND shadow
    expect(running.calls.buys).toBe(0);
    const counters = running.activation!.ledger.getCounters();
    expect(counters.shadow_ticks_received).toBe(1);
    expect(counters.quote_success).toBe(1);
    expect(counters.aggregator_success).toBe(2);
    expect(counters.market_data_success).toBe(1);

    const sample = running.activation!.ledger.getRecentLatencySamples(0)[0]!;
    expect(sample.discoveryLatencyMs).toBeGreaterThan(400); // detectedAt - createdAt = 500ms, NOT the 60s token age
    expect(sample.discoveryLatencyMs).toBeLessThan(2000);
    expect(sample.marketDataLatencyMs).not.toBeNull();
    expect(sample.quoteTimeMs).not.toBeNull();
    expect(sample.shadowProcessingLatencyMs).not.toBeNull();
  });

  it('records a quote failure as a warning, keeps the tick, and falls back to the assumed impact (never a fabricated quote)', async () => {
    running = await start({ shadowEnabled: true, quote: { ...goodQuote, ok: false, priceImpactPct: null, outAmountRaw: null, route: null } });
    running.emit();
    await waitFor(() => count(running!.db, 'shadow_latency_samples') === 1);
    const counters = running.activation!.ledger.getCounters();
    expect(counters.quote_error).toBe(1);
    const dq = running.activation!.ledger.getRecentDataQualityEvents(0);
    expect(dq.some((e) => e.kind === 'missing_quote' && e.severity === 'warning')).toBe(true);
  });

  it('records missing market data (aggregator error) without manufacturing a signal', async () => {
    running = await start({ shadowEnabled: true, liquidityVolume: null, price: null });
    running.emit();
    await waitFor(() => count(running!.db, 'shadow_latency_samples') === 1);
    const counters = running.activation!.ledger.getCounters();
    expect(counters.aggregator_error).toBe(2);
    expect(counters.market_data_error).toBe(1);
    expect(counters.missing_market_data).toBe(1);
    expect(count(running.db, 'shadow_trades')).toBe(0);
    expect(running.activation!.ledger.getRecentDataQualityEvents(0).some((e) => e.kind === 'aggregator_error')).toBe(true);
  });

  it('counts an RPC failure from the safety gate and rejects the entry on safety', async () => {
    const loose = { minLiquiditySol: 0, minVolume1mSol: 0, minBuySellRatio: 0, minPriceVelocity5sPct: -1000, minVolumeAccelerationX: 0, maxPriceImpactPct: 1000 };
    running = await start({
      shadowEnabled: true,
      filters: loose,
      liquidityVolume: { liquiditySol: 50, volume1mSol: 20, buySellRatio: 3, txCount1m: 60 },
      quote: goodQuote,
    });
    running.emit();
    await waitFor(() => count(running!.db, 'shadow_latency_samples') === 1);
    expect(running.calls.safetyRpc).toBeGreaterThan(0);
    expect(running.activation!.ledger.getCounters().rpc_error).toBe(1);
    expect(count(running.db, 'shadow_trades')).toBe(0); // safety unconfirmed => shadow never enters
  });

  it('never writes production tables from shadow (only production\'s own evaluation row exists)', async () => {
    running = await start({ shadowEnabled: true, quote: goodQuote });
    running.emit();
    await waitFor(() => count(running!.db, 'shadow_latency_samples') === 1);
    await waitFor(() => count(running!.db, 'token_evaluations') === 1);
    expect(count(running.db, 'trades')).toBe(0);
    expect(count(running.db, 'daily_risk_state')).toBe(0);
  });
});
