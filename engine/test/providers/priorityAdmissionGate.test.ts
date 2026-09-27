import { describe, expect, it } from 'vitest';
import { PriorityAdmissionGate } from '../../src/providers/priorityAdmissionGate.js';

describe('PriorityAdmissionGate (production, Option A -- shared-RPC-capacity fix)', () => {
  it('admits immediately while under the concurrency bound', async () => {
    const g = new PriorityAdmissionGate(2);
    const result = await g.run('low', async () => 'ok');
    expect(result).toBe('ok');
    expect(g.activeCount).toBe(0);
  });

  it('queues beyond the bound and releases a slot to a waiter on completion', async () => {
    const g = new PriorityAdmissionGate(1);
    let secondStarted = false;
    let release1: () => void = () => undefined;
    const first = g.run('low', () => new Promise<void>((resolve) => { release1 = resolve; }));
    await Promise.resolve(); // let `first` claim the only slot
    expect(g.activeCount).toBe(1);
    const second = g.run('low', async () => { secondStarted = true; });
    await Promise.resolve();
    expect(secondStarted).toBe(false); // slot is taken; second must wait
    expect(g.pendingLow).toBe(1);
    release1();
    await first;
    await second;
    expect(secondStarted).toBe(true);
    expect(g.activeCount).toBe(0);
  });

  it('always promotes a waiting HIGH caller ahead of an earlier-arrived LOW caller', async () => {
    const g = new PriorityAdmissionGate(1);
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = g.run('low', () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    await Promise.resolve();

    // Both queue behind `first`; low arrives strictly before high.
    const low = g.run('low', async () => { order.push('low'); });
    await Promise.resolve();
    const high = g.run('high', async () => { order.push('high'); });
    await Promise.resolve();
    expect(g.pendingLow).toBe(1);
    expect(g.pendingHigh).toBe(1);

    releaseFirst();
    await first;
    await Promise.all([low, high]);
    expect(order).toEqual(['high', 'low']); // high wins despite arriving after low
  });

  it('releases the concurrency slot even when `fn` throws, so a failed caller cannot leak capacity', async () => {
    const g = new PriorityAdmissionGate(1);
    await expect(g.run('high', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(g.activeCount).toBe(0);
    const result = await g.run('high', async () => 'next caller gets a slot');
    expect(result).toBe('next caller gets a slot');
  });

  it('rejects a non-positive concurrency bound', () => {
    expect(() => new PriorityAdmissionGate(0)).toThrow();
    expect(() => new PriorityAdmissionGate(-1)).toThrow();
  });

  it('a LOW caller is admitted immediately when the HIGH queue is empty -- priority never blocks low when there is no contention', async () => {
    const g = new PriorityAdmissionGate(2);
    const result = await g.run('low', async () => 'served');
    expect(result).toBe('served');
    expect(g.activeCount).toBe(0);
  });

  it('LOW callers are not starved to zero: with no HIGH demand at all, a sustained stream of LOW callers keeps getting served', async () => {
    const g = new PriorityAdmissionGate(1);
    let served = 0;
    for (let i = 0; i < 50; i += 1) {
      // deliberately sequential: each must fully complete before the next is offered
      await g.run('low', async () => { served += 1; });
    }
    expect(served).toBe(50);
  });

  describe('shutdown', () => {
    it('rejects every WAITING caller cleanly, without ever calling their `fn` or leaking a slot', async () => {
      const g = new PriorityAdmissionGate(1);
      let releaseFirst: () => void = () => undefined;
      let waiterFnCalled = false;
      const first = g.run('low', () => new Promise<void>((resolve) => { releaseFirst = resolve; }));
      await Promise.resolve();
      const waiting = g.run('high', async () => { waiterFnCalled = true; });
      await Promise.resolve();
      expect(g.pendingHigh).toBe(1);

      g.shutdown();
      await expect(waiting).rejects.toThrow(/shut down/i);
      expect(waiterFnCalled).toBe(false); // never admitted, so its `fn` never ran
      expect(g.pendingHigh).toBe(0);

      releaseFirst();
      await first; // the caller already IN FLIGHT when shutdown() was called is unaffected by it
    });

    it('refuses every new `run()` call after shutdown without ever queueing it', async () => {
      const g = new PriorityAdmissionGate(2);
      g.shutdown();
      await expect(g.run('high', async () => 'never')).rejects.toThrow(/shut down/i);
      expect(g.pendingHigh).toBe(0);
      expect(g.pendingLow).toBe(0);
      expect(g.activeCount).toBe(0);
    });

    it('is idempotent and safe to call more than once', () => {
      const g = new PriorityAdmissionGate(1);
      expect(() => {
        g.shutdown();
        g.shutdown();
      }).not.toThrow();
      expect(g.isShutdown).toBe(true);
    });

    it('does not affect a caller already past admission and running `fn` when shutdown is called', async () => {
      const g = new PriorityAdmissionGate(1);
      let resolveFn: (v: string) => void = () => undefined;
      const inFlight = g.run('low', () => new Promise<string>((resolve) => { resolveFn = resolve; }));
      await Promise.resolve();
      expect(g.activeCount).toBe(1);
      g.shutdown();
      resolveFn('completed normally');
      await expect(inFlight).resolves.toBe('completed normally');
    });
  });
});
