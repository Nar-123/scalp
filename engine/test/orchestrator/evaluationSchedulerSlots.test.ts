import { describe, expect, it } from 'vitest';
import { EvaluationScheduler } from '../../src/orchestrator/evaluationScheduler.js';
import { evaluationSlotContext, type EvaluationSlot } from '../../src/providers/evaluationSlotContext.js';

const tick = () => new Promise<void>((r) => setImmediate(r));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const slotOf = (): EvaluationSlot => {
  const s = evaluationSlotContext.getStore();
  if (!s) throw new Error('no slot in context');
  return s;
};

describe('EvaluationScheduler slot handles (P1): a slot is for work, not for waiting on a provider', () => {
  it('suspend() gives the global slot back immediately: other ticks run although the suspended evaluations are still in flight', async () => {
    const sch = new EvaluationScheduler({ maxConcurrent: 2 });
    const waits = [deferred(), deferred()];
    const ran: string[] = [];
    sch.requestTick('a', async () => {
      slotOf().suspend();
      await waits[0]!.promise;
    });
    sch.requestTick('b', async () => {
      slotOf().suspend();
      await waits[1]!.promise;
    });
    expect(sch.activeCount).toBe(0); // both gave their slots back
    expect(sch.suspendedCount).toBe(2);
    for (const m of ['c', 'd']) sch.requestTick(m, async () => void ran.push(m));
    await tick();
    expect(ran).toEqual(['c', 'd']); // ran at once; with the old behaviour (a and b holding both slots) they would still be pending
    expect(sch.pendingCount).toBe(0);
    expect(sch.isActive('a')).toBe(true); // a suspended evaluation is still "in flight" for its mint
    waits.forEach((w) => w.resolve());
    await tick();
    expect(sch.isActive('a')).toBe(false);
    expect(sch.suspendedCount).toBe(0);
  });

  it('control: WITHOUT suspend() two long waiters keep both slots and every other tick is held back (the old behaviour)', async () => {
    const sch = new EvaluationScheduler({ maxConcurrent: 2 });
    const hold = deferred();
    const ran: string[] = [];
    sch.requestTick('a', () => hold.promise);
    sch.requestTick('b', () => hold.promise);
    for (const m of ['c', 'd']) sch.requestTick(m, async () => void ran.push(m));
    await tick();
    expect(ran).toEqual([]);
    expect(sch.pendingCount).toBe(2);
    hold.resolve();
    await tick();
    expect(ran).toEqual(['c', 'd']);
  });

  it('resume() queues FIFO for a slot and is served BEFORE any pending tick; resolves only once a slot is free', async () => {
    const sch = new EvaluationScheduler({ maxConcurrent: 1 });
    const order: string[] = [];
    const quote = deferred();
    const bWork = deferred();
    sch.requestTick('a', async () => {
      slotOf().suspend();
      order.push('a:suspended');
      await quote.promise;
      await slotOf().resume();
      order.push('a:resumed');
    });
    sch.requestTick('b', async () => {
      order.push('b:start');
      await bWork.promise;
      order.push('b:end');
    });
    sch.requestTick('c', async () => void order.push('c:start')); // pending behind b
    expect(sch.pendingCount).toBe(1);
    quote.resolve();
    await tick();
    expect(order).toEqual(['a:suspended', 'b:start']); // a wants its slot back but b holds it
    expect(sch.stats().resumeQueue).toBe(1);
    bWork.resolve();
    await tick();
    expect(order).toEqual(['a:suspended', 'b:start', 'b:end', 'a:resumed', 'c:start']); // a before c
    expect(sch.activeCount).toBe(0);
    expect(sch.suspendedCount).toBe(0);
  });

  it('the number of slots HELD never exceeds maxConcurrent, whatever the interleaving of suspends, resumes and ticks (randomised stress)', async () => {
    const MAX = 3;
    const sch = new EvaluationScheduler({ maxConcurrent: MAX });
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let held = 0;
    let maxHeld = 0;
    let finished = 0;
    const work = async (): Promise<void> => {
      held += 1;
      maxHeld = Math.max(maxHeld, held);
      await new Promise((r) => setTimeout(r, rnd() * 3));
      const slot = slotOf();
      if (rnd() < 0.6) {
        held -= 1;
        slot.suspend();
        await new Promise((r) => setTimeout(r, rnd() * 6));
        await slot.resume();
        held += 1;
        maxHeld = Math.max(maxHeld, held);
        await new Promise((r) => setTimeout(r, rnd() * 2));
      }
      held -= 1;
      finished += 1;
    };
    for (let i = 0; i < 400; i += 1) {
      sch.requestTick(`m${i % 120}`, work);
      if (i % 7 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    for (let i = 0; i < 400 && (sch.activeCount > 0 || sch.suspendedCount > 0 || sch.pendingCount > 0); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(maxHeld).toBeLessThanOrEqual(MAX);
    expect(sch.stats().maxActive).toBeLessThanOrEqual(MAX);
    expect(sch.activeCount).toBe(0);
    expect(sch.suspendedCount).toBe(0);
    expect(sch.pendingCount).toBe(0);
    expect(finished).toBeGreaterThan(50);
  }, 30_000);

  it('an evaluation that FAILS while suspended leaks nothing: counts return to zero and the scheduler keeps dispatching', async () => {
    const sch = new EvaluationScheduler({ maxConcurrent: 1 });
    sch.requestTick('a', async () => {
      slotOf().suspend();
      await tick();
      throw new Error('quote exploded');
    });
    await tick();
    await tick();
    expect(sch.activeCount).toBe(0);
    expect(sch.suspendedCount).toBe(0);
    expect(sch.isActive('a')).toBe(false);
    const ran: string[] = [];
    sch.requestTick('b', async () => void ran.push('b'));
    await tick();
    expect(ran).toEqual(['b']);
  });

  it('suspend/resume are idempotent and inert once the evaluation has finished', async () => {
    const sch = new EvaluationScheduler({ maxConcurrent: 2 });
    let leaked!: EvaluationSlot;
    sch.requestTick('a', async () => {
      const s = slotOf();
      leaked = s;
      s.suspend();
      s.suspend(); // second call changes nothing
      expect(sch.suspendedCount).toBe(1);
      await s.resume();
      await s.resume(); // already holding a slot: resolves at once
      expect(sch.activeCount).toBe(1);
    });
    await tick();
    expect(leaked.isLive()).toBe(false);
    leaked.suspend(); // a stale reference must not change any count
    await leaked.resume();
    expect(sch.activeCount).toBe(0);
    expect(sch.suspendedCount).toBe(0);
    expect(sch.stats().suspends).toBe(1);
  });

  it('stop(): clears pending ticks, refuses new ones and lets every resuming evaluation through at once (shutdown never waits on a slot)', async () => {
    const sch = new EvaluationScheduler({ maxConcurrent: 1 });
    const quote = deferred();
    const hold = deferred();
    const resumed: string[] = [];
    sch.requestTick('a', async () => {
      slotOf().suspend();
      await quote.promise;
      await slotOf().resume();
      resumed.push('a');
    });
    sch.requestTick('b', () => hold.promise); // takes the freed slot and keeps it
    sch.requestTick('c', async () => void resumed.push('c')); // pending
    quote.resolve();
    await tick();
    expect(sch.stats().resumeQueue).toBe(1);
    expect(sch.pendingCount).toBe(1);
    sch.stop();
    await tick();
    expect(resumed).toEqual(['a']); // released despite b still holding the only slot
    expect(sch.pendingCount).toBe(0);
    sch.requestTick('d', async () => void resumed.push('d'));
    await tick();
    expect(resumed).toEqual(['a']); // refused after stop
    hold.resolve();
    await tick();
    expect(sch.activeCount).toBe(0);
    expect(sch.suspendedCount).toBe(0);
  });

  it('tracks high-water marks and wait time for the P1 validation logs', async () => {
    const sch = new EvaluationScheduler({ maxConcurrent: 1 });
    const q = [deferred(), deferred()];
    const bWork = deferred();
    sch.requestTick('a', async () => {
      slotOf().suspend();
      await q[0]!.promise;
      await slotOf().resume();
    });
    sch.requestTick('b', () => bWork.promise);
    q[0]!.resolve();
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    bWork.resolve();
    await tick();
    const s = sch.stats();
    expect(s.maxActive).toBe(1);
    expect(s.maxSuspended).toBe(1);
    expect(s.maxResumeQueue).toBe(1);
    expect(s.resumeWaits).toBe(1);
    expect(s.resumeWaitMsMax).toBeGreaterThanOrEqual(15);
    expect(s.dispatched).toBe(2);
  });
});
