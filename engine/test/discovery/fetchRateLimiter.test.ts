import { describe, expect, it } from 'vitest';
import { FetchRateLimiter } from '../../src/discovery/fetchRateLimiter.js';

describe('FetchRateLimiter', () => {
  it('allows up to maxPerWindow calls, then rejects the rest within the same window', () => {
    const t = 1_000_000;
    const limiter = new FetchRateLimiter(3, () => t);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false); // 4th call in the same window is rejected
    expect(limiter.allow()).toBe(false);
  });

  it('resets once 1000ms has elapsed since the window started', () => {
    let t = 1_000_000;
    const limiter = new FetchRateLimiter(1, () => t);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    t += 999;
    expect(limiter.allow()).toBe(false); // still within the same window
    t += 1;
    expect(limiter.allow()).toBe(true); // window has rolled over
  });

  it('a rejected call is purely synchronous -- returns a boolean, never a Promise, and never mutates state on rejection beyond the check itself', () => {
    const t = 1_000_000;
    const limiter = new FetchRateLimiter(1, () => t);
    const first = limiter.allow();
    const second = limiter.allow();
    expect(typeof first).toBe('boolean');
    expect(typeof second).toBe('boolean');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('default clock (Date.now) works without an injected now()', () => {
    const limiter = new FetchRateLimiter(1);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
  });

  it('rejects a non-positive maxPerWindow', () => {
    expect(() => new FetchRateLimiter(0)).toThrow();
    expect(() => new FetchRateLimiter(-1)).toThrow();
  });
});
