import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluationSlotContext, type EvaluationSlot } from '../../src/providers/evaluationSlotContext.js';
import { ProviderError } from '../../src/providers/providerGate.js';
import { QuoteStage, quoteStageOptions } from '../../src/providers/quoteStage.js';

/** A fake scheduler slot that records what the stage does to it. */
function fakeSlot(log: string[], name = 's') {
  let live = true;
  const slot: EvaluationSlot & { end(): void } = {
    key: name,
    isLive: () => live,
    suspend: () => void log.push(`${name}:suspend`),
    resume: async () => void log.push(`${name}:resume`),
    end: () => {
      live = false;
    },
  };
  return slot;
}
const inEvaluation = <T>(slot: EvaluationSlot, fn: () => Promise<T>) => evaluationSlotContext.run(slot, fn);
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const opts = { maxConcurrent: 2, maxQueued: 2, maxQueueWaitMs: 4000 };

describe('QuoteStage (P1): bounded admission above the quote gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a caller that is not an evaluation passes straight through: no slot, no permit, no limit', async () => {
    const stage = new QuoteStage(opts);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => stage.run(async () => i)));
    expect(results).toHaveLength(20);
    expect(stage.stats().passedThrough).toBe(20);
    expect(stage.stats().admitted).toBe(0);
  });

  it('a leftover handle of a FINISHED evaluation is inert (treated as not an evaluation)', async () => {
    const log: string[] = [];
    const slot = fakeSlot(log);
    slot.end();
    const stage = new QuoteStage(opts);
    await inEvaluation(slot, () => stage.run(async () => 'ok'));
    expect(log).toEqual([]);
    expect(stage.stats().passedThrough).toBe(1);
  });

  it('gives the slot back BEFORE waiting on the provider and takes one again AFTER, in that order', async () => {
    const log: string[] = [];
    const slot = fakeSlot(log);
    const stage = new QuoteStage(opts);
    const gate = deferred<string>();
    const p = inEvaluation(slot, () =>
      stage.run(async () => {
        log.push('provider:start');
        const v = await gate.promise;
        log.push('provider:done');
        return v;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['s:suspend', 'provider:start']); // slot is free while the provider call is pending
    gate.resolve('quote');
    await expect(p).resolves.toBe('quote');
    expect(log).toEqual(['s:suspend', 'provider:start', 'provider:done', 's:resume']);
    expect(stage.stats().permitsInUse).toBe(0);
  });

  it('never has more than maxConcurrent calls inside the provider; the next ones wait in FIFO order', async () => {
    const stage = new QuoteStage({ maxConcurrent: 2, maxQueued: 5, maxQueueWaitMs: 60_000 });
    const started: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred());
    let inside = 0;
    let maxInside = 0;
    const calls = gates.map((g, i) =>
      inEvaluation(fakeSlot([], `s${i}`), () =>
        stage.run(async () => {
          started.push(i);
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await g.promise;
          inside -= 1;
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1]); // 2 permits; 2..4 wait in line
    expect(stage.stats().queued).toBe(3);
    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2]); // FIFO: the longest-waiting goes next
    gates[1]!.resolve();
    gates[2]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[3]!.resolve();
    gates[4]!.resolve();
    await Promise.all(calls);
    expect(maxInside).toBeLessThanOrEqual(2);
    expect(stage.stats().maxPermitsInUse).toBeLessThanOrEqual(2);
  });

  it('FAIL CLOSED when there is no permit and no place in line: refused at once, the provider is never called, the slot comes back', async () => {
    const log: string[] = [];
    const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 60_000 });
    const hold = deferred();
    const fn = vi.fn(async () => hold.promise);
    const first = inEvaluation(fakeSlot([], 'a'), () => stage.run(fn)); // takes the permit
    const second = inEvaluation(fakeSlot([], 'b'), () => stage.run(fn)); // takes the one place in line
    await vi.advanceTimersByTimeAsync(0);
    const refused = inEvaluation(fakeSlot(log, 'c'), () => stage.run(fn));
    const err = await refused.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).reason).toBe('rate_limited');
    expect((err as ProviderError).providerKind).toBe('quote');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['c:suspend', 'c:resume']);
    expect(stage.stats().rejectedQueueFull).toBe(1);
    hold.resolve();
    await Promise.all([first, second]);
  });

  it('a waiter that waits too long is refused (fail closed), leaves the line, and the stage keeps working', async () => {
    const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 2, maxQueueWaitMs: 4000 });
    const hold = deferred();
    const first = inEvaluation(fakeSlot([], 'a'), () => stage.run(() => hold.promise));
    const log: string[] = [];
    const waiter = inEvaluation(fakeSlot(log, 'b'), () => stage.run(async () => 'never'));
    const waiterErr = waiter.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3999);
    expect(stage.stats().queued).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const err = await waiterErr;
    expect((err as ProviderError).reason).toBe('rate_limited');
    expect(stage.stats().queued).toBe(0);
    expect(stage.stats().rejectedWaitTimeout).toBe(1);
    expect(log).toEqual(['b:suspend', 'b:resume']);
    hold.resolve();
    await first;
    await expect(inEvaluation(fakeSlot([], 'c'), () => stage.run(async () => 'fine'))).resolves.toBe('fine');
    expect(vi.getTimerCount()).toBe(0); // no timer left behind
  });

  it('shutdown() refuses everything still waiting and every later request; calls already inside the gate finish on their own', async () => {
    const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 5, maxQueueWaitMs: 60_000 });
    const hold = deferred<string>();
    const inside = inEvaluation(fakeSlot([], 'in'), () => stage.run(() => hold.promise));
    const waiters = Array.from({ length: 4 }, (_, i) => inEvaluation(fakeSlot([], `w${i}`), () => stage.run(async () => 'x')).catch((e: unknown) => e));
    await vi.advanceTimersByTimeAsync(0);
    expect(stage.stats().queued).toBe(4);
    stage.shutdown();
    const errs = await Promise.all(waiters);
    for (const e of errs) expect((e as ProviderError).reason).toBe('shutdown');
    expect(stage.stats().queued).toBe(0);
    expect(stage.stats().rejectedShutdown).toBe(4);
    const late = await inEvaluation(fakeSlot([], 'late'), () => stage.run(async () => 'x')).catch((e: unknown) => e);
    expect((late as ProviderError).reason).toBe('shutdown');
    hold.resolve('done');
    await expect(inside).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failing provider call releases the permit and the slot and propagates the error', async () => {
    const log: string[] = [];
    const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 4000 });
    await expect(inEvaluation(fakeSlot(log), () => stage.run(async () => Promise.reject(new Error('boom'))))).rejects.toThrow('boom');
    expect(log).toEqual(['s:suspend', 's:resume']);
    expect(stage.stats().permitsInUse).toBe(0);
    await expect(inEvaluation(fakeSlot([], 'n'), () => stage.run(async () => 'next'))).resolves.toBe('next');
  });

  it('under a burst the number of calls inside the provider never exceeds the permits (stress)', async () => {
    const stage = new QuoteStage({ maxConcurrent: 4, maxQueued: 8, maxQueueWaitMs: 4000 });
    let inside = 0;
    let maxInside = 0;
    let served = 0;
    const burst = Array.from({ length: 300 }, (_, i) =>
      inEvaluation(fakeSlot([], `s${i}`), () =>
        stage.run(async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 50));
          inside -= 1;
          served += 1;
        }),
      ).catch(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(burst);
    const s = stage.stats();
    expect(maxInside).toBeLessThanOrEqual(4);
    expect(s.maxQueued).toBeLessThanOrEqual(8);
    expect(s.admitted).toBe(served);
    expect(s.rejectedQueueFull + s.rejectedWaitTimeout + s.admitted).toBe(300); // every request is accounted for
    expect(s.rejectedQueueFull).toBeGreaterThan(0); // and the overload really was refused, not queued without bound
  });

  describe('fairness: the token that has waited longest for the provider goes first', () => {
    const run = (stage: QuoteStage, key: string, hold: Promise<unknown>) => inEvaluation(fakeSlot([], key), () => stage.run(async () => (await hold, key))).catch((e: unknown) => e);

    it('a waiting line is served least-recently-admitted first, not in arrival order', async () => {
      const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 3, maxQueueWaitMs: 60_000 });
      const holds = Array.from({ length: 6 }, () => deferred());
      const order: string[] = [];
      const go = (key: string, i: number) =>
        inEvaluation(fakeSlot([], key), () =>
          stage.run(async () => {
            order.push(key);
            await holds[i]!.promise;
          }),
        );
      void go('A', 0); // admitted now (A's lastAdmit = 1)
      await vi.advanceTimersByTimeAsync(0);
      holds[0]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      void go('A', 1); // admitted again (lastAdmit = 2) and still holding the permit
      await vi.advanceTimersByTimeAsync(0);
      void go('A', 2); // A once more: waits in line with lastAdmit = 2
      void go('B', 3); // never admitted: arrives AFTER A but must be served BEFORE it
      void go('C', 4); // never admitted
      await vi.advanceTimersByTimeAsync(0);
      expect(stage.stats().queued).toBe(3);
      holds[1]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(order.slice(-1)).toEqual(['B']); // jumps the queue ahead of the earlier-arrived, more recently served A
      holds[3]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(order.slice(-1)).toEqual(['C']);
      holds[4]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(order.slice(-1)).toEqual(['A']);
      holds[2]!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    it('a full line is only ever taken over by someone who has waited LONGER than the least deserving waiter; the displaced one fails closed', async () => {
      const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 60_000 });
      const hold = deferred();
      void run(stage, 'A', hold.promise); // takes the permit
      await vi.advanceTimersByTimeAsync(0);
      const inLine = run(stage, 'B', hold.promise); // B (never admitted) takes the one place in line
      await vi.advanceTimersByTimeAsync(0);
      const sameRank = await run(stage, 'C', hold.promise); // also never admitted: equal rank, the incumbent keeps its place
      expect((sameRank as ProviderError).reason).toBe('rate_limited');
      expect(stage.stats().rejectedQueueFull).toBe(1);
      hold.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(inLine).resolves.toBe('B');
      // now A (admitted at seq 1) waits in line and D (never admitted) arrives: D has waited longer, so D takes the place
      const hold2 = deferred();
      void run(stage, 'X', hold2.promise); // takes the free permit
      await vi.advanceTimersByTimeAsync(0);
      const aWaiting = run(stage, 'A', hold2.promise);
      await vi.advanceTimersByTimeAsync(0);
      const dWaiting = run(stage, 'D', hold2.promise);
      const displaced = await aWaiting;
      expect((displaced as ProviderError).reason).toBe('rate_limited');
      expect(stage.stats().rejectedDisplaced).toBe(1);
      expect(stage.stats().queued).toBe(1);
      hold2.resolve();
      await expect(dWaiting).resolves.toBe('D');
    });

    it('over a long run with more tokens than the stage can hold, EVERY token is admitted and shares are even (no phase-locked starvation)', async () => {
      const stage = new QuoteStage({ maxConcurrent: 2, maxQueued: 2, maxQueueWaitMs: 3000 });
      const admitted = new Map<string, number>();
      const TOKENS = 10;
      for (let i = 0; i < TOKENS; i += 1) {
        const key = `t${i}`;
        void (async () => {
          await new Promise((r) => setTimeout(r, i * 7)); // fixed tick phase per token, as in production
          for (let n = 0; n < 150; n += 1) {
            await inEvaluation(fakeSlot([], key), () =>
              stage.run(async () => {
                admitted.set(key, (admitted.get(key) ?? 0) + 1);
                await new Promise((r) => setTimeout(r, 1000)); // the provider answers each permit holder in a second
              }),
            ).catch(() => undefined);
            await new Promise((r) => setTimeout(r, 2000)); // next tick
          }
        })();
      }
      await vi.advanceTimersByTimeAsync(300_000);
      expect(admitted.size).toBe(TOKENS);
      const counts = [...admitted.values()];
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(5);
      expect(Math.max(...counts) / Math.min(...counts)).toBeLessThanOrEqual(2);
    }, 60_000);
  });

  describe('continuation: a later quote of an evaluation that was already admitted', () => {
    it('is served ahead of a never-served token that queued EARLIER (it must not throw away the call it already spent)', async () => {
      const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 2, maxQueueWaitMs: 60_000 });
      const order: string[] = [];
      const slotX = fakeSlot([], 'x');
      await inEvaluation(slotX, () => stage.run(async () => 'leg 1')); // x is now a served evaluation (still live)
      const hold = deferred();
      const blocker = inEvaluation(fakeSlot([], 'blocker'), () => stage.run(() => hold.promise));
      await vi.advanceTimersByTimeAsync(0);
      const fresh = inEvaluation(fakeSlot([], 'fresh'), () => stage.run(async () => (order.push('fresh'), 'fresh')));
      await vi.advanceTimersByTimeAsync(0);
      const leg2 = inEvaluation(slotX, () => stage.run(async () => (order.push('x leg 2'), 'leg 2'))); // arrives AFTER fresh
      await vi.advanceTimersByTimeAsync(0);
      expect(stage.stats().queued).toBe(2);
      hold.resolve();
      await Promise.all([blocker, fresh, leg2]);
      expect(order).toEqual(['x leg 2', 'fresh']);
    });

    it('with a full line it takes the place of the least deserving NEW token, which is refused (fail closed)', async () => {
      const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 60_000 });
      const slotX = fakeSlot([], 'x');
      await inEvaluation(slotX, () => stage.run(async () => 'leg 1'));
      const hold = deferred();
      const blocker = inEvaluation(fakeSlot([], 'blocker'), () => stage.run(() => hold.promise));
      await vi.advanceTimersByTimeAsync(0);
      const fresh = inEvaluation(fakeSlot([], 'fresh'), () => stage.run(async () => 'fresh')).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(stage.stats().queued).toBe(1); // fresh holds the only place
      const leg2 = inEvaluation(slotX, () => stage.run(async () => 'leg 2'));
      await vi.advanceTimersByTimeAsync(0);
      expect(((await fresh) as ProviderError).reason).toBe('rate_limited');
      expect(stage.stats().rejectedDisplaced).toBe(1);
      hold.resolve();
      await expect(leg2).resolves.toBe('leg 2');
      await blocker;
    });

    it('a FIRST call of a new evaluation never counts as a continuation (one slot handle = one evaluation)', async () => {
      const stage = new QuoteStage({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 60_000 });
      const hold = deferred();
      const blocker = inEvaluation(fakeSlot([], 'blocker'), () => stage.run(() => hold.promise));
      await vi.advanceTimersByTimeAsync(0);
      const a = inEvaluation(fakeSlot([], 'a'), () => stage.run(async () => 'a')).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      const b = inEvaluation(fakeSlot([], 'b'), () => stage.run(async () => 'b')).catch((e: unknown) => e); // never admitted either: equal rank, a keeps its place
      await vi.advanceTimersByTimeAsync(0);
      expect(((await b) as ProviderError).reason).toBe('rate_limited');
      expect(stage.stats().rejectedDisplaced).toBe(0);
      hold.resolve();
      await expect(a).resolves.toBe('a');
      await blocker;
    });
  });

  it('is sized from the gate\'s EXISTING configuration only', () => {
    // keyless Jupiter (0.5 req/s, 4 s timeout): 2 permits keep the in-gate wait to one timeout; 2 servable places in line
    expect(quoteStageOptions({ maxConcurrent: 4, maxRequestsPerSecond: 0.5, timeoutMs: 4000 })).toEqual({ maxConcurrent: 2, maxQueued: 2, maxQueueWaitMs: 4000 });
    expect(quoteStageOptions({ maxConcurrent: 4, maxRequestsPerSecond: 4, timeoutMs: 4000 })).toEqual({ maxConcurrent: 4, maxQueued: 8, maxQueueWaitMs: 4000 }); // never above the gate's own concurrency; line capped at twice the permits
    expect(quoteStageOptions({ maxConcurrent: 2, maxRequestsPerSecond: 0.1, timeoutMs: 1000 })).toEqual({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 1000 }); // never fewer than one permit / one place
    expect(quoteStageOptions({ maxConcurrent: 4, maxRequestsPerSecond: 1, timeoutMs: 4000 }).maxConcurrent).toBe(4); // exactly one timeout's worth
    expect(quoteStageOptions({ maxConcurrent: 4, maxRequestsPerSecond: 0.75, timeoutMs: 4000 }).maxConcurrent).toBe(3); // rounded DOWN: never more waiting than one timeout
  });

  it('rejects nonsensical options', () => {
    expect(() => new QuoteStage({ maxConcurrent: 0, maxQueued: 1, maxQueueWaitMs: 1 })).toThrow();
    expect(() => new QuoteStage({ maxConcurrent: 1, maxQueued: -1, maxQueueWaitMs: 1 })).toThrow();
    expect(() => new QuoteStage({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 0 })).toThrow();
  });
});
