import { describe, expect, it } from 'vitest';
import { openLedger } from '../../src/ledger/db.js';
import { PumpfunVolumeService } from '../../src/volume/pumpfunVolumeService.js';
import { replayPumpfunVolume } from '../../src/volume/recordedVolumeReplay.js';
import { TradeEventRecorder } from '../../src/volume/tradeEventRecorder.js';
import { BASE_TS, LAG_MS, REAL, at, mintId, notification, patchTrade, realTradePayload, type FixtureNotification } from './helpers.js';
import { decodePumpfunNotification } from '../../src/volume/pumpfunTradeEventDecoder.js';

const M = mintId(1);

function makeService() {
  const db = openLedger(':memory:');
  const service = new PumpfunVolumeService({ db, watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0, engine: { silenceMs: 3_600_000, maxWatermarkLagSec: 1e9 } });
  service.start((BASE_TS - 500) * 1000);
  let clock = 0;
  let slot = 1;
  const send = (mint: string, sol: number, ts: number, buy = true): void => {
    clock = Math.max(clock, ts * 1000 + LAG_MS);
    const payload = patchTrade(realTradePayload(buy ? 'sol_buy' : 'sol_sell'), { mint, solLamports: Math.round(sol * 1e9), timestampSec: ts, isBuy: buy });
    service.onLogNotification(notification([payload], { slot: (slot += 1), receivedAtMs: clock }));
  };
  const pace = (from: number, to: number): void => {
    for (let t = from; t <= to; t += 1) send(mintId(9999), 0.001, t);
  };
  return { db, service, send, pace };
}

describe('event recorder', () => {
  it('records accepted events idempotently (identity primary key) and never records failed transactions', () => {
    const { db, service, send, pace } = makeService();
    pace(BASE_TS, BASE_TS + 10);
    send(M, 2, BASE_TS + 11);
    // the same event twice, and a failed transaction
    const n = notification([patchTrade(realTradePayload('sol_buy'), { mint: M, solLamports: 3e9, timestampSec: BASE_TS + 12 })], { receivedAtMs: (BASE_TS + 12) * 1000 + LAG_MS });
    service.onLogNotification(n);
    service.onLogNotification(n);
    service.onLogNotification({ ...n, signature: 'failed-one', err: { InstructionError: [0, 'x'] } });
    service.recorder!.flush();
    const rows = db.prepare('SELECT COUNT(*) AS c FROM pumpfun_trade_events WHERE mint = ?').get(M) as { c: number };
    expect(rows.c).toBe(2);
    const failed = db.prepare("SELECT COUNT(*) AS c FROM pumpfun_trade_events WHERE signature = 'failed-one'").get() as { c: number };
    expect(failed.c).toBe(0);
    const cols = (db.prepare('PRAGMA table_info(pumpfun_trade_events)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['signature', 'program', 'event_ordinal', 'mint', 'sol_amount_lamports', 'token_amount', 'is_buy', 'event_timestamp', 'slot', 'quote_mint', 'source']));
    expect(cols.join(',')).not.toMatch(/key|secret|wallet|trader/i); // nothing sensitive is persisted
    service.stop();
  });

  it('a second recorder over the same database (process restart) re-inserts nothing', () => {
    const { db, service, send, pace } = makeService();
    pace(BASE_TS, BASE_TS + 5);
    send(M, 1, BASE_TS + 6);
    service.recorder!.flush();
    const before = (db.prepare('SELECT COUNT(*) AS c FROM pumpfun_trade_events').get() as { c: number }).c;
    const again = new TradeEventRecorder(db);
    again.recordTrade({
      signature: 'x',
      program: 'p',
      eventOrdinal: 0,
      mint: M,
      solAmountLamports: 1,
      tokenAmount: '1',
      isBuy: true,
      trader: '',
      eventTimestampSec: BASE_TS,
      slot: 1,
      quoteMint: null,
      quoteClass: 'native_sol',
      curve: null,
      receivedAtMs: 1,
      source: 'onlogs_program_data',
    });
    again.flush();
    expect(again.written).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM pumpfun_trade_events').get() as { c: number }).c).toBe(before + 1);
    service.stop();
  });

  it('retention is bounded: old rows are pruned; the buffer is capped and counts drops; a DB failure is contained', () => {
    const db = openLedger(':memory:');
    const rec = new TradeEventRecorder(db, { retentionHours: 1, maxBufferedRows: 3 });
    const mk = (i: number, ts: number) => ({ signature: `s${i}`, program: 'p', eventOrdinal: 0, mint: M, solAmountLamports: 1, tokenAmount: '1', isBuy: true, trader: '', eventTimestampSec: ts, slot: 1, quoteMint: null, quoteClass: 'native_sol' as const, curve: null, receivedAtMs: ts * 1000, source: 'onlogs_program_data' as const });
    const nowMs = BASE_TS * 1000;
    for (let i = 0; i < 5; i += 1) rec.recordTrade(mk(i, BASE_TS - 7200)); // 2 h old
    expect(rec.droppedFromBuffer).toBe(2);
    rec.recordTrade(mk(10, BASE_TS));
    rec.flush();
    expect(rec.prune(nowMs)).toBeGreaterThan(0);
    const left = db.prepare('SELECT COUNT(*) AS c FROM pumpfun_trade_events').get() as { c: number };
    expect(left.c).toBe(1);

    db.close();
    rec.recordTrade(mk(11, BASE_TS));
    expect(() => rec.flush()).not.toThrow();
    expect(rec.writeFailures).toBeGreaterThan(0);
  });
});

describe('Y: one implementation -- live value == replay from recorded events', () => {
  it('healthy stream: replay reproduces the live value exactly (volume, previous, acceleration, coverage)', () => {
    const { db, service, send, pace } = makeService();
    pace(BASE_TS, BASE_TS + 199);
    send(M, 1, BASE_TS + 100);
    send(M, 2, BASE_TS + 110, false);
    send(M, 3, BASE_TS + 150);
    send(M, 5, BASE_TS + 190, false);
    pace(BASE_TS + 200, BASE_TS + 201);
    service.recorder!.flush();
    const t = at(BASE_TS + 201);
    const live = service.getOneMinuteVolume(M, t);
    expect(live.volume1mSol).toBeCloseTo(8, 9);
    expect(live.previousVolume1mSol).toBeCloseTo(3, 9);
    const replay = replayPumpfunVolume(db, M, t, { engine: { silenceMs: 3_600_000, maxWatermarkLagSec: 1e9 } });
    expect(replay).toEqual(live);
    service.stop();
  });

  it('after a coverage break the replay is null exactly where live is null', () => {
    const { db, service, send, pace } = makeService();
    pace(BASE_TS, BASE_TS + 199);
    send(M, 4, BASE_TS + 190);
    pace(BASE_TS + 200, BASE_TS + 201);
    service.engine.markDisconnected('stream_disconnected', (BASE_TS + 202) * 1000);
    service.engine.markReconnected((BASE_TS + 232) * 1000);
    pace(BASE_TS + 232, BASE_TS + 240);
    send(M, 1, BASE_TS + 241);
    pace(BASE_TS + 242, BASE_TS + 242);
    service.recorder!.flush();
    const t = at(BASE_TS + 242);
    const live = service.getOneMinuteVolume(M, t);
    expect(live.volume1mSol).toBeNull();
    const replay = replayPumpfunVolume(db, M, t, { engine: { silenceMs: 3_600_000, maxWatermarkLagSec: 1e9 } });
    expect(replay.volume1mSol).toBeNull();
    expect(replay.coverage.status).toBe(live.coverage.status);
    service.stop();
  });

  it('graduation: the recorded lifecycle event makes replay null, like live', () => {
    const real = REAL.complete[0] as FixtureNotification;
    const dec = decodePumpfunNotification({ signature: real.signature, slot: real.slot, err: null, logs: real.logs, receivedAtMs: 1 });
    const grad = dec.lifecycle.find((l) => l.kind === 'graduate')!;
    const ts = grad.eventTimestampSec;
    const db = openLedger(':memory:');
    const service = new PumpfunVolumeService({ db, watchdogIntervalMs: 3_600_000, statsLogIntervalMs: 0, engine: { silenceMs: 3_600_000, maxWatermarkLagSec: 1e9 } });
    service.start((ts - 500) * 1000);
    let clock = 0;
    for (let s = ts - 200; s <= ts - 1; s += 1) {
      clock = Math.max(clock, s * 1000 + LAG_MS);
      service.onLogNotification(notification([patchTrade(realTradePayload('sol_buy'), { mint: mintId(7), solLamports: 1e6, timestampSec: s })], { receivedAtMs: clock }));
    }
    service.onLogNotification({ signature: real.signature, slot: real.slot, err: null, logs: real.logs, receivedAtMs: ts * 1000 + LAG_MS });
    service.recorder!.flush();
    const t = (ts + 3) * 1000;
    expect(service.getOneMinuteVolume(grad.mint, t).coverage.reason).toBe('graduated');
    expect(replayPumpfunVolume(db, grad.mint, t, { engine: { silenceMs: 3_600_000, maxWatermarkLagSec: 1e9 } }).coverage.reason).toBe('graduated');
    service.stop();
  });

  it('no recorded events => null (nothing is reconstructed from any other source)', () => {
    const db = openLedger(':memory:');
    const v = replayPumpfunVolume(db, M, BASE_TS * 1000);
    expect(v.volume1mSol).toBeNull();
    expect(v.volumeAccelerationX).toBeNull();
    expect(v.coverage.reason).toBe('no_historical_events');
  });
});
