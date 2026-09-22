import { describe, expect, it } from 'vitest';
import { EvaluationScheduler } from '../../src/orchestrator/evaluationScheduler.js';

/** Resolves after `ms`, tracking how many closures are concurrently running via `active`. */
function slowJob(active: { count: number; peak: number }, ms: number, completions: string[], label: string): () => Promise<void> {
  return async () => {
    active.count += 1;
    active.peak = Math.max(active.peak, active.count);
    await new Promise((r) => setTimeout(r, ms));
    active.count -= 1;
    completions.push(label);
  };
}

describe('EvaluationScheduler: global evaluation backpressure', () => {
  it('rejects a non-positive maxConcurrent', () => {
    expect(() => new EvaluationScheduler({ maxConcurrent: 0 })).toThrow();
    expect(() => new EvaluationScheduler({ maxConcurrent: -1 })).toThrow();
  });

  it('1/2. never runs more than maxConcurrent evaluations simultaneously, across many distinct tokens', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 4 });
    for (let i = 0; i < 20; i += 1) s.requestTick(`mint${i}`, slowJob(active, 20, completions, `mint${i}`));
    expect(s.activeCount).toBeLessThanOrEqual(4);
    expect(s.pendingCount).toBe(16); // the other 16 are coalesced-pending, not extra concurrent work
    await new Promise((r) => setTimeout(r, 300));
    expect(active.peak).toBeLessThanOrEqual(4);
    expect(completions).toHaveLength(20); // everything eventually ran exactly once
    expect(new Set(completions).size).toBe(20); // no duplicates
    expect(s.activeCount).toBe(0);
    expect(s.pendingCount).toBe(0);
  });

  it('3. a repeated tick for a token that is already active dispatches again if global capacity allows -- per-token exclusion is EvaluationGuard\'s job, not the scheduler\'s (this is what preserves stale-lease takeover; see test/pipeline/entryRace.test.ts test 5)', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 2 });
    s.requestTick('hot', slowJob(active, 40, completions, 'hot-1'));
    expect(s.isActive('hot')).toBe(true);
    s.requestTick('hot', slowJob(active, 40, completions, 'hot-2')); // a second concurrent dispatch for the SAME mint -- the scheduler does not dedupe by mint
    expect(s.activeCount).toBe(2); // both genuinely dispatched (global capacity allowed it)
    expect(s.pendingCount).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(completions.sort()).toEqual(['hot-1', 'hot-2']); // both ran -- in production, EvaluationGuard (not this scheduler) is what would reject the second as "still in flight" (or take it over if stale)
    expect(s.activeCount).toBe(0);
  });

  it('3c. once global capacity is exhausted, a repeated tick for an ALREADY-ACTIVE token still only coalesces to one pending signal (it does not bypass the pending Map)', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 1 });
    s.requestTick('hot', slowJob(active, 60, completions, 'hot-1')); // takes the only slot
    for (let i = 0; i < 5; i += 1) s.requestTick('hot', slowJob(active, 5, completions, `hot-pending-v${i}`)); // capacity is full -> pending, coalesced
    expect(s.pendingCount).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(completions).toEqual(['hot-1', 'hot-pending-v4']); // only the latest coalesced closure ran after hot-1 finished
  });

  it('3b. repeated ticks for the SAME token while it is PENDING coalesce to the latest closure, never a growing list', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 1 });
    s.requestTick('busy', slowJob(active, 60, completions, 'busy')); // takes the only slot
    s.requestTick('waiter', slowJob(active, 10, completions, 'waiter-v1'));
    s.requestTick('waiter', slowJob(active, 10, completions, 'waiter-v2')); // supersedes v1
    s.requestTick('waiter', slowJob(active, 10, completions, 'waiter-v3')); // supersedes v2
    expect(s.pendingCount).toBe(1); // exactly one entry for 'waiter', not three
    await new Promise((r) => setTimeout(r, 200));
    expect(completions).toEqual(['busy', 'waiter-v3']); // only the LATEST queued closure for 'waiter' ran
  });

  it('4. different tokens dispatch and run concurrently up to the limit', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 3 });
    s.requestTick('a', slowJob(active, 30, completions, 'a'));
    s.requestTick('b', slowJob(active, 30, completions, 'b'));
    s.requestTick('c', slowJob(active, 30, completions, 'c'));
    expect(s.activeCount).toBe(3);
    expect(active.count).toBe(3); // all three genuinely running at once, not serialized
    await new Promise((r) => setTimeout(r, 100));
    expect(completions.sort()).toEqual(['a', 'b', 'c']);
  });

  it('5. pendingCount is bounded by the number of DISTINCT tokens, never by the number of ticks (no unbounded queue growth)', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 2 });
    s.requestTick('x', slowJob(active, 100, completions, 'x'));
    s.requestTick('y', slowJob(active, 100, completions, 'y'));
    // 500 more ticks across only 10 distinct mints, all while x and y occupy both slots
    for (let round = 0; round < 50; round += 1) {
      for (let m = 0; m < 10; m += 1) {
        s.requestTick(`m${m}`, slowJob(active, 5, completions, `m${m}-round${round}`));
      }
    }
    expect(s.pendingCount).toBe(10); // exactly the 10 distinct mints, regardless of 500 ticks having arrived
  });

  it('6. FIFO fairness: the longest-waiting pending token is promoted first, and repeated hot-token ticks cannot cut in line', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 1 });
    s.requestTick('busy', slowJob(active, 30, completions, 'busy'));
    s.requestTick('first', slowJob(active, 5, completions, 'first'));
    s.requestTick('second', slowJob(active, 5, completions, 'second'));
    s.requestTick('third', slowJob(active, 5, completions, 'third'));
    // re-tick 'third' repeatedly (already pending): must NOT move it ahead of 'first'/'second'
    for (let i = 0; i < 10; i += 1) s.requestTick('third', slowJob(active, 5, completions, `third-v${i}`));
    await new Promise((r) => setTimeout(r, 200));
    expect(completions).toEqual(['busy', 'first', 'second', 'third-v9']); // FIFO order preserved; 'third' ran its LATEST closure
  });

  it('8. stop() clears pending work and refuses new dispatch; already-active work is left to finish on its own', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 1 });
    s.requestTick('running', slowJob(active, 50, completions, 'running'));
    s.requestTick('queued', slowJob(active, 5, completions, 'queued'));
    expect(s.pendingCount).toBe(1);
    s.stop();
    expect(s.pendingCount).toBe(0); // dropped by stop()
    s.requestTick('after-stop', slowJob(active, 5, completions, 'after-stop'));
    expect(s.pendingCount).toBe(0); // refused: stop() means no new dispatch and no new pending entries
    expect(s.activeCount).toBe(1); // the already-running evaluation was NOT cancelled
    await new Promise((r) => setTimeout(r, 100));
    expect(completions).toEqual(['running']); // it completed on its own; nothing queued behind it ran
    expect(s.activeCount).toBe(0);
  });

  it('13. sustained high-frequency ticking across many tokens never creates unlimited pending evaluations', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 4 });
    const TOKENS = 300;
    // Simulate EVAL_INTERVAL_MS-style repeated ticking for 300 watched tokens, firing every 2ms (compressed time),
    // for 200 ticks per token -- 60,000 total tick calls -- while evaluations take 10ms each (RPC-bound work).
    for (let tick = 0; tick < 200; tick += 1) {
      for (let m = 0; m < TOKENS; m += 1) {
        s.requestTick(`t${m}`, slowJob(active, 10, completions, `t${m}`));
      }
      expect(s.pendingCount).toBeLessThanOrEqual(TOKENS); // never more pending signals than distinct tokens exist
      expect(s.activeCount).toBeLessThanOrEqual(4); // never more concurrent work than the configured limit
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(active.peak).toBeLessThanOrEqual(4);
  });

  it('stress: hundreds of watched tokens with slow simulated RPC-bound evaluations keep making continuous progress (reproduces Phase 5.6M conditions under the fix)', async () => {
    const active = { count: 0, peak: 0 };
    const completions: string[] = [];
    const s = new EvaluationScheduler({ maxConcurrent: 4 }); // matches ProviderGate's default RPC maxConcurrent
    const TOKENS = 500;
    const RUN_MS = 3000;
    const stopAt = Date.now() + RUN_MS;
    // Each token's own EVAL_INTERVAL_MS=2000 timer, all firing independently and immediately.
    const timers = Array.from({ length: TOKENS }, (_, m) =>
      setInterval(() => {
        if (Date.now() >= stopAt) return;
        s.requestTick(`t${m}`, slowJob(active, 300, completions, `t${m}`)); // ~300ms, matching the observed VPS RPC latency
      }, 2000),
    );
    // fire the first tick for every token immediately, exactly like watchToken() does
    for (let m = 0; m < TOKENS; m += 1) s.requestTick(`t${m}`, slowJob(active, 300, completions, `t${m}-first`));

    const progressSamples: number[] = [];
    while (Date.now() < stopAt) {
      await new Promise((r) => setTimeout(r, 500));
      progressSamples.push(completions.length);
    }
    for (const t of timers) clearInterval(t);
    await new Promise((r) => setTimeout(r, 400)); // let the last in-flight batch finish

    // The core regression check: throughput must keep INCREASING over time, never plateau at a hard freeze the way
    // requests==700-then-zero did in the unfixed Phase 5.6M run.
    expect(completions.length).toBeGreaterThan(0);
    for (let i = 1; i < progressSamples.length; i += 1) {
      expect(progressSamples[i]).toBeGreaterThanOrEqual(progressSamples[i - 1]!); // monotonically non-decreasing
    }
    const distinctIncreases = new Set(progressSamples).size;
    expect(distinctIncreases).toBeGreaterThan(1); // it is not frozen at a single flat value for the whole run
    expect(active.peak).toBeLessThanOrEqual(4); // global concurrency never exceeded the derived limit
    expect(s.pendingCount).toBeLessThanOrEqual(TOKENS); // queue depth stayed bounded by the token count, never grew past it
  }, 10_000);
});
