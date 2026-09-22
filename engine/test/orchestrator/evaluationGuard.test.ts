import { describe, expect, it } from 'vitest';
import { EntryReservations, EvaluationGuard } from '../../src/orchestrator/evaluationGuard.js';

describe('EvaluationGuard (per-token in-flight guard)', () => {
  it('two ticks for the same token overlap: the second is skipped, synchronously, before any await', () => {
    const g = new EvaluationGuard(30_000);
    const a = g.tryAcquire('A');
    const b = g.tryAcquire('A'); // same JS turn: the "second tick" arrives while the first evaluation has not even awaited yet
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(g.skipped).toBe(1);
  });

  it('different tokens are independent (no global serialisation)', () => {
    const g = new EvaluationGuard(30_000);
    const a = g.tryAcquire('A');
    const b = g.tryAcquire('B');
    const c = g.tryAcquire('C');
    expect([a, b, c].every((x) => x !== null)).toBe(true);
    expect(g.inFlight).toBe(3);
    expect(g.tryAcquire('A')).toBeNull();
    expect(g.tryAcquire('B')).toBeNull();
    g.release(a!.lease);
    expect(g.tryAcquire('A')).not.toBeNull(); // only A's lease was freed
    expect(g.has('B')).toBe(true);
  });

  it('release makes the next tick able to evaluate (completion, failure and exception paths all release the same way)', () => {
    const g = new EvaluationGuard(30_000);
    for (const outcome of ['entered', 'rejected', 'quote_failed', 'threw']) {
      const a = g.tryAcquire('A');
      expect(a, outcome).not.toBeNull();
      expect(g.tryAcquire('A'), outcome).toBeNull();
      g.release(a!.lease);
      expect(g.inFlight).toBe(0);
    }
  });

  it('a timed-out (stuck) evaluation is superseded: the next tick takes over and the old holder can no longer commit', () => {
    let t = 1_000;
    const g = new EvaluationGuard(5_000, () => t);
    const stuck = g.tryAcquire('A')!;
    t += 4_999;
    expect(g.tryAcquire('A')).toBeNull(); // not yet timed out
    t += 2;
    const next = g.tryAcquire('A')!;
    expect(next.tookOverStale).toBe(true);
    expect(g.takeovers).toBe(1);
    expect(g.isCurrent(stuck.lease)).toBe(false); // the stale holder must not create an entry when it resumes
    expect(g.isCurrent(next.lease)).toBe(true);
    g.release(stuck.lease); // the stale holder finishing late does NOT free the new holder's lease
    expect(g.isCurrent(next.lease)).toBe(true);
    expect(g.tryAcquire('A')).toBeNull();
    g.release(next.lease);
    expect(g.tryAcquire('A')).not.toBeNull();
  });

  it('a lease is only current between acquire and release', () => {
    const g = new EvaluationGuard(30_000);
    const a = g.tryAcquire('A')!;
    expect(g.isCurrent(a.lease)).toBe(true);
    g.release(a.lease);
    expect(g.isCurrent(a.lease)).toBe(false);
    g.release(a.lease); // idempotent
  });

  it('rejects a non-positive timeout (a guard that can never expire would wedge a token forever)', () => {
    expect(() => new EvaluationGuard(0)).toThrow();
  });
});

describe('EntryReservations', () => {
  it('a second reservation for the same mint is refused until the first is released', () => {
    const r = new EntryReservations();
    expect(r.reserve('A', 0.3)).toBe(true);
    expect(r.reserve('A', 0.3)).toBe(false);
    r.release('A');
    expect(r.reserve('A', 0.3)).toBe(true);
  });

  it('pending entries are presented to the risk engine as open positions (limits hold under concurrency)', () => {
    const r = new EntryReservations();
    r.reserve('A', 0.3);
    r.reserve('B', 0.3);
    expect(r.asOpenPositions()).toEqual([
      { tradeId: 'pending_entry:A', mint: 'A', entrySizeSol: 0.3 },
      { tradeId: 'pending_entry:B', mint: 'B', entrySizeSol: 0.3 },
    ]);
    expect(r.size).toBe(2);
    r.release('A');
    r.release('B');
    expect(r.asOpenPositions()).toEqual([]);
  });
});
