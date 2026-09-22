import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import {
  SOL_USD_SANITY_MAX,
  WSOL_MINT,
  deriveSolUsdReference,
  interpretPair,
  isTokenSolPair,
  pickTokenSolPair,
  type DexscreenerPair,
} from '../../src/discovery/dexscreenerUnits.js';
import { collectBaselineFilterFailures } from '../../src/orchestrator/baselineFilters.js';

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: (...args: unknown[]) => requestMock(...args) }));
const { DexscreenerBirdeyeAggregator } = await import('../../src/discovery/aggregatorFallbackClient.js');

function fixture(name: string): { pairs: DexscreenerPair[] } {
  return JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'));
}

// Real captured responses (see _meta in each file).
const IKUN_MINT = 'DC5XoBN2qE2DXzkLANSUzE2bBiFzVj9jDkcRXSuvpump';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ikun = fixture('dexscreener_token_sol_pumpswap.json');
const jup = fixture('dexscreener_token_usdc_and_sol.json');
const cfg = getDefaultConfig();

/** What the code did BEFORE Phase 5.2, reproduced only to demonstrate the bug on a real payload. */
function legacyInterpretation(pair: DexscreenerPair) {
  return { liquiditySol: pair.liquidity!.base!, volume1mSol: pair.volume!.m5! / 5 };
}

describe('real fixture: TOKEN/SOL pair (IKUN on pumpswap)', () => {
  const pair = ikun.pairs[0]!;

  it('demonstrates the original bug: liquidity.base is a token amount, liquidity.quote is the SOL side', () => {
    expect(pair.liquidity!.base).toBe(991_688_175);
    expect(pair.liquidity!.quote).toBe(0.3054);
    const legacy = legacyInterpretation(pair);
    expect(legacy.liquiditySol).toBe(991_688_175); // the bug: a token count labelled SOL
    // ...which sailed through the >=20 SOL filter although the pool holds 0.3054 SOL:
    const failuresLegacy = collectBaselineFilterFailures({ liquiditySol: legacy.liquiditySol, volume1mSol: 10, buySellRatio: 3 }, 5, 2, 0.2, cfg);
    expect(failuresLegacy).not.toContain('liquidity_below_minimum');
  });

  it('A. reads liquiditySol from liquidity.quote, NOT liquidity.base', () => {
    const r = interpretPair(pair, IKUN_MINT)!;
    expect(r.liquiditySol).toBe(0.3054);
    expect(r.liquiditySol).not.toBe(991_688_175);
    const failures = collectBaselineFilterFailures({ liquiditySol: r.liquiditySol!, volume1mSol: 10, buySellRatio: 3 }, 5, 2, 0.2, cfg);
    expect(failures).toContain('liquidity_below_minimum'); // the 20 SOL threshold now sees SOL
  });

  it('B. converts USD volume to SOL with the same-response reference (priceUsd / priceNative)', () => {
    const r = interpretPair(pair, IKUN_MINT)!;
    const solUsd = Number(pair.priceUsd) / Number(pair.priceNative);
    expect(r.solUsdReference).toBeCloseTo(solUsd, 6);
    expect(solUsd).toBeGreaterThan(100);
    expect(solUsd).toBeLessThan(120);
    expect(r.volume5mSol).toBeCloseTo(pair.volume!.m5! / solUsd, 6);
    expect(r.volume5mSol).toBeLessThan(pair.volume!.m5!); // SOL amount is far smaller than the USD figure
  });

  it('E. 5m volume can never populate volume1mSol (no 1-minute source exists)', () => {
    const r = interpretPair(pair, IKUN_MINT)!;
    expect(r.volume1mSol).toBeNull();
    expect(r.volume5mSol).not.toBeNull(); // the 5m figure exists but stays in its own field
  });

  it('price is priceNative of the TOKEN/SOL pair; buySellRatio is a same-window count ratio', () => {
    const r = interpretPair(pair, IKUN_MINT)!;
    expect(r.priceSol).toBe(Number(pair.priceNative));
    expect(r.buySellRatio).toBeCloseTo(pair.txns!.m5!.buys! / pair.txns!.m5!.sells!, 10);
    expect(r.txWindow).toBe('m5');
  });

  it('picks the eligible pair with the largest SOL-side liquidity (the second pair has no liquidity object)', () => {
    expect(pickTokenSolPair(ikun.pairs, IKUN_MINT)!.dexId).toBe('pumpswap');
  });
});

describe('real fixture: TOKEN/USDC and TOKEN/SOL pairs of the same token (JUP)', () => {
  const [usdcPair, solPair] = jup.pairs as [DexscreenerPair, DexscreenerPair];

  it('D. a TOKEN/USDC pair is not TOKEN/SOL, so its USDC liquidity is never interpreted as SOL', () => {
    expect(usdcPair.quoteToken!.address).toBe(USDC_MINT);
    expect(usdcPair.liquidity!.quote).toBeGreaterThan(solPair.liquidity!.quote!); // 8200 USDC > 2287 SOL: a naive max-by-quote would pick USDC
    expect(isTokenSolPair(usdcPair, JUP_MINT)).toBe(false);
    expect(interpretPair(usdcPair, JUP_MINT)).toBeNull();
    expect(pickTokenSolPair(jup.pairs, JUP_MINT)).toBe(solPair);
    expect(interpretPair(solPair, JUP_MINT)!.liquiditySol).toBeCloseTo(2287.8663, 4);
  });

  it('D. with ONLY a USDC pair available, everything is unavailable (fail closed)', () => {
    expect(pickTokenSolPair([usdcPair], JUP_MINT)).toBeNull();
  });

  it('a pair is TOKEN/SOL only if the requested mint is the BASE token (a reversed SOL/TOKEN pair is not trusted)', () => {
    const reversed: DexscreenerPair = { ...solPair, baseToken: solPair.quoteToken, quoteToken: solPair.baseToken };
    expect(isTokenSolPair(reversed, JUP_MINT)).toBe(false);
    expect(isTokenSolPair({ ...solPair, quoteToken: undefined }, JUP_MINT)).toBe(false); // unknown quote asset != SOL
    expect(isTokenSolPair({ ...solPair, quoteToken: { address: undefined } }, JUP_MINT)).toBe(false);
  });
});

describe('C. an unproven SOL/USD reference makes converted volume unavailable, never invented', () => {
  const base = ikun.pairs[0]!;
  const cases: Array<[string, Partial<DexscreenerPair>]> = [
    ['missing priceUsd', { priceUsd: undefined }],
    ['missing priceNative', { priceNative: undefined }],
    ['zero priceNative', { priceNative: '0' }],
    ['non-numeric priceUsd', { priceUsd: 'abc' }],
    ['absurd ratio above sanity bound', { priceUsd: String(SOL_USD_SANITY_MAX * 1000 * Number(base.priceNative)) }],
  ];
  it.each(cases)('%s => volume5mSol null', (_name, override) => {
    const pair = { ...base, ...override };
    expect(deriveSolUsdReference(pair)).toBeNull();
    const r = interpretPair(pair, IKUN_MINT)!;
    expect(r.volume5mSol).toBeNull();
    expect(r.volume1mSol).toBeNull();
    expect(r.liquiditySol).toBe(0.3054); // liquidity does not depend on the USD reference
  });

  it('missing SOL-side liquidity => liquiditySol null (never falls back to base or usd)', () => {
    const r = interpretPair({ ...base, liquidity: { base: 991_688_175, usd: 705.2 } }, IKUN_MINT)!;
    expect(r.liquiditySol).toBeNull();
  });
});

describe('aggregator end to end on the real fixtures (mocked transport)', () => {
  function respond(body: unknown) {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ statusCode: 200, body: { json: async () => body } });
  }

  it('returns 0.3054 SOL liquidity (not 991,688,175), unavailable 1m volume, and a SOL price', async () => {
    respond(ikun);
    const agg = new DexscreenerBirdeyeAggregator(cfg.aggregators);
    const lv = await agg.getLiquidityAndVolume(IKUN_MINT);
    expect(lv!.liquiditySol).toBe(0.3054);
    expect(lv!.volume1mSol).toBeNull();
    expect(lv!.volume5mSol).toBeGreaterThan(0);
    expect(await agg.getPrice(IKUN_MINT)).toBe(Number(ikun.pairs[0]!.priceNative));
  });

  it('prefers the SOL pair for JUP and never returns the USDC pair values', async () => {
    respond(jup);
    const agg = new DexscreenerBirdeyeAggregator(cfg.aggregators);
    const lv = await agg.getLiquidityAndVolume(JUP_MINT);
    expect(lv!.liquiditySol).toBeCloseTo(2287.8663, 4);
    expect(await agg.getPrice(JUP_MINT)).toBe(0.002502); // priceNative of the SOL pair, not 0.2722 (USDC)
  });

  it('returns null liquidity AND null price when only a USDC pair exists', async () => {
    respond({ pairs: [jup.pairs[0]] });
    const agg = new DexscreenerBirdeyeAggregator(cfg.aggregators);
    expect(await agg.getLiquidityAndVolume(JUP_MINT)).toBeNull();
    expect(await agg.getPrice(JUP_MINT)).toBeNull(); // 0.2722 is USDC per JUP, not SOL
  });

  it('returns null for a pair that does not identify its assets', async () => {
    respond({ pairs: [{ liquidity: { base: 5, quote: 40, usd: 4000 }, volume: { m5: 50 } }] });
    const agg = new DexscreenerBirdeyeAggregator(cfg.aggregators);
    expect(await agg.getLiquidityAndVolume(IKUN_MINT)).toBeNull();
  });
});

describe('H. V1 thresholds are unchanged by the unit fix', () => {
  it('filters match the finalized V1 values exactly', () => {
    expect(cfg.filters).toEqual({
      minLiquiditySol: 20,
      minVolume1mSol: 5,
      minBuySellRatio: 1.5,
      minPriceVelocity5sPct: 1,
      minVolumeAccelerationX: 1.5,
      maxPriceImpactPct: 1,
    });
    expect(cfg.discovery.minTokenAgeSec).toBe(30);
    expect(cfg.discovery.maxTokenAgeSec).toBe(15 * 60);
    expect(cfg.exits.quickTpMinPct).toBe(2);
    expect(cfg.exits.maxHoldTimeSec).toBe(30);
  });

  it('a value that is really >= the thresholds in SOL still passes; unavailable volume can never pass', () => {
    expect(collectBaselineFilterFailures({ liquiditySol: 20, volume1mSol: 5, buySellRatio: 1.5 }, 1, 1.5, 1, cfg)).toEqual([]);
    expect(collectBaselineFilterFailures({ liquiditySol: 20, volume1mSol: null, buySellRatio: 1.5 }, 1, null, 1, cfg)).toEqual([
      'volume_1m_unavailable',
      'volume_acceleration_unavailable',
    ]);
  });

  it('WSOL constant is the wrapped-SOL mint', () => {
    expect(WSOL_MINT).toBe('So11111111111111111111111111111111111111112');
  });
});
