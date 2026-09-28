import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { openLedger } from '../../src/ledger/db.js';
import { ShadowObservabilityRecorder } from '../../src/shadow/shadowObservabilityRecorder.js';
import type { DatabaseSync } from 'node:sqlite';

function missedSignal(overrides: Partial<Parameters<ShadowObservabilityRecorder['recordMissedSignal']>[1]> = {}) {
  return { mint: 'MINT_A', strategyVersion: 'V1', observedAtMs: 1000, reason: 'reentry_cooldown_active', detail: 'x', ...overrides };
}
function dqEvent(overrides: Partial<Parameters<ShadowObservabilityRecorder['recordDataQualityEvent']>[1]> = {}) {
  return { mint: 'MINT_A', strategyVersion: 'V1' as string | null, observedAtMs: 1000, kind: 'stale_market_data' as const, severity: 'warning' as const, detail: 'x', ...overrides };
}
function latencySample(overrides: Partial<Parameters<ShadowObservabilityRecorder['recordLatencySample']>[1]> = {}) {
  return {
    mint: 'MINT_A', observedAtMs: 1000, discoveryTimeMs: 0, signalTimeMs: 500, quoteTimeMs: null,
    simulationTimeMs: 600, exitSignalTimeMs: null, discoveryLatencyMs: 500, signalLatencyMs: 100,
    quoteLatencyMs: null, processingLatencyMs: 600, ...overrides,
  };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as unknown as { c: number }).c;
}
function counterValue(db: DatabaseSync, name: string): number | null {
  const row = db.prepare(`SELECT value FROM shadow_health_counters WHERE name = ?`).get(name) as unknown as { value: number } | undefined;
  return row?.value ?? null;
}

describe('ShadowObservabilityRecorder', () => {
  let db: DatabaseSync;
  let rec: ShadowObservabilityRecorder;

  beforeEach(() => {
    db = openLedger(':memory:');
    rec = new ShadowObservabilityRecorder(db);
  });

  afterEach(() => {
    rec.stop();
    vi.useRealTimers();
  });

  it('buffers records in memory and writes nothing to the DB before a flush', () => {
    rec.recordMissedSignal('m1', missedSignal());
    rec.recordDataQualityEvent('dq1', dqEvent());
    rec.recordLatencySample('lat1', latencySample());
    rec.incrementCounter('shadow_ticks_received', 1);
    expect(countRows(db, 'shadow_missed_signals')).toBe(0);
    expect(countRows(db, 'shadow_data_quality_events')).toBe(0);
    expect(countRows(db, 'shadow_latency_samples')).toBe(0);
    expect(countRows(db, 'shadow_health_counters')).toBe(0);
  });

  it('a trading-decision call returns synchronously without ever waiting on the DB write', () => {
    // Direct evidence for "trading decision remains independent of flush completion": pushing to the buffer is a
    // synchronous array push, so the calling code (ShadowRunner) is never blocked on I/O by these calls.
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) rec.recordMissedSignal(`m${i}`, missedSignal({ observedAtMs: 1000 + i }));
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(50); // 1000 in-memory pushes; a synchronous DB write per call would be far slower
    expect(countRows(db, 'shadow_missed_signals')).toBe(0);
  });

  it('multiple buffered writes across all four record types flush together in one transaction', () => {
    rec.recordMissedSignal('m1', missedSignal());
    rec.recordMissedSignal('m2', missedSignal({ observedAtMs: 1001 }));
    rec.recordDataQualityEvent('dq1', dqEvent());
    rec.recordDataQualityEvent('dq2', dqEvent({ observedAtMs: 1001 }));
    rec.recordLatencySample('lat1', latencySample());
    rec.incrementCounter('a', 1);
    const written = rec.flush();
    expect(written).toBe(6); // 2 + 2 + 1 + 1 distinct counter name
    expect(countRows(db, 'shadow_missed_signals')).toBe(2);
    expect(countRows(db, 'shadow_data_quality_events')).toBe(2);
    expect(countRows(db, 'shadow_latency_samples')).toBe(1);
    expect(countRows(db, 'shadow_health_counters')).toBe(1);
  });

  it('preserves ordering: rows are retrievable in the same order their own observedAtMs implies, across two flush cycles', () => {
    rec.recordMissedSignal('m1', missedSignal({ observedAtMs: 1000, detail: 'first' }));
    rec.recordMissedSignal('m2', missedSignal({ observedAtMs: 1001, detail: 'second' }));
    rec.flush();
    rec.recordMissedSignal('m3', missedSignal({ observedAtMs: 1002, detail: 'third' }));
    rec.flush();
    const rows = db.prepare(`SELECT detail FROM shadow_missed_signals ORDER BY observed_at_ms ASC`).all() as unknown as Array<{ detail: string }>;
    expect(rows.map((r) => r.detail)).toEqual(['first', 'second', 'third']);
  });

  it('coalesces multiple increments of the same counter name into ONE upsert per flush, summed correctly', () => {
    rec.incrementCounter('rpc_success', 1);
    rec.incrementCounter('rpc_success', 5);
    rec.incrementCounter('rpc_success', 2);
    const written = rec.flush();
    expect(written).toBe(1); // one row written for three calls -- proves coalescing, not one row per call
    expect(counterValue(db, 'rpc_success')).toBe(8);
  });

  it('keeps different counter keys fully isolated from each other', () => {
    rec.incrementCounter('rpc_success', 3);
    rec.incrementCounter('rpc_error', 1);
    rec.incrementCounter('quote_success', 10);
    rec.flush();
    expect(counterValue(db, 'rpc_success')).toBe(3);
    expect(counterValue(db, 'rpc_error')).toBe(1);
    expect(counterValue(db, 'quote_success')).toBe(10);
  });

  it('counter increments accumulate correctly across MULTIPLE flush cycles (upsert adds to the persisted total)', () => {
    rec.incrementCounter('shadow_ticks_received', 4);
    rec.flush();
    expect(counterValue(db, 'shadow_ticks_received')).toBe(4);
    rec.incrementCounter('shadow_ticks_received', 6);
    rec.flush();
    expect(counterValue(db, 'shadow_ticks_received')).toBe(10);
  });

  it('a flush failure increments writeFailures, does not throw, and drops that batch without corrupting later flushes', () => {
    rec.recordMissedSignal('dup', missedSignal());
    rec.flush(); // 'dup' now exists in the table
    rec.recordMissedSignal('dup', missedSignal({ detail: 'colliding id -- PRIMARY KEY violation' }));
    rec.recordDataQualityEvent('dq_lost_with_it', dqEvent()); // same transaction -- must roll back together
    expect(() => rec.flush()).not.toThrow();
    expect(rec.writeFailures).toBe(1);
    // the whole failed batch rolled back: the colliding row didn't overwrite, and the co-batched dq event was NOT partially committed
    expect(countRows(db, 'shadow_missed_signals')).toBe(1);
    expect(countRows(db, 'shadow_data_quality_events')).toBe(0);
    // the recorder itself remains fully usable for a later, non-conflicting flush
    rec.recordMissedSignal('not_a_duplicate', missedSignal());
    rec.flush();
    expect(countRows(db, 'shadow_missed_signals')).toBe(2);
  });

  it('bounds the buffer: pushing beyond maxBufferedRows drops the OLDEST entries and counts them, keeping the newest', () => {
    const small = new ShadowObservabilityRecorder(db, { maxBufferedRows: 3 });
    for (let i = 0; i < 5; i++) small.recordMissedSignal(`m${i}`, missedSignal({ observedAtMs: 1000 + i, detail: `n${i}` }));
    expect(small.droppedFromBuffer).toBe(2);
    small.flush();
    const rows = db.prepare(`SELECT detail FROM shadow_missed_signals ORDER BY observed_at_ms ASC`).all() as unknown as Array<{ detail: string }>;
    expect(rows.map((r) => r.detail)).toEqual(['n2', 'n3', 'n4']); // oldest two (n0, n1) dropped, newest three kept
  });

  it('flushes whatever remains buffered on stop() (clean shutdown), even without ever calling start()', () => {
    rec.recordMissedSignal('m1', missedSignal());
    rec.incrementCounter('shadow_ticks_received', 1);
    expect(countRows(db, 'shadow_missed_signals')).toBe(0);
    rec.stop();
    expect(countRows(db, 'shadow_missed_signals')).toBe(1);
    expect(counterValue(db, 'shadow_ticks_received')).toBe(1);
  });

  it('start() actually schedules a periodic flush at the configured interval', () => {
    vi.useFakeTimers();
    const timed = new ShadowObservabilityRecorder(db, { flushIntervalMs: 1000 });
    timed.recordMissedSignal('m1', missedSignal());
    timed.start();
    expect(countRows(db, 'shadow_missed_signals')).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(countRows(db, 'shadow_missed_signals')).toBe(1);
    timed.stop();
  });

  it('repeated flushes with no new data in between are safe no-ops (empty flush returns 0, writes nothing extra)', () => {
    rec.recordMissedSignal('m1', missedSignal());
    expect(rec.flush()).toBe(1);
    expect(rec.flush()).toBe(0);
    expect(rec.flush()).toBe(0);
    expect(countRows(db, 'shadow_missed_signals')).toBe(1);
  });

  it('normal operation across many writes and several flush cycles loses and duplicates nothing', () => {
    let expected = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let i = 0; i < 37; i++) {
        rec.recordDataQualityEvent(`dq_${cycle}_${i}`, dqEvent({ observedAtMs: 1000 + cycle * 100 + i }));
        expected += 1;
      }
      rec.flush();
    }
    expect(countRows(db, 'shadow_data_quality_events')).toBe(expected);
    expect(rec.written).toBe(expected);
  });
});
