import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../../src/ledger/db.js';
import { TradeEventRecorder } from '../../src/volume/tradeEventRecorder.js';

/**
 * P0 regression suite. Root cause it guards: after a multi-day restart gap the first retention prune was ONE
 * `DELETE ... WHERE event_timestamp < ?` over ~4.8M rows on the single event-loop thread. It blocked the loop for
 * ~17 minutes (WS pings missed, timers frozen), after which shutdown ran against a dead socket. These tests pin the
 * contract that replaced it: retention work is done in bounded slices, off the start-up path, backs off under
 * pressure, and can be stopped between slices without hurting SQLite.
 */

const NOW_SEC = 1_800_000_000;
const NOW_MS = NOW_SEC * 1000;
const DAY = 86_400;

function seedTrades(db: DatabaseSync, count: number, baseTs: number, tag: string): void {
  const ins = db.prepare(
    `INSERT INTO pumpfun_trade_events (signature, program, event_ordinal, mint, sol_amount_lamports, token_amount, is_buy, event_timestamp, slot, quote_mint, quote_class, source, received_at_ms)
     VALUES (?, 'p', 0, ?, 1, '1', 1, ?, 1, NULL, 'native_sol', 'onlogs_program_data', ?)`,
  );
  db.exec('BEGIN');
  for (let i = 0; i < count; i += 1) ins.run(`${tag}${i}`, `mint${i % 500}`, baseTs + (i % 3600), (baseTs + (i % 3600)) * 1000);
  db.exec('COMMIT');
}

function seedLifecycleAndCoverage(db: DatabaseSync, count: number, baseTs: number): void {
  const life = db.prepare(`INSERT INTO pumpfun_lifecycle_events (signature, program, event_ordinal, kind, mint, event_timestamp, slot, quote_mint, received_at_ms) VALUES (?, 'p', 0, 'create', 'm', ?, 1, NULL, ?)`);
  const cov = db.prepare(`INSERT INTO volume_coverage_log (at_ms, event_second, kind, reason, epoch) VALUES (?, ?, 'break', 'x', 1)`);
  db.exec('BEGIN');
  for (let i = 0; i < count; i += 1) {
    life.run(`l${baseTs}-${i}`, baseTs + (i % 100), (baseTs + (i % 100)) * 1000);
    cov.run((baseTs + (i % 100)) * 1000, baseTs + (i % 100));
  }
  db.exec('COMMIT');
}

const count = (db: DatabaseSync, table: string): number => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe('bounded retention prune (P0)', () => {
  it('works through a backlog in bounded slices: no call removes more than its batch, fresh rows survive', () => {
    const db = openLedger(':memory:');
    seedTrades(db, 5000, NOW_SEC - 3 * DAY, 'old'); // stale: 3 days old, retention is 24 h
    seedTrades(db, 50, NOW_SEC - 60, 'new'); // fresh
    const rec = new TradeEventRecorder(db, { retentionHours: 24, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100 } });
    const perCall: number[] = [];
    for (let i = 0; i < 200 && count(db, 'pumpfun_trade_events') > 50; i += 1) perCall.push(rec.prune(NOW_MS));
    // 100 trade rows per slice (plus at most batch/10 from each of the two tiny tables, empty here).
    expect(Math.max(...perCall)).toBeLessThanOrEqual(100);
    expect(perCall.length).toBeGreaterThanOrEqual(50); // 5000 rows / 100 per slice: it really was spread out
    expect(count(db, 'pumpfun_trade_events')).toBe(50);
    expect((db.prepare("SELECT COUNT(*) AS c FROM pumpfun_trade_events WHERE signature LIKE 'new%'").get() as { c: number }).c).toBe(50);
    expect(rec.prunedRows).toBe(5000);
    expect(rec.prune(NOW_MS)).toBe(0); // nothing expired left: idle slice is a no-op
    db.close();
  });

  it('control: the old single-statement prune removes the whole backlog in one call (this is what the suite forbids)', () => {
    const db = openLedger(':memory:');
    seedTrades(db, 5000, NOW_SEC - 3 * DAY, 'old');
    const removedInOneStatement = Number(db.prepare('DELETE FROM pumpfun_trade_events WHERE event_timestamp < ?').run(NOW_SEC - DAY).changes);
    expect(removedInOneStatement).toBe(5000); // one unbounded statement; with 4.8M rows this is the 17-minute stall
    db.close();
  });

  it('each slice is index-driven: its cost follows the batch, not the table size', () => {
    const db = openLedger(':memory:');
    const plan = db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM pumpfun_trade_events WHERE rowid IN (SELECT rowid FROM pumpfun_trade_events WHERE event_timestamp < ? ORDER BY event_timestamp LIMIT ?)')
      .all(NOW_SEC, 100) as Array<{ detail: string }>;
    const text = plan.map((p) => p.detail).join(' | ');
    expect(text).toContain('idx_pumpfun_trade_events_ts');
    expect(text).not.toMatch(/SCAN pumpfun_trade_events(?! USING)/); // never a full table scan
    db.close();
  });

  it('a large backlog never produces a long synchronous slice (200k stale rows, every slice stays far below a stall)', () => {
    const db = openLedger(':memory:');
    seedTrades(db, 200_000, NOW_SEC - 3 * DAY, 'old');
    const rec = new TradeEventRecorder(db, { retentionHours: 24 });
    let slowest = 0;
    let slices = 0;
    while (count(db, 'pumpfun_trade_events') > 0 && slices < 5000) {
      const t0 = performance.now();
      rec.prune(NOW_MS);
      slowest = Math.max(slowest, performance.now() - t0);
      slices += 1;
    }
    expect(count(db, 'pumpfun_trade_events')).toBe(0);
    expect(slowest).toBeLessThan(250); // ms; the old code blocked for the whole backlog (seconds here, ~17 min on 4.8M cold rows)
    db.close();
  }, 60_000);

  it('retention semantics are unchanged: lifecycle and coverage rows expire too, recent ones are kept', () => {
    const db = openLedger(':memory:');
    seedLifecycleAndCoverage(db, 300, NOW_SEC - 3 * DAY);
    seedLifecycleAndCoverage(db, 20, NOW_SEC - 30);
    const rec = new TradeEventRecorder(db, { retentionHours: 24, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100 } });
    for (let i = 0; i < 100; i += 1) rec.prune(NOW_MS);
    expect(count(db, 'pumpfun_lifecycle_events')).toBe(20);
    expect(count(db, 'volume_coverage_log')).toBe(20);
    db.close();
  });

  describe('timer-driven behaviour', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW_MS);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does nothing at start-up: the first slice waits for the prune interval, then runs one bounded slice per tick', () => {
      const db = openLedger(':memory:');
      seedTrades(db, 1000, NOW_SEC - 3 * DAY, 'old');
      const rec = new TradeEventRecorder(db, { retentionHours: 24, pruneIntervalMs: 60_000, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100, minPauseMs: 25 } });
      rec.start();
      vi.advanceTimersByTime(59_999);
      expect(count(db, 'pumpfun_trade_events')).toBe(1000); // start-up path untouched
      expect(rec.pruneSlices).toBe(0);
      vi.advanceTimersByTime(1);
      expect(rec.pruneSlices).toBe(1);
      expect(count(db, 'pumpfun_trade_events')).toBe(900); // exactly one bounded slice
      vi.advanceTimersByTime(24); // inside the pause: the event loop gets its turn, no new slice yet
      expect(rec.pruneSlices).toBe(1);
      vi.advanceTimersByTime(10_000); // the rest drains slice by slice
      expect(count(db, 'pumpfun_trade_events')).toBe(0);
      expect(rec.pruneSlices).toBeGreaterThanOrEqual(10);
      const slicesWhenDrained = rec.pruneSlices;
      vi.advanceTimersByTime(30_000); // drained: back to the idle interval, no busy loop
      expect(rec.pruneSlices).toBeLessThanOrEqual(slicesWhenDrained + 1);
      rec.stop();
      db.close();
    });

    it('stop() cancels further slices immediately', () => {
      const db = openLedger(':memory:');
      seedTrades(db, 1000, NOW_SEC - 3 * DAY, 'old');
      const rec = new TradeEventRecorder(db, { retentionHours: 24, pruneIntervalMs: 1000, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100 } });
      rec.start();
      vi.advanceTimersByTime(1000);
      const left = count(db, 'pumpfun_trade_events');
      rec.stop();
      vi.advanceTimersByTime(120_000);
      expect(count(db, 'pumpfun_trade_events')).toBe(left);
      db.close();
    });

    it('backs off when the event loop is late: the slice is skipped, not forced', () => {
      const db = openLedger(':memory:');
      seedTrades(db, 500, NOW_SEC - 3 * DAY, 'old');
      const rec = new TradeEventRecorder(db, { retentionHours: 24, pruneIntervalMs: 1000, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100, maxLoopLagMs: 250, minPauseMs: 25 } });
      rec.start();
      vi.setSystemTime(NOW_MS + 5000); // the loop "was busy" for 5 s past the due time
      vi.advanceTimersByTime(1000);
      expect(rec.pruneSkippedForLag).toBe(1);
      expect(rec.pruneSlices).toBe(0);
      expect(count(db, 'pumpfun_trade_events')).toBe(500);
      vi.advanceTimersByTime(5000); // healthy again: it proceeds
      expect(rec.pruneSlices).toBeGreaterThan(0);
      rec.stop();
      db.close();
    });
  });

  describe('safety under disk pressure and on stop (file-backed ledger)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'bounded-prune-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('pauses while the WAL is large or the disk is nearly full, and resumes when the pressure is gone', () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW_MS);
      try {
        const db = openLedger(join(dir, 'ledger.sqlite'));
        seedTrades(db, 500, NOW_SEC - 3 * DAY, 'old'); // leaves a non-empty -wal next to the db
        const walLarge = new TradeEventRecorder(db, { retentionHours: 24, pruneIntervalMs: 1000, prune: { maxWalBytes: 1, pressureRecheckMs: 1000 } });
        walLarge.start();
        vi.advanceTimersByTime(5000);
        expect(walLarge.pruneSkippedForPressure).toBeGreaterThanOrEqual(3);
        expect(walLarge.pruneSlices).toBe(0);
        walLarge.stop();

        const diskFull = new TradeEventRecorder(db, { retentionHours: 24, pruneIntervalMs: 1000, prune: { minFreeBytes: Number.MAX_SAFE_INTEGER, pressureRecheckMs: 1000 } });
        diskFull.start();
        vi.advanceTimersByTime(5000);
        expect(diskFull.pruneSkippedForPressure).toBeGreaterThanOrEqual(3);
        expect(diskFull.pruneSlices).toBe(0);
        diskFull.stop();
        expect(count(db, 'pumpfun_trade_events')).toBe(500); // nothing was deleted while under pressure

        const healthy = new TradeEventRecorder(db, { retentionHours: 24, pruneIntervalMs: 1000, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100, maxWalBytes: 1 << 30, minFreeBytes: 0 } });
        healthy.start();
        vi.advanceTimersByTime(10_000);
        expect(count(db, 'pumpfun_trade_events')).toBe(0);
        healthy.stop();
        db.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('stopping part-way through a backlog leaves SQLite and the WAL healthy and the rest still prunable', () => {
      const file = join(dir, 'ledger.sqlite');
      const db = openLedger(file);
      seedTrades(db, 3000, NOW_SEC - 3 * DAY, 'old');
      seedTrades(db, 40, NOW_SEC - 60, 'new');
      const rec = new TradeEventRecorder(db, { retentionHours: 24, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100 } });
      for (let i = 0; i < 7; i += 1) rec.prune(NOW_MS); // part-way: 700 of 3000
      rec.stop();
      db.close(); // abrupt from the prune's point of view: no drain, no checkpoint ceremony

      const reopened = openLedger(file);
      expect((reopened.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>)[0]?.integrity_check).toBe('ok');
      expect(count(reopened, 'pumpfun_trade_events')).toBe(2300 + 40);
      const rec2 = new TradeEventRecorder(reopened, { retentionHours: 24, prune: { batchRows: 100, minBatchRows: 100, maxBatchRows: 100 } });
      for (let i = 0; i < 100; i += 1) rec2.prune(NOW_MS);
      expect(count(reopened, 'pumpfun_trade_events')).toBe(40);
      expect((reopened.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>)[0]?.quick_check).toBe('ok');
      reopened.close();
    });
  });

  it('batch size adapts: shrinks when slices are slow, grows when they are fast', () => {
    const slowDb = openLedger(':memory:');
    seedTrades(slowDb, 4000, NOW_SEC - 3 * DAY, 'old');
    // any real slice takes longer than 2 x 1e-9 ms, so every slice counts as "slow"
    const slow = new TradeEventRecorder(slowDb, { retentionHours: 24, pruneIntervalMs: 1, prune: { batchRows: 800, minBatchRows: 20, maxBatchRows: 2000, targetSliceMs: 1e-9, minPauseMs: 1, dutyFactor: 0 } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      slow.start();
      vi.advanceTimersByTime(200);
      expect(slow.pruneBatchRows).toBe(20);
      slow.stop();

      const fastDb = openLedger(':memory:');
      seedTrades(fastDb, 20_000, NOW_SEC - 3 * DAY, 'old');
      const fast = new TradeEventRecorder(fastDb, { retentionHours: 24, pruneIntervalMs: 1, prune: { batchRows: 20, minBatchRows: 20, maxBatchRows: 2000, targetSliceMs: 1e9, minPauseMs: 1, dutyFactor: 0 } });
      fast.start();
      vi.advanceTimersByTime(300);
      expect(fast.pruneBatchRows).toBeGreaterThan(200);
      fast.stop();
      fastDb.close();
    } finally {
      vi.useRealTimers();
    }
    slowDb.close();
  });
});
