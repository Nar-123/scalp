import { statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CoverageChange } from './pumpfunVolumeEngine.js';
import type { LifecycleEvent, NormalizedTradeEvent } from './types.js';

/**
 * Retention is enforced in small bounded slices, never as one big statement. A single synchronous DELETE of millions
 * of rows (what the first prune after a multi-day restart gap used to be) blocks the one event-loop thread for
 * minutes, and everything that depends on that loop -- WebSocket pings, evaluation timers, shutdown -- stalls with it.
 */
export interface BoundedPruneOptions {
  /** Rows per table per slice to start from; adapts between min and max to keep a slice near targetSliceMs. */
  batchRows?: number;
  minBatchRows?: number;
  maxBatchRows?: number;
  /** A slice should take about this long: twice as long halves the batch; half as long (with a full batch) grows it. */
  targetSliceMs?: number;
  /** Lower bound of the pause between slices; the pause is also at least dutyFactor x the last slice's duration. */
  minPauseMs?: number;
  dutyFactor?: number;
  maxPauseMs?: number;
  /** A slice whose timer fired later than this (event loop busy) is skipped and the pause doubled. */
  maxLoopLagMs?: number;
  /** No slice while free space on the ledger's filesystem is below this. */
  minFreeBytes?: number;
  /** No slice while the WAL file is larger than this (let the checkpoint catch up before adding more churn). */
  maxWalBytes?: number;
  /** How long to wait before re-checking after a pressure pause. */
  pressureRecheckMs?: number;
}

export interface TradeEventRecorderOptions {
  /** Rows older than this (event time) are deleted. Default 24 h. */
  retentionHours?: number;
  /** Buffered rows beyond this are dropped (oldest first) and counted, never blocking the stream. */
  maxBufferedRows?: number;
  flushIntervalMs?: number;
  /** Delay before the first prune slice after start(), and the pause between passes once nothing is left to prune. */
  pruneIntervalMs?: number;
  prune?: BoundedPruneOptions;
}

const DEFAULT_PRUNE: Required<BoundedPruneOptions> = {
  batchRows: 100,
  minBatchRows: 20,
  maxBatchRows: 2000,
  targetSliceMs: 40,
  minPauseMs: 25,
  dutyFactor: 4,
  maxPauseMs: 5000,
  maxLoopLagMs: 250,
  minFreeBytes: 2 * 1024 ** 3,
  maxWalBytes: 256 * 1024 ** 2,
  pressureRecheckMs: 5000,
};

/**
 * Bounded, batched persistence of normalized events. The recorder is an
 * observer: it can never influence a live volume value, and a database
 * failure only increments `writeFailures` (the stream keeps flowing).
 * Only events the engine ACCEPTED (successful transaction, valid, not a
 * duplicate) are recorded; `INSERT OR IGNORE` on the event identity makes a
 * restart or an overlapping delivery idempotent.
 */
export class TradeEventRecorder {
  private trades: NormalizedTradeEvent[] = [];
  private lifecycle: LifecycleEvent[] = [];
  private coverage: CoverageChange[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pruneTimeout: ReturnType<typeof setTimeout> | null = null;
  private pruneStopped = true;
  private pruneDueAtMs = 0;
  private pausedForLagMs = 0;
  private readonly insTrade: StatementSync;
  private readonly insLife: StatementSync;
  private readonly insCov: StatementSync;
  private readonly retentionSec: number;
  private readonly maxBuffered: number;
  private readonly flushIntervalMs: number;
  private readonly pruneIntervalMs: number;
  private readonly pruneOpts: Required<BoundedPruneOptions>;
  private readonly dbFile: string | null;

  written = 0;
  droppedFromBuffer = 0;
  writeFailures = 0;
  prunedRows = 0;
  /** Prune observability: how it is behaving while it works through a backlog. */
  pruneSlices = 0;
  pruneMaxSliceMs = 0;
  pruneSkippedForPressure = 0;
  pruneSkippedForLag = 0;
  pruneBatchRows: number;

  constructor(private readonly db: DatabaseSync, options: TradeEventRecorderOptions = {}) {
    this.retentionSec = (options.retentionHours ?? 24) * 3600;
    this.maxBuffered = options.maxBufferedRows ?? 20_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.pruneIntervalMs = options.pruneIntervalMs ?? 5 * 60_000;
    this.pruneOpts = { ...DEFAULT_PRUNE, ...(options.prune ?? {}) };
    this.pruneBatchRows = Math.min(this.pruneOpts.maxBatchRows, Math.max(this.pruneOpts.minBatchRows, this.pruneOpts.batchRows));
    this.dbFile = this.resolveDbFile();
    this.insTrade = db.prepare(
      `INSERT OR IGNORE INTO pumpfun_trade_events
       (signature, program, event_ordinal, mint, sol_amount_lamports, token_amount, is_buy, event_timestamp, slot, quote_mint, quote_class, source, received_at_ms,
        virtual_sol_reserves, virtual_token_reserves, real_sol_reserves, real_token_reserves, fee_basis_points, creator_fee_basis_points, mayhem_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insLife = db.prepare(
      `INSERT OR IGNORE INTO pumpfun_lifecycle_events
       (signature, program, event_ordinal, kind, mint, event_timestamp, slot, quote_mint, received_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insCov = db.prepare(`INSERT INTO volume_coverage_log (at_ms, event_second, kind, reason, epoch) VALUES (?, ?, ?, ?, ?)`);
  }

  recordTrade(e: NormalizedTradeEvent): void {
    this.trades.push(e);
    if (this.trades.length > this.maxBuffered) {
      this.trades.shift();
      this.droppedFromBuffer += 1;
    }
  }

  recordLifecycle(e: LifecycleEvent): void {
    this.lifecycle.push(e);
    if (this.lifecycle.length > this.maxBuffered) {
      this.lifecycle.shift();
      this.droppedFromBuffer += 1;
    }
  }

  recordCoverage(c: CoverageChange): void {
    this.coverage.push(c);
    if (this.coverage.length > 5000) {
      this.coverage.shift();
      this.droppedFromBuffer += 1;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
    this.pruneStopped = false;
    this.schedulePrune(this.pruneIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Slices are synchronous and each DELETE is its own atomic statement, so stopping between slices (the only place
    // a stop can happen on a single thread) never leaves a half-applied change for SQLite/WAL to recover from.
    this.pruneStopped = true;
    if (this.pruneTimeout) clearTimeout(this.pruneTimeout);
    this.pruneTimeout = null;
    this.flush();
  }

  /** Writes everything buffered in one transaction. Returns rows written. */
  flush(): number {
    if (this.trades.length + this.lifecycle.length + this.coverage.length === 0) return 0;
    const trades = this.trades;
    const life = this.lifecycle;
    const cov = this.coverage;
    this.trades = [];
    this.lifecycle = [];
    this.coverage = [];
    let n = 0;
    try {
      this.db.exec('BEGIN');
      for (const e of trades) {
        const c = e.curve;
        this.insTrade.run(
          e.signature,
          e.program,
          e.eventOrdinal,
          e.mint,
          e.solAmountLamports,
          e.tokenAmount,
          e.isBuy ? 1 : 0,
          e.eventTimestampSec,
          e.slot,
          e.quoteMint,
          e.quoteClass,
          e.source,
          e.receivedAtMs,
          c ? c.virtualSolReserves.toString() : null,
          c ? c.virtualTokenReserves.toString() : null,
          c ? c.realSolReserves.toString() : null,
          c ? c.realTokenReserves.toString() : null,
          c ? c.feeBasisPoints : null,
          c ? c.creatorFeeBasisPoints : null,
          c && c.mayhemMode !== null ? (c.mayhemMode ? 1 : 0) : null,
        );
        n += 1;
      }
      for (const l of life) {
        this.insLife.run(l.signature, l.program, l.eventOrdinal, l.kind, l.mint, l.eventTimestampSec, l.slot, l.quoteMint, l.receivedAtMs);
        n += 1;
      }
      for (const c of cov) {
        this.insCov.run(c.atMs, c.eventSec, c.kind, c.reason, c.epoch);
        n += 1;
      }
      this.db.exec('COMMIT');
      this.written += n;
    } catch {
      this.writeFailures += 1;
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // no open transaction
      }
    }
    return n;
  }

  /**
   * Deletes at most one bounded batch of rows older than the retention horizon (relative to `nowMs`) and returns how
   * many it removed. It is deliberately NOT "delete everything expired": call it repeatedly (the timer does) to work
   * through a backlog. Oldest rows go first, via the event-time indexes, so each slice costs O(batch), not O(table).
   */
  prune(nowMs: number): number {
    return this.pruneSlice(nowMs, this.pruneBatchRows).removed;
  }

  private pruneSlice(nowMs: number, batch: number): { removed: number; more: boolean } {
    const cutSec = Math.floor(nowMs / 1000) - this.retentionSec;
    const small = Math.max(this.pruneOpts.minBatchRows, Math.floor(batch / 10));
    let removed = 0;
    let more = false;
    try {
      const t = Number(
        this.db
          .prepare('DELETE FROM pumpfun_trade_events WHERE rowid IN (SELECT rowid FROM pumpfun_trade_events WHERE event_timestamp < ? ORDER BY event_timestamp LIMIT ?)')
          .run(cutSec, batch).changes,
      );
      const l = Number(
        this.db
          .prepare('DELETE FROM pumpfun_lifecycle_events WHERE rowid IN (SELECT rowid FROM pumpfun_lifecycle_events WHERE event_timestamp < ? LIMIT ?)')
          .run(cutSec, small).changes,
      );
      const c = Number(
        this.db
          .prepare('DELETE FROM volume_coverage_log WHERE rowid IN (SELECT rowid FROM volume_coverage_log WHERE at_ms < ? ORDER BY at_ms LIMIT ?)')
          .run(cutSec * 1000, small).changes,
      );
      removed = t + l + c;
      more = t >= batch || l >= small || c >= small;
    } catch {
      this.writeFailures += 1;
    }
    this.prunedRows += removed;
    return { removed, more };
  }

  private schedulePrune(delayMs: number): void {
    if (this.pruneStopped) return;
    this.pruneDueAtMs = Date.now() + delayMs;
    this.pruneTimeout = setTimeout(() => this.pruneTick(), delayMs);
    this.pruneTimeout.unref?.();
  }

  private pruneTick(): void {
    this.pruneTimeout = null;
    if (this.pruneStopped) return;
    const o = this.pruneOpts;
    // If this timer fired much later than asked, the loop is busy with something more important: back off.
    const lateMs = Date.now() - this.pruneDueAtMs;
    if (lateMs > o.maxLoopLagMs) {
      this.pruneSkippedForLag += 1;
      this.pausedForLagMs = Math.min(o.maxPauseMs, Math.max(o.minPauseMs, this.pausedForLagMs * 2));
      this.schedulePrune(this.pausedForLagMs);
      return;
    }
    this.pausedForLagMs = 0;
    if (this.underPressure()) {
      this.pruneSkippedForPressure += 1;
      this.schedulePrune(o.pressureRecheckMs);
      return;
    }
    const batch = this.pruneBatchRows;
    const t0 = performance.now();
    const { removed, more } = this.pruneSlice(Date.now(), batch);
    const elapsedMs = performance.now() - t0;
    this.pruneSlices += 1;
    if (elapsedMs > this.pruneMaxSliceMs) this.pruneMaxSliceMs = elapsedMs;
    if (elapsedMs > o.targetSliceMs * 2) this.pruneBatchRows = Math.max(o.minBatchRows, Math.floor(batch / 2));
    else if (elapsedMs < o.targetSliceMs / 2 && removed >= batch) this.pruneBatchRows = Math.min(o.maxBatchRows, Math.ceil(batch * 1.25));
    if (more) this.schedulePrune(Math.min(o.maxPauseMs, Math.max(o.minPauseMs, elapsedMs * o.dutyFactor)));
    else this.schedulePrune(this.pruneIntervalMs);
  }

  /** True while the disk is nearly full or the WAL is already large: more delete churn would only make either worse. */
  private underPressure(): boolean {
    if (this.dbFile === null) return false;
    try {
      const wal = statSync(`${this.dbFile}-wal`, { throwIfNoEntry: false });
      if (wal && wal.size > this.pruneOpts.maxWalBytes) return true;
      const fs = statfsSync(dirname(this.dbFile));
      if (fs.bavail * fs.bsize < this.pruneOpts.minFreeBytes) return true;
    } catch {
      // cannot measure: do not let a monitoring failure block retention
    }
    return false;
  }

  private resolveDbFile(): string | null {
    try {
      const rows = this.db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
      const main = rows.find((r) => r.name === 'main');
      return main && main.file ? main.file : null;
    } catch {
      return null;
    }
  }
}
