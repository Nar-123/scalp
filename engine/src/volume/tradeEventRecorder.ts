import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CoverageChange } from './pumpfunVolumeEngine.js';
import type { LifecycleEvent, NormalizedTradeEvent } from './types.js';

export interface TradeEventRecorderOptions {
  /** Rows older than this (event time) are deleted. Default 24 h. */
  retentionHours?: number;
  /** Buffered rows beyond this are dropped (oldest first) and counted, never blocking the stream. */
  maxBufferedRows?: number;
  flushIntervalMs?: number;
  pruneIntervalMs?: number;
}

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
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly insTrade: StatementSync;
  private readonly insLife: StatementSync;
  private readonly insCov: StatementSync;
  private readonly retentionSec: number;
  private readonly maxBuffered: number;
  private readonly flushIntervalMs: number;
  private readonly pruneIntervalMs: number;

  written = 0;
  droppedFromBuffer = 0;
  writeFailures = 0;
  prunedRows = 0;

  constructor(private readonly db: DatabaseSync, options: TradeEventRecorderOptions = {}) {
    this.retentionSec = (options.retentionHours ?? 24) * 3600;
    this.maxBuffered = options.maxBufferedRows ?? 20_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.pruneIntervalMs = options.pruneIntervalMs ?? 5 * 60_000;
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
    this.pruneTimer = setInterval(() => this.prune(Date.now()), this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
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

  /** Deletes rows older than the retention horizon (relative to `nowMs`). */
  prune(nowMs: number): number {
    const cutSec = Math.floor(nowMs / 1000) - this.retentionSec;
    let removed = 0;
    try {
      removed += Number(this.db.prepare('DELETE FROM pumpfun_trade_events WHERE event_timestamp < ?').run(cutSec).changes);
      removed += Number(this.db.prepare('DELETE FROM pumpfun_lifecycle_events WHERE event_timestamp < ?').run(cutSec).changes);
      removed += Number(this.db.prepare('DELETE FROM volume_coverage_log WHERE at_ms < ?').run(cutSec * 1000).changes);
    } catch {
      this.writeFailures += 1;
    }
    this.prunedRows += removed;
    return removed;
  }
}
