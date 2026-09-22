import { describe, expect, it } from 'vitest';
import { decodePumpfunNotification, NATIVE_SOL_QUOTE_MINT } from '../../src/volume/pumpfunTradeEventDecoder.js';
import { PumpfunVolumeEngine } from '../../src/volume/pumpfunVolumeEngine.js';
import { BASE_TS, Feed, LAG_MS, REAL, at, logsWithEvents, mintId, nextSig, notification, patchTrade, realTradePayload, type FixtureNotification } from './helpers.js';

const M = mintId(1);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** A healthy stream: one pacer trade per second from BASE_TS to `until`, so coverage has been proven since BASE_TS+1. */
function healthyFeed(until = BASE_TS + 200, options = {}): Feed {
  const f = new Feed(options);
  f.pace(BASE_TS, until);
  return f;
}

describe('volume windows: (T-60, T] current, (T-120, T-60] previous', () => {
  it('I/J/K/L/M/N: exact boundaries and the acceleration ratio', () => {
    const f = healthyFeed(BASE_TS + 199);
    const W = BASE_TS + 200;
    const T = W - 1; // settled watermark
    f.engine.getOneMinuteVolume(M, at(W)); // (unknown mint before its first trade)
    f.trade({ mint: M, sol: 1, ts: T - 120 }); // outside both windows
    f.trade({ mint: M, sol: 2, ts: T - 119 }); // previous window, first second
    f.trade({ mint: M, sol: 4, ts: T - 60 }); // previous window LAST second: T-60 is NOT in the current window
    f.trade({ mint: M, sol: 8, ts: T - 59 }); // current window, first second
    f.trade({ mint: M, sol: 16, ts: T }); // current window, last second
    f.trade({ mint: M, sol: 32, ts: W }); // newest second is not settled yet: in neither window
    const v = f.engine.getOneMinuteVolume(M, at(W));
    expect(v.windowEndSec).toBe(T);
    expect(v.watermarkSec).toBe(W);
    expect(v.volume1mSol).toBeCloseTo(24, 9); // 8 + 16
    expect(v.previousVolume1mSol).toBeCloseTo(6, 9); // 2 + 4
    expect(v.volumeAccelerationX).toBeCloseTo(4, 9);
    expect(v.currentEventCount).toBe(2);
    expect(v.previousEventCount).toBe(2);
    expect(v.coverage).toEqual({ status: 'COMPLETE', reason: 'ok', currentWindowCovered: true, previousWindowCovered: true });
  });

  it('counts BUY and SELL SOL volume together, and only the curve-side amount', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 3, ts: BASE_TS + 150, buy: true });
    f.trade({ mint: M, sol: 2, ts: BASE_TS + 151, buy: false });
    f.pace(BASE_TS + 201, BASE_TS + 202);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 202)).volume1mSol).toBeCloseTo(5, 9);
  });

  it('O: previous window empty with proven coverage and current > 0 gives +Infinity (degenerate_ratio path)', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 6, ts: BASE_TS + 190 });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBeCloseTo(6, 9);
    expect(v.previousVolume1mSol).toBe(0);
    expect(v.volumeAccelerationX).toBe(Number.POSITIVE_INFINITY);
  });

  it('P: current = 0 and previous = 0 is an undefined ratio: null, not a manufactured number', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 30 }); // proves the mint is on the curve, before both windows
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBe(0);
    expect(v.previousVolume1mSol).toBe(0);
    expect(v.volumeAccelerationX).toBeNull();
  });

  it('previous > 0 and current = 0 gives acceleration 0', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 4, ts: BASE_TS + 130 });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBe(0);
    expect(v.previousVolume1mSol).toBeCloseTo(4, 9);
    expect(v.volumeAccelerationX).toBe(0);
  });

  it('T: a healthy stream with no trades for the token is a valid ZERO (not null)', () => {
    const f = healthyFeed();
    f.create(M, BASE_TS + 30);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBe(0);
    expect(v.coverage.status).toBe('COMPLETE');
  });
});

describe('event acceptance', () => {
  it('C: a non-SOL quote is excluded from volume and makes the token unavailable (never 0)', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 50, ts: BASE_TS + 190, quoteMint: USDC });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBeNull();
    expect(v.coverage).toMatchObject({ status: 'UNAVAILABLE', reason: 'non_sol_quote' });
    expect(f.engine.stats.excludedNonSolQuote).toBe(1);
    expect(f.engine.stats.tradesCountedInVolume).toBeGreaterThan(0); // pacer trades still counted; the USDC one is not
  });

  it('a non-SOL trade never leaks into another token\'s volume', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 2, ts: BASE_TS + 190 });
    f.trade({ mint: mintId(2), sol: 500, ts: BASE_TS + 191, quoteMint: USDC });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(2, 9);
  });

  it('D: a failed transaction never contributes volume', () => {
    const f = healthyFeed();
    const payload = patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 9e9, timestampSec: BASE_TS + 190 });
    f.engine.onNotification(notification([payload], { err: { InstructionError: [0, 'Custom'] }, receivedAtMs: (BASE_TS + 190) * 1000 + LAG_MS }));
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 191 });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(1, 9);
    expect(f.engine.stats.failedTransactions).toBe(1);
  });

  it('D2: a notification whose status is unknown (err undefined) is discarded', () => {
    const f = healthyFeed();
    const payload = patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 9e9, timestampSec: BASE_TS + 190 });
    f.engine.onNotification({ signature: nextSig(), slot: 1, err: undefined, logs: logsWithEvents([payload]), receivedAtMs: (BASE_TS + 190) * 1000 + LAG_MS });
    expect(f.engine.stats.unknownStatus).toBe(1);
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 191 });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(1, 9);
  });

  it('E: the engine counts the log channel only (the dual-representation proof is in decoder.test.ts)', () => {
    const f = healthyFeed();
    const payload = patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 7e9, timestampSec: BASE_TS + 190 });
    f.engine.onNotification(notification([payload], { receivedAtMs: (BASE_TS + 190) * 1000 + LAG_MS }));
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(7, 9);
  });

  it('F: two trades in one transaction are both counted; each has its own identity', () => {
    const f = healthyFeed();
    const a = patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 2e9, timestampSec: BASE_TS + 190 });
    const b = patchTrade(realTradePayload('sol_sell'), { mint: M, solLamports: 3e9, timestampSec: BASE_TS + 190 });
    f.engine.onNotification(notification([a, b], { receivedAtMs: (BASE_TS + 190) * 1000 + LAG_MS }));
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBeCloseTo(5, 9);
    expect(v.currentEventCount).toBe(2);
  });

  it('X: the same notification delivered twice is counted once (overlapping delivery / replay)', () => {
    const f = healthyFeed();
    const n = notification([patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 4e9, timestampSec: BASE_TS + 190 })], { receivedAtMs: (BASE_TS + 190) * 1000 + LAG_MS });
    f.engine.onNotification(n);
    f.engine.onNotification(n);
    f.engine.onNotification({ ...n, slot: n.slot + 5, receivedAtMs: n.receivedAtMs + 3000 }); // re-delivery later, e.g. after a reconnect
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(4, 9);
    expect(f.engine.stats.duplicates).toBe(2);
  });

  it('G: identity is per ordinal, so two different events of one signature are not deduplicated', () => {
    const f = healthyFeed();
    const sig = nextSig();
    const one = patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 1e9, timestampSec: BASE_TS + 190 });
    f.engine.onNotification(notification([one, one], { signature: sig, receivedAtMs: (BASE_TS + 190) * 1000 + LAG_MS }));
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(2, 9); // ordinals 0 and 1
  });

  it('H: an out-of-order (late) event is inserted by event time, not arrival order', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 195 });
    f.trade({ mint: M, sol: 2, ts: BASE_TS + 199 }); // watermark moves ahead...
    f.trade({ mint: M, sol: 4, ts: BASE_TS + 180 }); // ...then an older event arrives late
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(7, 9);
    expect(f.engine.stats.lateEvents).toBeGreaterThanOrEqual(1);
  });

  it('an event older than the retention horizon is dropped and counted', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 9, ts: BASE_TS + 200 - 181 });
    expect(f.engine.stats.tooOldDropped).toBe(1);
  });

  it('an event stamped in the far future is rejected, and never moves the watermark', () => {
    const f = healthyFeed();
    const before = f.engine.health(at(BASE_TS + 200)).watermarkSec;
    const payload = patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 1e9, timestampSec: BASE_TS + 100_000 });
    f.engine.onNotification(notification([payload], { receivedAtMs: (BASE_TS + 200) * 1000 }));
    expect(f.engine.stats.futureRejected).toBe(1);
    expect(f.engine.health(at(BASE_TS + 200)).watermarkSec).toBe(before);
  });

  it('events sharing one second are all counted', () => {
    const f = healthyFeed();
    for (let i = 0; i < 5; i += 1) f.trade({ mint: M, sol: 1, ts: BASE_TS + 190 });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeCloseTo(5, 9);
  });
});

describe('coverage: unknown is null, never zero', () => {
  it('S: a stream that has not started, or has produced no event yet, answers null', () => {
    const cold = new PumpfunVolumeEngine();
    expect(cold.getOneMinuteVolume(M, at(BASE_TS)).volume1mSol).toBeNull();
    expect(cold.getOneMinuteVolume(M, at(BASE_TS)).coverage.reason).toBe('stream_not_started');
    cold.markStreamStarted(BASE_TS * 1000);
    const started = cold.getOneMinuteVolume(M, at(BASE_TS));
    expect(started.volume1mSol).toBeNull();
    expect(started.coverage.status).toBe('UNKNOWN');
  });

  it('a stream younger than the window cannot claim the window: current null until 60 s of proven coverage', () => {
    const f = new Feed();
    f.pace(BASE_TS, BASE_TS + 30);
    f.trade({ mint: M, sol: 5, ts: BASE_TS + 31 });
    const early = f.engine.getOneMinuteVolume(M, at(BASE_TS + 32));
    expect(early.volume1mSol).toBeNull();
    expect(early.volumeAccelerationX).toBeNull();
    f.pace(BASE_TS + 33, BASE_TS + 80);
    const later = f.engine.getOneMinuteVolume(M, at(BASE_TS + 80));
    expect(later.volume1mSol).toBeCloseTo(5, 9); // current window (T-59..T) now lies inside proven coverage
    expect(later.previousVolume1mSol).toBeNull(); // the previous one does not
    expect(later.volumeAccelerationX).toBeNull();
  });

  it('Q/R: disconnect -> null; reconnect alone does not restore coverage; it is outlived, not repaired', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 5, ts: BASE_TS + 199 });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).toBeGreaterThan(0);

    const dropAtMs = (BASE_TS + 202) * 1000;
    f.engine.markDisconnected('stream_disconnected', dropAtMs);
    const down = f.engine.getOneMinuteVolume(M, dropAtMs + 500);
    expect(down.volume1mSol).toBeNull();
    expect(down.coverage).toMatchObject({ status: 'UNKNOWN', reason: 'stream_disconnected' });

    // web3.js re-subscribes; 30 s of events were lost and nothing replays them.
    const R = BASE_TS + 232;
    f.engine.markReconnected(R * 1000);
    expect(f.engine.getOneMinuteVolume(M, at(R)).volume1mSol).toBeNull(); // still unknown until events prove the stream is back
    f.pace(R, R + 5);
    f.trade({ mint: M, sol: 1, ts: R + 6 });
    const soon = f.engine.getOneMinuteVolume(M, at(R + 6));
    expect(soon.volume1mSol).toBeNull(); // the current window still contains the lost 30 s
    expect(soon.coverage.status).toBe('UNKNOWN');

    f.pace(R + 7, R + 70);
    f.trade({ mint: M, sol: 2, ts: R + 71 });
    f.pace(R + 72, R + 72);
    const recovered = f.engine.getOneMinuteVolume(M, at(R + 72));
    expect(recovered.volume1mSol).toBeCloseTo(2, 9); // 60 s later the gap has slid out of the current window (only the R+71 trade is inside)
    expect(recovered.previousVolume1mSol).toBeNull(); // ...but not out of the previous one
    expect(recovered.volumeAccelerationX).toBeNull();

    f.pace(R + 73, R + 135);
    f.trade({ mint: M, sol: 4, ts: R + 136 });
    f.pace(R + 137, R + 137);
    const full = f.engine.getOneMinuteVolume(M, at(R + 137));
    expect(full.previousVolume1mSol).not.toBeNull();
    expect(full.coverage.previousWindowCovered).toBe(true);
  });

  it('a token quiet since before a break is not answered until it trades again (it may have graduated inside the gap)', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 100 });
    f.engine.markDisconnected('stream_disconnected', (BASE_TS + 201) * 1000);
    f.engine.markReconnected((BASE_TS + 202) * 1000);
    f.pace(BASE_TS + 202, BASE_TS + 400);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 400))).toMatchObject({ volume1mSol: null, coverage: { status: 'UNKNOWN', reason: 'token_state_unproven' } });
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 401 });
    f.pace(BASE_TS + 402, BASE_TS + 402);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 402)).volume1mSol).toBeCloseTo(1, 9);
  });

  it('stream silence (no notification of any kind for silenceMs) breaks coverage', () => {
    const f = healthyFeed(BASE_TS + 200, { silenceMs: 5000 });
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 199 });
    const lastRecv = (BASE_TS + 200) * 1000 + LAG_MS;
    expect(f.engine.getOneMinuteVolume(M, lastRecv + 2000).volume1mSol).not.toBeNull();
    const silent = f.engine.getOneMinuteVolume(M, lastRecv + 6000);
    expect(silent.volume1mSol).toBeNull();
    expect(silent.coverage.reason).toBe('stream_silent');
  });

  it('a stale watermark (stream lagging the wall clock far behind) answers null', () => {
    const f = healthyFeed(BASE_TS + 200, { silenceMs: 10_000_000 });
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 199 });
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).volume1mSol).not.toBeNull();
    const stale = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201) + 120_000);
    expect(stale.volume1mSol).toBeNull();
    expect(stale.coverage.reason).toBe('watermark_stale');
  });

  it('a websocket error is a coverage break', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 199 });
    f.engine.recordStreamError((BASE_TS + 201) * 1000);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201))).toMatchObject({ volume1mSol: null, coverage: { reason: 'stream_error' } });
  });

  it('a malformed Pump.fun event or a truncated log is treated as possible loss (coverage break)', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 1, ts: BASE_TS + 199 });
    const bad = Buffer.from(realTradePayload('sol_buy'));
    bad.writeUInt8(9, 56);
    f.engine.onNotification(notification([bad], { receivedAtMs: (BASE_TS + 200) * 1000 }));
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).coverage.reason).toBe('decode_error');

    const g = healthyFeed();
    g.trade({ mint: M, sol: 1, ts: BASE_TS + 199 });
    const trunc = { ...notification([patchTrade(realTradePayload('sol_buy'), { mint: M, timestampSec: BASE_TS + 200 })], { receivedAtMs: (BASE_TS + 200) * 1000 }) };
    trunc.logs = [...trunc.logs, 'Log truncated'];
    g.engine.onNotification(trunc);
    expect(g.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).coverage.reason).toBe('logs_truncated');
  });

  it('W: restart -- a fresh engine knows nothing and must re-prove coverage; nothing is carried over as zero', () => {
    const f = healthyFeed();
    f.trade({ mint: M, sol: 5, ts: BASE_TS + 199 });
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 200)).volume1mSol).toBeGreaterThan(0);
    const restarted = new Feed({}, (BASE_TS + 300) * 1000);
    restarted.pace(BASE_TS + 300, BASE_TS + 310);
    expect(restarted.engine.getOneMinuteVolume(M, at(BASE_TS + 310))).toMatchObject({ volume1mSol: null, coverage: { status: 'UNAVAILABLE', reason: 'mint_not_observed' } });
    restarted.trade({ mint: M, sol: 1, ts: BASE_TS + 311 });
    const early = restarted.engine.getOneMinuteVolume(M, at(BASE_TS + 312));
    expect(early.volume1mSol).toBeNull(); // 12 s of proven coverage cannot answer a 60 s window
  });
});

describe('token lifecycle', () => {
  it('U: a graduated token is unavailable (null), never 0', () => {
    const f = healthyFeed();
    f.create(M, BASE_TS + 100);
    f.trade({ mint: M, sol: 20, ts: BASE_TS + 150 });
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 200)).volume1mSol).toBeGreaterThan(0);
    f.graduate(M, BASE_TS + 160);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBeNull();
    expect(v.coverage).toMatchObject({ status: 'UNAVAILABLE', reason: 'graduated' });
  });

  it('graduation is sticky and is not inferred from silence: a quiet SOL token stays a valid zero', () => {
    const f = healthyFeed();
    f.create(M, BASE_TS + 100);
    f.pace(BASE_TS + 201, BASE_TS + 300);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 300)).volume1mSol).toBe(0);
  });

  it('a token created with a non-SOL quote is unavailable from the start', () => {
    const f = healthyFeed();
    f.create(M, BASE_TS + 100, USDC);
    f.pace(BASE_TS + 201, BASE_TS + 201);
    expect(f.engine.getOneMinuteVolume(M, at(BASE_TS + 201)).coverage.reason).toBe('non_sol_quote');
  });

  it('an unobserved token (for example a Raydium LP mint) is unavailable, not zero', () => {
    const f = healthyFeed();
    expect(f.engine.getOneMinuteVolume(mintId(4242), at(BASE_TS + 200))).toMatchObject({ volume1mSol: null, coverage: { status: 'UNAVAILABLE', reason: 'mint_not_observed' } });
  });

  it('a token created inside the current healthy period has provable coverage from its creation (young token)', () => {
    const f = healthyFeed();
    f.create(M, BASE_TS + 150);
    f.trade({ mint: M, sol: 6, ts: BASE_TS + 160 });
    f.pace(BASE_TS + 201, BASE_TS + 201);
    const v = f.engine.getOneMinuteVolume(M, at(BASE_TS + 201));
    expect(v.volume1mSol).toBeCloseTo(6, 9);
    expect(v.previousVolume1mSol).toBe(0); // it did not exist during the previous window: a proven zero
    expect(v.volumeAccelerationX).toBe(Number.POSITIVE_INFINITY);
  });

  it('real captured CompleteEvent -> that token is graduated (uses the real mint from the fixture)', () => {
    const real = REAL.complete[0] as FixtureNotification;
    const decoded = decodePumpfunNotification({ signature: real.signature, slot: real.slot, err: null, logs: real.logs, receivedAtMs: 1 });
    const grad = decoded.lifecycle.find((l) => l.kind === 'graduate')!;
    const ts = grad.eventTimestampSec;
    const f = new Feed({}, (ts - 500) * 1000);
    f.pace(ts - 200, ts + 1);
    f.engine.onNotification({ signature: real.signature, slot: real.slot, err: null, logs: real.logs, receivedAtMs: ts * 1000 + LAG_MS });
    f.pace(ts + 2, ts + 3);
    expect(f.engine.getOneMinuteVolume(grad.mint, (ts + 4) * 1000)).toMatchObject({ volume1mSol: null, coverage: { status: 'UNAVAILABLE', reason: 'graduated' } });
  });
});

describe('bounded memory (V)', () => {
  it('memory stays bounded under sustained high-frequency trading across many mints', () => {
    const f = new Feed();
    const seconds = 900;
    let n = 0;
    for (let s = 0; s < seconds; s += 1) {
      for (let i = 0; i < 40; i += 1) {
        f.trade({ mint: mintId(i + Math.floor(s / 30) * 40), sol: 0.01, ts: BASE_TS + s });
        n += 1;
      }
    }
    const sizes = f.engine.sizes();
    expect(n).toBe(36_000);
    expect(sizes.buckets).toBeLessThanOrEqual(180 * 40 + 200); // retention (180 s) x events per second
    expect(sizes.dedupeEntries).toBeLessThanOrEqual(180 * 40 + 200);
    expect(sizes.mintStates).toBeLessThanOrEqual(30 * 40 + 40); // one state per distinct mint, idle ones pruned
  });

  it('hard caps hold even with no time-based pruning: dedupe FIFO-evicts and bucket overflow becomes a coverage break', () => {
    const f = new Feed({ maxDedupeEntries: 50, maxBuckets: 30 });
    for (let s = 0; s < 100; s += 1) f.trade({ mint: mintId(s), sol: 0.01, ts: BASE_TS + Math.floor(s / 10) });
    const sizes = f.engine.sizes();
    expect(sizes.dedupeEntries).toBeLessThanOrEqual(50);
    expect(sizes.buckets).toBeLessThanOrEqual(30);
    expect(f.engine.stats.capacityDrops).toBeGreaterThan(0);
    expect(f.engine.getOneMinuteVolume(mintId(0), at(BASE_TS + 10)).volume1mSol).toBeNull();
  });

  it('constructor rejects a retention shorter than two windows', () => {
    expect(() => new PumpfunVolumeEngine({ retentionSec: 100 })).toThrow();
  });
});

describe('real captured notifications through the engine', () => {
  it('counts exactly the SOL-quoted trades of successful real transactions, using real event timestamps', () => {
    const real = [...REAL.sol_buy, ...REAL.sol_sell, ...REAL.multi, ...REAL.non_sol, ...REAL.failed].sort((a, b) => a.slot - b.slot);
    const decoded = real.map((n) => decodePumpfunNotification({ signature: n.signature, slot: n.slot, err: n.err, logs: n.logs, receivedAtMs: 1 }));
    const firstTs = Math.min(...decoded.flatMap((d) => d.trades.map((t) => t.eventTimestampSec)));
    const lastTs = Math.max(...decoded.flatMap((d) => d.trades.map((t) => t.eventTimestampSec)));
    const eng = new PumpfunVolumeEngine({ maxWatermarkLagSec: 1e9, retentionSec: 1e6 });
    eng.markStreamStarted((firstTs - 1) * 1000);
    for (const n of real) eng.onNotification({ signature: n.signature, slot: n.slot, err: n.err, logs: n.logs, receivedAtMs: (n.slot % 1000) * 0 + (lastTs + 1) * 1000 });
    const expectedCounted = decoded.flatMap((d) => d.trades).filter((t) => t.quoteClass === 'native_sol').length;
    expect(eng.stats.tradesCountedInVolume).toBe(expectedCounted);
    expect(eng.stats.failedTransactions).toBe(REAL.failed.length);
    expect(eng.stats.excludedNonSolQuote).toBe(decoded.flatMap((d) => d.trades).filter((t) => t.quoteClass === 'other').length);
    expect(NATIVE_SOL_QUOTE_MINT).toBe('11111111111111111111111111111111');
  });
});
