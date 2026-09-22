/**
 * Bounded FIFO identity set. Size is capped in two ways so it can never grow
 * without limit: entries older than the event-time horizon are dropped as the
 * watermark advances, and a hard cap evicts the oldest arrivals regardless.
 *
 * Correctness note: eviction can only make a very old duplicate look new. That
 * is safe because the engine refuses events older than its retention horizon
 * BEFORE consulting this set, and the set's horizon is >= that retention.
 */
export class BoundedIdentitySet {
  private readonly present = new Map<string, number>(); // key -> event second (insertion-ordered)
  private evictedByCap = 0;

  constructor(private readonly maxEntries: number) {
    if (maxEntries < 1) throw new Error('maxEntries must be >= 1');
  }

  /** true if the key was newly added, false if it was already present (duplicate). */
  add(key: string, eventSec: number): boolean {
    if (this.present.has(key)) return false;
    this.present.set(key, eventSec);
    while (this.present.size > this.maxEntries) {
      const oldest = this.present.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.present.delete(oldest);
      this.evictedByCap += 1;
    }
    return true;
  }

  has(key: string): boolean {
    return this.present.has(key);
  }

  /** Drops entries whose event second is older than `minSec`. Insertion order ~ arrival order, so scan from the head. */
  pruneOlderThan(minSec: number): void {
    for (const [key, sec] of this.present) {
      if (sec < minSec) this.present.delete(key);
      else break;
    }
  }

  clear(): void {
    this.present.clear();
  }

  get size(): number {
    return this.present.size;
  }

  get capEvictions(): number {
    return this.evictedByCap;
  }
}

export interface SecondBucket {
  buyLamports: number;
  sellLamports: number;
  count: number;
  buyCount: number;
}

/**
 * Per-mint, per-second volume buckets in integer lamports (exact: no float
 * accumulation). Event time has 1 s precision, so a bucket loses nothing
 * relative to individual events for any whole-second window.
 */
export class SecondBucketStore {
  private readonly byMint = new Map<string, Map<number, SecondBucket>>();
  private bucketCount = 0;

  add(mint: string, sec: number, lamports: number, isBuy: boolean): void {
    let buckets = this.byMint.get(mint);
    if (!buckets) {
      buckets = new Map();
      this.byMint.set(mint, buckets);
    }
    let b = buckets.get(sec);
    if (!b) {
      b = { buyLamports: 0, sellLamports: 0, count: 0, buyCount: 0 };
      buckets.set(sec, b);
      this.bucketCount += 1;
    }
    if (isBuy) {
      b.buyLamports += lamports;
      b.buyCount += 1;
    } else b.sellLamports += lamports;
    b.count += 1;
  }

  /** Sum of buys+sells and event count over whole seconds in [fromSec, toSec] (inclusive). */
  sum(mint: string, fromSec: number, toSec: number): { lamports: number; count: number; buyCount: number; buyLamports: number } {
    const buckets = this.byMint.get(mint);
    let lamports = 0;
    let count = 0;
    let buyCount = 0;
    let buyLamports = 0;
    if (!buckets) return { lamports, count, buyCount, buyLamports };
    for (let s = fromSec; s <= toSec; s += 1) {
      const b = buckets.get(s);
      if (b) {
        lamports += b.buyLamports + b.sellLamports;
        count += b.count;
        buyCount += b.buyCount;
        buyLamports += b.buyLamports;
      }
    }
    return { lamports, count, buyCount, buyLamports };
  }

  hasMint(mint: string): boolean {
    return this.byMint.has(mint);
  }

  /** Removes every bucket older than `minSec`; returns how many were removed. */
  pruneOlderThan(minSec: number): number {
    let removed = 0;
    for (const [mint, buckets] of this.byMint) {
      for (const sec of buckets.keys()) {
        if (sec < minSec) {
          buckets.delete(sec);
          removed += 1;
        }
      }
      if (buckets.size === 0) this.byMint.delete(mint);
    }
    this.bucketCount -= removed;
    return removed;
  }

  /** Drops the oldest seconds until at most `maxBuckets` remain (capacity safety valve). Returns buckets dropped. */
  enforceCap(maxBuckets: number): number {
    if (this.bucketCount <= maxBuckets) return 0;
    const secs = new Set<number>();
    for (const buckets of this.byMint.values()) for (const s of buckets.keys()) secs.add(s);
    const ordered = [...secs].sort((a, b) => a - b);
    let dropped = 0;
    for (const s of ordered) {
      if (this.bucketCount - dropped <= maxBuckets) break;
      for (const [mint, buckets] of this.byMint) {
        if (buckets.delete(s)) dropped += 1;
        if (buckets.size === 0) this.byMint.delete(mint);
      }
    }
    this.bucketCount -= dropped;
    return dropped;
  }

  clear(): void {
    this.byMint.clear();
    this.bucketCount = 0;
  }

  get buckets(): number {
    return this.bucketCount;
  }

  get mints(): number {
    return this.byMint.size;
  }
}
