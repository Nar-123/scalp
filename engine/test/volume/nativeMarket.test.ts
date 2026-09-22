import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { collectBaselineFilterFailures } from '../../src/orchestrator/baselineFilters.js';
import { decideMarketSource } from '../../src/orchestrator/marketSourcePolicy.js';
import { NativeFirstAggregator, NativeFirstPriceSource } from '../../src/orchestrator/nativeFirst.js';
import { buyPriceImpactPct, entryNetLamports, realSolLiquidity, spotPriceSol } from '../../src/volume/bondingCurveMath.js';
import { PumpfunVolumeEngine } from '../../src/volume/pumpfunVolumeEngine.js';
import type { NativeMarketSnapshot } from '../../src/volume/types.js';
import { BASE_TS, CurveSim, Feed, at, mintId } from './helpers.js';

const M = mintId(5);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ENTRY = 0.3;

function healthy(until = BASE_TS + 200, options = {}): Feed {
  const f = new Feed(options);
  f.pace(BASE_TS, until);
  return f;
}

/** A token on a valid standard curve: created at `createdTs`, then a chain of curve trades. Returns the sim (final state). */
function launch(f: Feed, mint: string, createdTs: number, trades: Array<{ ts: number; buySol?: number; sellTokens?: bigint }>): CurveSim {
  const sim = new CurveSim();
  f.create(mint, createdTs);
  for (const t of trades) {
    const step = t.buySol !== undefined ? sim.buy(BigInt(Math.round(t.buySol * 1e9))) : sim.sell(t.sellTokens as bigint);
    f.curveTrade(mint, step, t.ts);
  }
  return sim;
}

describe('native market snapshot (one coherent, single-source observation)', () => {
  it('G/I/J/K: price, liquidity and exact 0.3 SOL price impact come from the LATEST curve state', () => {
    const f = healthy();
    // A final small trade at +200 keeps M within the default 5 s per-token freshness bound of the +201 query (see
    // the P1 fix in resolveCurve) -- it is now the last trade that changed the curve, so stateEventSec reflects it.
    const sim = launch(f, M, BASE_TS + 100, [
      { ts: BASE_TS + 110, buySol: 1.0 },
      { ts: BASE_TS + 130, buySol: 2.5 },
      { ts: BASE_TS + 160, sellTokens: 20_000_000_000_000n },
      { ts: BASE_TS + 190, buySol: 0.6 },
      { ts: BASE_TS + 200, buySol: 0.05 },
    ]);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201));
    expect(s.quality).toBe('VALID');
    expect(s.reason).toBeNull();
    expect(s.source).toBe('pumpfun_native');
    expect(s.priceSol).toBeCloseTo(spotPriceSol(sim.vs, sim.vt)!, 18);
    expect(s.liquiditySol).toBeCloseTo(realSolLiquidity(sim.rs), 12); // REAL SOL, not the 30+ SOL virtual reserve
    expect(s.liquiditySol).toBeLessThan(Number(sim.vs) / 1e9 - 29.9);
    const net = entryNetLamports(300_000_000n, 95, 30);
    expect(s.priceImpactPct).toBeCloseTo(buyPriceImpactPct({ virtualSolReserves: sim.vs, virtualTokenReserves: sim.vt, realTokenReserves: sim.rt }, net)!, 12);
    expect(s.curve).toMatchObject({ virtualSolReserves: sim.vs.toString(), realSolReserves: sim.rs.toString(), feeBasisPoints: 95, creatorFeeBasisPoints: 30 });
    expect(s.stateEventSec).toBe(BASE_TS + 200); // the last trade that changed the curve
    expect(s.marketDataAsOfSec).toBe(BASE_TS + 201); // the stream watermark
    expect(s.volumeWindowEndSec).toBe(BASE_TS + 200);
    expect(s.skewSec).toBe(1);
  });

  it('U: volume, acceleration, buy/sell ratio and tx count come from the same engine windows', () => {
    const f = healthy();
    // A final trade at +200 keeps M within the default 5 s freshness bound of the +201 query. It lands inside the
    // SAME current window (141..200) as the other current-window trades, so it is a 4th counted trade (3 buys / 1
    // sell) -- txCount1m/buySellRatio below reflect that honestly, updated from the pre-fix numbers.
    launch(f, M, BASE_TS + 100, [
      { ts: BASE_TS + 110, buySol: 2 }, // previous window (T-119..T-60 = 81..140)
      { ts: BASE_TS + 130, buySol: 2 },
      { ts: BASE_TS + 150, buySol: 3 }, // current window (141..200)
      { ts: BASE_TS + 160, buySol: 3 },
      { ts: BASE_TS + 170, sellTokens: 50_000_000_000_000n },
      { ts: BASE_TS + 200, buySol: 1 },
    ]);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201));
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(s.volume1mSol).toBe(v.volume1mSol);
    expect(s.volumeAccelerationX).toBe(v.volumeAccelerationX);
    expect(s.previousVolume1mSol).toBe(v.previousVolume1mSol);
    expect(s.txCount1m).toBe(4);
    expect(s.buySellRatio).toBe(3); // 3 buys / 1 sell (counts, like the DexScreener path)
    expect(s.volumeCoverage.status).toBe('COMPLETE');
    expect(s.volumeAccelerationX).toBeGreaterThan(0);
  });

  it('buy/sell ratio: only buys => +Infinity (degenerate_ratio path), only sells => 0, no trades => null (unavailable)', () => {
    // Queries close to whichever trade is actually LAST for each case (within the default 5 s freshness bound),
    // instead of a single fixed +201 shared by all three -- the original shared query time left M's curve up to
    // 100 s stale for the (0,0) case, which this file's P1 per-token freshness fix now (correctly) catches.
    // healthy(until) paces the pacer mint through `until` BEFORE any of M's trades below, so the watermark ends up
    // at `until` regardless of M's own timestamps; keeping `until` close to M's last real trade is what keeps M
    // fresh.
    const only = (buys: number, sells: number): NativeMarketSnapshot => {
      const lastTradeTs = buys > 0 ? BASE_TS + 150 + buys - 1 : sells > 0 ? BASE_TS + 160 + sells - 1 : BASE_TS + 101;
      // (0,0) is deliberately queried far (100 s) from its only (establishing) trade -- see the comment below on
      // that case: it must stay genuinely stale, not be nudged fresh, or it stops proving "zero trades" at all.
      const queryTs = buys === 0 && sells === 0 ? lastTradeTs + 100 : lastTradeTs + 2; // well within the 5 s bound
      const f = healthy(queryTs);
      const sim = new CurveSim();
      f.create(M, BASE_TS + 100);
      f.curveTrade(M, sim.buy(3_000_000_000n), BASE_TS + 101); // establishes the curve long before the window
      for (let i = 0; i < buys; i += 1) f.curveTrade(M, sim.buy(100_000_000n), BASE_TS + 150 + i);
      for (let i = 0; i < sells; i += 1) f.curveTrade(M, sim.sell(1_000_000_000_000n), BASE_TS + 160 + i);
      return f.engine.getNativeMarketSnapshot(M, ENTRY, at(queryTs));
    };
    expect(only(3, 0).buySellRatio).toBe(Number.POSITIVE_INFINITY);
    expect(only(0, 2).buySellRatio).toBe(0);
    // 0 buys/0 sells cannot be fixed the same way as the two cases above: "prove zero trades in the last 60 s" and
    // "the curve's last trade is within the freshness bound" are LOGICALLY incompatible for a single-trade curve --
    // a trade recent enough to be fresh is, by definition, inside the current 60 s window, and a trade old enough
    // to be excluded from it is far outside any reasonable freshness bound. There is no fixture fix for this one:
    // a token that provably has not traded in 60+ s is exactly the "gone quiet" case this file's P1 per-token
    // freshness fix exists to catch, so the correct answer is TIMESTAMP_SKEW, not "VALID with an undefined ratio".
    const noTrades = only(0, 0);
    expect(noTrades.quality).toBe('TIMESTAMP_SKEW');
    expect(noTrades.buySellRatio).toBeNull();
    expect(noTrades.volume1mSol).toBeNull();
  });

  it('L: an entry that would exhaust the curve has no price impact (null), while price and liquidity stay valid', () => {
    const f = healthy();
    // A second, negligible trade close to the query time keeps the curve state FRESH (see the P1 per-token
    // freshness fix in resolveCurve) without materially changing the reserves the exhaustion/impact assertions
    // below read -- `sim` reflects both trades, so they stay self-consistent with whatever the curve actually is.
    const sim = launch(f, M, BASE_TS + 100, [{ ts: BASE_TS + 110, buySol: 1 }, { ts: BASE_TS + 200, buySol: 0.0001 }]);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const s = f.engine.getNativeMarketSnapshot(M, 10_000, at(BASE_TS + 201)); // 10,000 SOL >> the tokens left
    expect(s.quality).toBe('VALID');
    expect(s.priceImpactPct).toBeNull();
    expect(s.priceSol).toBeCloseTo(spotPriceSol(sim.vs, sim.vt)!, 18);
  });

  it('M: graduation => GRADUATED with price = null and liquidity = null (never 0, never the stale curve value)', () => {
    const f = healthy();
    launch(f, M, BASE_TS + 100, [{ ts: BASE_TS + 150, buySol: 5 }]);
    f.graduate(M, BASE_TS + 160);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201));
    expect(s).toMatchObject({ quality: 'GRADUATED', reason: 'graduated', priceSol: null, liquiditySol: null, priceImpactPct: null, volume1mSol: null, volumeAccelerationX: null });
  });

  it('N: a token with no curve state yet is UNAVAILABLE (a created token with no trade)', () => {
    const f = healthy();
    f.create(M, BASE_TS + 100);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201));
    expect(s).toMatchObject({ quality: 'UNAVAILABLE', reason: 'no_curve_state', priceSol: null, liquiditySol: null });
  });

  it('mint never observed => UNAVAILABLE (mint_not_observed), not zero', () => {
    const f = healthy();
    expect(f.engine.getNativeMarketSnapshot(mintId(999), ENTRY, at(BASE_TS + 200))).toMatchObject({ quality: 'UNAVAILABLE', reason: 'mint_not_observed', priceSol: null });
  });

  it('a non-SOL curve is unavailable (native SOL price/liquidity would be meaningless)', () => {
    const f = healthy();
    f.create(M, BASE_TS + 100, USDC);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201))).toMatchObject({ quality: 'UNAVAILABLE', reason: 'non_sol_quote', priceSol: null });
  });

  it('mayhem-mode curves are unsupported: never priced with the standard formula', () => {
    const f = healthy();
    const sim = new CurveSim();
    f.create(M, BASE_TS + 100);
    f.curveTrade(M, sim.buy(1_000_000_000n), BASE_TS + 150, { curve: { ...sim.post(), mayhem: true } });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201))).toMatchObject({ quality: 'UNAVAILABLE', reason: 'unsupported_mayhem_curve', priceSol: null, liquiditySol: null });
  });

  it('an event whose reserves do not belong to its amounts is MALFORMED (never used)', () => {
    const f = healthy();
    const sim = new CurveSim();
    f.create(M, BASE_TS + 100);
    const step = sim.buy(1_000_000_000n);
    f.curveTrade(M, { ...step, tokenAmount: step.tokenAmount / 2n }, BASE_TS + 150); // amount inconsistent with the reserves
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201))).toMatchObject({ quality: 'MALFORMED', reason: 'curve_step_inconsistent', priceSol: null });
  });

  it('O: after a stream break the old state is STALE (it may have changed in the gap) until the token trades again', () => {
    const f = healthy();
    const sim = launch(f, M, BASE_TS + 100, [{ ts: BASE_TS + 150, buySol: 2 }]);
    f.engine.markDisconnected('stream_disconnected', (BASE_TS + 201) * 1000);
    f.engine.markReconnected((BASE_TS + 202) * 1000);
    f.pace(BASE_TS + 202, BASE_TS + 320);
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 320))).toMatchObject({ quality: 'STALE', reason: 'token_state_unproven', priceSol: null });
    f.curveTrade(M, sim.buy(500_000_000n), BASE_TS + 321); // any trade re-proves the curve AND re-anchors the state
    f.pace(BASE_TS + 322, BASE_TS + 322);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 322));
    expect(s.quality).toBe('VALID');
    expect(s.priceSol).toBeCloseTo(spotPriceSol(sim.vs, sim.vt)!, 18);
  });

  it('O: a stream that fell behind the wall clock is STALE (watermark_stale), a disconnected stream UNAVAILABLE', () => {
    const f = healthy(BASE_TS + 200, { silenceMs: 1e9 });
    launch(f, M, BASE_TS + 100, [{ ts: BASE_TS + 150, buySol: 2 }]);
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 200) + 120_000)).toMatchObject({ quality: 'STALE', reason: 'watermark_stale', priceSol: null });
    f.engine.markDisconnected('stream_disconnected', (BASE_TS + 201) * 1000);
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201))).toMatchObject({ quality: 'UNAVAILABLE', reason: 'stream_disconnected', priceSol: null });
  });

  it('P: a price/liquidity state further from the volume window than the configured skew is TIMESTAMP_SKEW (all fields null)', () => {
    const f = healthy(BASE_TS + 200, { maxSnapshotSkewSec: 0 }); // the natural 1 s (watermark vs settled window end) now exceeds the limit
    launch(f, M, BASE_TS + 100, [{ ts: BASE_TS + 150, buySol: 2 }]);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 200));
    expect(s).toMatchObject({ quality: 'TIMESTAMP_SKEW', reason: 'timestamp_skew', priceSol: null, liquiditySol: null, volume1mSol: null });
    // With maxSnapshotSkewSec: 0, the P1 per-token freshness check (M's own last trade, ts=150, is 50s behind the
    // watermark) now rejects inside resolveCurve BEFORE the snapshot-specific volume-window `skewSec` (which would
    // have been 1) is ever computed -- see the 'G/I/J/K' test above for that value still being reported when the
    // per-token check does NOT fire first (a fresh curve, well under the default 5 s bound).
    expect(s.skewSec).toBeNull();
    // The DEFAULT bound (5 s, unchanged production value): a fresh curve is VALID. A trade close to the query time
    // (instead of the original, now-stale ts=150) is what makes it fresh -- the bound itself is not widened.
    const ok = healthy(BASE_TS + 200);
    launch(ok, M, BASE_TS + 100, [{ ts: BASE_TS + 150, buySol: 2 }, { ts: BASE_TS + 199, buySol: 0.01 }]);
    expect(ok.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 200)).quality).toBe('VALID');
  });

  it('a slot-mates pair arriving in reverse order does not replace the newer state; a genuinely missing trade re-anchors and is counted', () => {
    const f = healthy();
    const sim = new CurveSim();
    f.create(M, BASE_TS + 100);
    const a = sim.buy(1_000_000_000n);
    const b = sim.buy(500_000_000n);
    f.curveTrade(M, b, BASE_TS + 150, {}, 777_000); // the LATER trade arrives first...
    f.curveTrade(M, a, BASE_TS + 150, {}, 777_000); // ...then its predecessor, in the SAME slot
    // A normal follow-up trade at +200 keeps M within the default 5 s freshness bound of the +201 query; it chains
    // forward from b's (the true latest) reserves, so `sim` after it is still the correct on-chain state to assert.
    // Slot must be >= b/a's pinned 777_000 (a lower slot, like the Feed's own auto-incrementing default, would be
    // read as a stale/out-of-order event and discarded, exactly like `curveStaleEvents` above).
    const c = sim.buy(200_000_000n);
    f.curveTrade(M, c, BASE_TS + 200, {}, 777_001);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 201));
    expect(s.priceSol).toBeCloseTo(spotPriceSol(sim.vs, sim.vt)!, 18); // state = after b, then c (the true latest)
    const missing = healthy();
    const breaksBefore = missing.engine.stats.curveChainBreaks; // the pacer mint's own (inconsistent) events are counted too
    const linksBefore = missing.engine.stats.curveChainLinks;
    const sim2 = new CurveSim();
    missing.create(M, BASE_TS + 100);
    missing.curveTrade(M, sim2.buy(1_000_000_000n), BASE_TS + 150);
    sim2.buy(700_000_000n); // this trade is never delivered
    missing.curveTrade(M, sim2.buy(300_000_000n), BASE_TS + 160);
    expect(missing.engine.stats.curveChainBreaks - breaksBefore).toBe(1);
    expect(missing.engine.stats.curveChainLinks - linksBefore).toBe(0);
  });
});

describe('source priority (marketSourcePolicy)', () => {
  const snap = (quality: NativeMarketSnapshot['quality'], reason: NativeMarketSnapshot['reason'] = null): NativeMarketSnapshot => ({
    source: 'pumpfun_native', quality, reason, priceSol: null, liquiditySol: null, priceImpactPct: null, entrySizeSol: 0.3, volume1mSol: null, previousVolume1mSol: null,
    volumeAccelerationX: null, buySellRatio: null, txCount1m: null, buyTokenAmountRaw: null, sellPriceImpactPct: null, buyVolume1mSol: null, sellVolume1mSol: null, volumeCoverage: { status: 'UNKNOWN', reason: 'ok', currentWindowCovered: false, previousWindowCovered: false },
    curve: null, marketDataAsOfSec: null, stateEventSec: null, stateSlot: null, volumeWindowEndSec: null, watermarkSec: null, skewSec: null,
  });

  it('R: a VALID native snapshot is authoritative for a Pump.fun token', () => {
    expect(decideMarketSource(snap('VALID'), { discoverySource: 'pumpfun' }).route).toBe('native');
  });

  it('S/T: for a Pump.fun token, every non-VALID native state is unavailable (no silent DexScreener), except graduation', () => {
    for (const [q, r] of [['UNAVAILABLE', 'no_curve_state'], ['UNAVAILABLE', 'mint_not_observed'], ['UNAVAILABLE', 'stream_disconnected'], ['STALE', 'token_state_unproven'], ['MALFORMED', 'curve_step_inconsistent'], ['TIMESTAMP_SKEW', 'timestamp_skew'], ['UNAVAILABLE', 'unsupported_mayhem_curve']] as const) {
      const d = decideMarketSource(snap(q, r), { discoverySource: 'pumpfun' });
      expect(d.route, `${q}/${r}`).toBe('unavailable');
      expect(d.reason).toBe(`native_${r}`);
    }
    expect(decideMarketSource(snap('GRADUATED', 'graduated'), { discoverySource: 'pumpfun' }).route).toBe('dexscreener');
  });

  it('T: DexScreener is the fallback only when explicitly enabled', () => {
    expect(decideMarketSource(snap('UNAVAILABLE', 'no_curve_state'), { discoverySource: 'pumpfun', allowDexscreenerFallback: true }).route).toBe('dexscreener');
  });

  it('a non-Pump.fun token (e.g. Raydium) never uses native data, even if a snapshot exists', () => {
    expect(decideMarketSource(snap('VALID'), { discoverySource: 'raydium' }).route).toBe('dexscreener');
  });

  it('no native provider configured: behavior is the pre-5.5 DexScreener path', () => {
    expect(decideMarketSource(null, { discoverySource: 'pumpfun' }).route).toBe('dexscreener');
  });
});

describe('the new-token flow (no DexScreener pair)', () => {
  it('created -> ~50 s old -> still on the curve -> native price/liquidity/impact + native volume -> V1 filters EXECUTE on real values', () => {
    const f = new Feed();
    f.pace(BASE_TS, BASE_TS + 189);
    // token created at +140, evaluated when 50 s old; 24 SOL raised, mostly buys, plenty in the last minute. A
    // final trade at +189 keeps M within the default 5 s freshness bound of the +190 query.
    const sim = launch(f, M, BASE_TS + 140, [
      { ts: BASE_TS + 141, buySol: 4 },
      { ts: BASE_TS + 150, buySol: 6 },
      { ts: BASE_TS + 160, buySol: 5 },
      { ts: BASE_TS + 165, sellTokens: 30_000_000_000_000n },
      { ts: BASE_TS + 170, buySol: 6 },
      { ts: BASE_TS + 180, buySol: 5 },
      { ts: BASE_TS + 189, buySol: 0.5 },
    ]);
    f.pace(BASE_TS + 190, BASE_TS + 190);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 190));
    expect(s.quality).toBe('VALID');
    // the whole set of V1 inputs exists although no DexScreener call was ever made
    for (const v of [s.priceSol, s.liquiditySol, s.priceImpactPct, s.volume1mSol, s.volumeAccelerationX, s.buySellRatio, s.txCount1m]) expect(v).not.toBeNull();
    expect(s.liquiditySol).toBeCloseTo(realSolLiquidity(sim.rs), 12);
    expect(s.volumeAccelerationX).toBe(Number.POSITIVE_INFINITY); // it did not exist during the previous window: a proven zero
    const cfg = getDefaultConfig();
    const failures = collectBaselineFilterFailures({ liquiditySol: s.liquiditySol as number, volume1mSol: s.volume1mSol, buySellRatio: s.buySellRatio }, 5, s.volumeAccelerationX, s.priceImpactPct, cfg);
    expect(failures).not.toContain('volume_1m_unavailable');
    expect(failures).not.toContain('volume_acceleration_unavailable');
    expect(failures).not.toContain('price_impact_unavailable');
    expect(failures).not.toContain('buy_sell_ratio_unavailable');
    expect(failures).toEqual([]); // the values genuinely satisfy the UNCHANGED V1 thresholds here (a strategy outcome, not a lowered bar)
  });

  it('K/L: with the thresholds unchanged, thin tokens FAIL on their real values (liquidity < 20 SOL, volume < 5 SOL)', () => {
    const f = new Feed();
    f.pace(BASE_TS, BASE_TS + 189);
    // A tiny final trade at +189 keeps M fresh (default 5 s bound) without pushing this thin token over either
    // minimum -- it still fails on both, as intended.
    launch(f, M, BASE_TS + 140, [{ ts: BASE_TS + 150, buySol: 1.5 }, { ts: BASE_TS + 170, buySol: 1.0 }, { ts: BASE_TS + 189, buySol: 0.01 }]);
    f.pace(BASE_TS + 190, BASE_TS + 190);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 190));
    const failures = collectBaselineFilterFailures({ liquiditySol: s.liquiditySol as number, volume1mSol: s.volume1mSol, buySellRatio: s.buySellRatio }, 5, s.volumeAccelerationX, s.priceImpactPct, getDefaultConfig());
    expect(failures).toContain('liquidity_below_minimum');
    expect(failures).toContain('volume_below_minimum');
    expect(failures).not.toContain('volume_1m_unavailable');
  });

  it('the price-impact filter fails CLOSED when the entry cannot be priced (null), not open via a default', () => {
    const failures = collectBaselineFilterFailures({ liquiditySol: 25, volume1mSol: 6, buySellRatio: 2 }, 5, 2, null, getDefaultConfig());
    expect(failures).toEqual(['price_impact_unavailable']);
    expect(collectBaselineFilterFailures({ liquiditySol: 25, volume1mSol: 6, buySellRatio: null }, 5, 2, 0.5, getDefaultConfig())).toEqual(['buy_sell_ratio_unavailable']);
  });

  it('the thin-curve 0.3 SOL impact is under the unchanged 1 % limit only because virtual SOL >= 30: the value is a fact, not a tuned pass', () => {
    const fresh = buyPriceImpactPct({ virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, realTokenReserves: 793_100_000_000_000n }, entryNetLamports(300_000_000n, 95, 30))!;
    expect(fresh).toBeLessThan(getDefaultConfig().filters.maxPriceImpactPct);
    expect(fresh).toBeGreaterThan(0.98);
  });
});

describe('consumers other than the loop follow the same priority (native-first wrappers)', () => {
  it('VALID -> native; graduated/unobserved -> delegate; still-on-curve-but-unproven -> null, inner never called', async () => {
    const f = healthy();
    // A final small trade at +200 keeps M within the default 5 s freshness bound of the +201 query below.
    const sim = launch(f, M, BASE_TS + 100, [{ ts: BASE_TS + 150, buySol: 22 }, { ts: BASE_TS + 200, buySol: 0.01 }]);
    f.create(mintId(6), BASE_TS + 100); // created, no trade: no curve state
    launch(f, mintId(7), BASE_TS + 100, [{ ts: BASE_TS + 150, buySol: 2 }]);
    f.graduate(mintId(7), BASE_TS + 160);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const engine: PumpfunVolumeEngine = f.engine;
    const nowMs = at(BASE_TS + 201);
    const provider = {
      getNativeMarketSnapshot: (m: string, e: number) => engine.getNativeMarketSnapshot(m, e, nowMs),
      getNativeSellImpact: (m: string, t: bigint) => engine.getNativeSellImpact(m, t, nowMs),
    };
    let innerCalls = 0;
    const inner = {
      getPrice: async () => (innerCalls++, 0.123),
      getEstimatedPriceImpactPct: async () => (innerCalls++, 0.7),
      getLiquidityAndVolume: async () => (innerCalls++, { liquiditySol: 9, volume1mSol: null, buySellRatio: 1, txCount1m: 1 }),
      getHolderConcentration: async () => (innerCalls++, null),
      getBuyExecutionQuote: async () => (innerCalls++, { priceImpactPct: 0.7, tokenAmountRaw: '1' }),
      getSellPriceImpactPct: async () => (innerCalls++, 0.7),
    };
    const price = new NativeFirstPriceSource(inner, provider);
    const agg = new NativeFirstAggregator(inner, provider);
    expect(await price.getPrice(M)).toBeCloseTo(spotPriceSol(sim.vs, sim.vt)!, 18);
    expect((await agg.getLiquidityAndVolume(M))!.liquiditySol).toBeCloseTo(realSolLiquidity(sim.rs), 12);
    expect(innerCalls).toBe(0); // a curve token never touches the DexScreener/Jupiter source
    expect(await price.getPrice(mintId(6))).toBeNull(); // on the curve, state unproven: null, not a DexScreener number
    expect(await agg.getLiquidityAndVolume(mintId(6))).toBeNull();
    expect(innerCalls).toBe(0);
    expect(await price.getPrice(mintId(7))).toBe(0.123); // graduated: delegated
    expect(await price.getPrice(mintId(4321))).toBe(0.123); // never observed on the curve stream: delegated
    expect(innerCalls).toBe(2);
    expect(await agg.getHolderConcentration(M)).toBeNull(); // holder data is not native and always delegated
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// P1 fix #3: per-token curve state freshness. resolveCurve() (shared by getNativeMarketSnapshot AND
// getNativeSellImpact) used to validate global stream coverage and per-token STATUS, but never how old the token's
// own last curve-changing trade was relative to the current watermark -- so a token that simply stopped trading
// while OTHER tokens kept the stream healthy could still expose its old curve state as VALID indefinitely. Reuses
// the existing maxSnapshotSkewSec bound (now also governing this check; see pumpfunVolumeEngine.ts) -- the
// PRODUCTION DEFAULT (5 s, unchanged) is exercised directly below, with no local override.
// ---------------------------------------------------------------------------------------------------------------------
describe('per-token curve freshness (P1 fix): a healthy global stream must never override one quiet token', () => {
  it('fresh token state (well under the default 5 s bound) => VALID', () => {
    const f = healthy(BASE_TS + 92);
    const sim = launch(f, M, BASE_TS + 50, [{ ts: BASE_TS + 90, buySol: 2 }]);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 92)); // 2 s old: within the default bound
    expect(s.quality).toBe('VALID');
    expect(s.priceSol).toBeCloseTo(spotPriceSol(sim.vs, sim.vt)!, 18);
  });

  it('stale token state (well over the default 5 s bound) => TIMESTAMP_SKEW, not a fake GRADUATED and not silently VALID', () => {
    const f = healthy(BASE_TS + 100);
    launch(f, M, BASE_TS + 50, [{ ts: BASE_TS + 90, buySol: 2 }]); // M's last (and only) trade at +90
    f.pace(BASE_TS + 101, BASE_TS + 250); // 150 s of an UNRELATED mint's trades: the global stream stays healthy
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 250));
    expect(s.quality).toBe('TIMESTAMP_SKEW');
    expect(s.reason).toBe('timestamp_skew');
    expect(s.priceSol).toBeNull();
    expect(s.liquiditySol).toBeNull();
    expect(s.priceImpactPct).toBeNull();
  });

  it('global stream healthy does not override token staleness: streamGate itself reports the stream as fine', () => {
    const f = healthy(BASE_TS + 100);
    launch(f, M, BASE_TS + 50, [{ ts: BASE_TS + 90, buySol: 2 }]);
    f.pace(BASE_TS + 101, BASE_TS + 250);
    const health = f.engine.health(at(BASE_TS + 250));
    expect(health.started).toBe(true);
    expect(health.connected).toBe(true);
    expect(health.breakReason).toBeNull();
    expect(health.watermarkLagSec).toBeLessThan(30); // the stream itself is not remotely stale
    // ...and yet the per-token answer is still stale, because global health says nothing about THIS token:
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 250)).quality).toBe('TIMESTAMP_SKEW');
  });

  it('native sell impact is unavailable (not computed on a stale curve) when the token itself has gone quiet', () => {
    const f = healthy(BASE_TS + 100);
    launch(f, M, BASE_TS + 50, [{ ts: BASE_TS + 90, buySol: 2 }]);
    f.pace(BASE_TS + 101, BASE_TS + 250);
    const impact = f.engine.getNativeSellImpact(M, 1_000_000n, at(BASE_TS + 250));
    expect(impact).toMatchObject({ quality: 'TIMESTAMP_SKEW', reason: 'timestamp_skew', sellPriceImpactPct: null });
  });

  it('native buy snapshot is unavailable when token state is stale (same check, same result, for the buy-side snapshot)', () => {
    const f = healthy(BASE_TS + 100);
    launch(f, M, BASE_TS + 50, [{ ts: BASE_TS + 90, buySol: 2 }]);
    f.pace(BASE_TS + 101, BASE_TS + 250);
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 250));
    expect(s.buyTokenAmountRaw).toBeNull();
    expect(s.volumeAccelerationX).toBeNull();
  });

  it('a new trade for the token refreshes state and restores VALID when all other checks pass', () => {
    const f = healthy(BASE_TS + 100);
    const sim = launch(f, M, BASE_TS + 50, [{ ts: BASE_TS + 90, buySol: 2 }]);
    f.pace(BASE_TS + 101, BASE_TS + 250);
    expect(f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 250)).quality).toBe('TIMESTAMP_SKEW');
    f.curveTrade(M, sim.buy(500_000_000n), BASE_TS + 251); // any trade re-touches the curve AND advances the watermark
    const s = f.engine.getNativeMarketSnapshot(M, ENTRY, at(BASE_TS + 251));
    expect(s.quality).toBe('VALID');
    expect(s.priceSol).toBeCloseTo(spotPriceSol(sim.vs, sim.vt)!, 18);
  });

  it('does not change the volume windows or their thresholds: a fresh token still reports the exact same 1m volume as before this fix', () => {
    const f = healthy(BASE_TS + 100);
    launch(f, M, BASE_TS + 50, [{ ts: BASE_TS + 90, buySol: 2 }, { ts: BASE_TS + 95, buySol: 1 }]);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 100));
    expect(v.volume1mSol).toBeCloseTo(3, 8);
    expect(v.coverage.status).toBe('COMPLETE');
  });
});
