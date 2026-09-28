import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DataQualityEventRecord, LatencySampleRecord, MissedSignalRecord } from './types.js';

export interface ShadowObservabilityRecorderOptions {
  /** Buffered rows beyond this are dropped (oldest first) and counted, never blocking the caller. Same default as
   * volume/tradeEventRecorder.ts's identical field, the existing project convention for this kind of buffer. */
  maxBufferedRows?: number;
  flushIntervalMs?: number;
}

/**
 * Bounded, batched persistence for the four Shadow observability write paths (investigate/production-fetch-abandon
 * Phase 2): recordMissedSignal, recordDataQualityEvent, recordLatencySample, and health-counter increments. These
 * are pure observations -- ShadowRunner never reads any of them back to make an entry/exit/risk decision (see
 * shadowLedger.ts's recordMissedSignal/recordDataQualityEvent/recordLatencySample/incrementCounter doc comments)
 * -- so persisting them can be deferred exactly like volume/tradeEventRecorder.ts already defers trade/lifecycle/
 * coverage events: buffered in memory, written in ONE transaction per flush, on a periodic timer. A flush failure
 * increments `writeFailures` and drops that batch (never retried, never thrown) -- the same convention
 * TradeEventRecorder already uses, chosen deliberately so a transient DB error can never propagate into, or block,
 * live evaluation.
 *
 * Counter increments are coalesced in memory (summed per name) between flushes and written as a SINGLE upsert per
 * distinct name per flush window, not one row per increment call -- addition is associative, so the persisted total
 * converges to the exact same value as one upsert per call would have produced, just with up to `flushIntervalMs`
 * of added staleness. This is safe because HealthCounters (shadowStatus.ts) already keeps its OWN authoritative
 * in-memory Map for every in-process reader; the sink into this recorder exists ONLY so the separate, already
 * eventually-consistent `shadow status` CLI process can see counts from disk.
 */
export class ShadowObservabilityRecorder {
  private missedSignals: Array<{ id: string; signal: MissedSignalRecord }> = [];
  private dataQualityEvents: Array<{ id: string; event: DataQualityEventRecord }> = [];
  private latencySamples: Array<{ id: string; sample: LatencySampleRecord }> = [];
  /** Counter deltas accumulated since the last flush, keyed by counter name. The key space is a small, fixed set
   * of literal strings from shadowStatus.ts/orchestrator code (rpc_success, shadow_ticks_received, ...), never
   * user- or mint-controlled, so it is inherently bounded without a separate drop-oldest policy. */
  private counterDeltas = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxBuffered: number;
  private readonly flushIntervalMs: number;
  private readonly insMissedSignal: StatementSync;
  private readonly insDataQualityEvent: StatementSync;
  private readonly insLatencySample: StatementSync;
  private readonly upsertCounter: StatementSync;

  written = 0;
  droppedFromBuffer = 0;
  writeFailures = 0;

  constructor(
    private readonly db: DatabaseSync,
    options: ShadowObservabilityRecorderOptions = {},
  ) {
    this.maxBuffered = options.maxBufferedRows ?? 20_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.insMissedSignal = db.prepare(
      `INSERT INTO shadow_missed_signals (id, strategy_version, mint, observed_at_ms, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.insDataQualityEvent = db.prepare(
      `INSERT INTO shadow_data_quality_events (id, strategy_version, mint, observed_at_ms, kind, severity, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insLatencySample = db.prepare(
      `INSERT INTO shadow_latency_samples (
        id, mint, observed_at_ms, discovery_time_ms, signal_time_ms, quote_time_ms, simulation_time_ms,
        exit_signal_time_ms, discovery_latency_ms, signal_latency_ms, quote_latency_ms, processing_latency_ms,
        detected_at_ms, market_data_time_ms, market_data_latency_ms, shadow_processing_latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.upsertCounter = db.prepare(
      `INSERT INTO shadow_health_counters (name, value, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET value = value + excluded.value, updated_at_ms = excluded.updated_at_ms`,
    );
  }

  recordMissedSignal(id: string, signal: MissedSignalRecord): void {
    this.missedSignals.push({ id, signal });
    if (this.missedSignals.length > this.maxBuffered) {
      this.missedSignals.shift();
      this.droppedFromBuffer += 1;
    }
  }

  recordDataQualityEvent(id: string, event: DataQualityEventRecord): void {
    this.dataQualityEvents.push({ id, event });
    if (this.dataQualityEvents.length > this.maxBuffered) {
      this.dataQualityEvents.shift();
      this.droppedFromBuffer += 1;
    }
  }

  recordLatencySample(id: string, sample: LatencySampleRecord): void {
    this.latencySamples.push({ id, sample });
    if (this.latencySamples.length > this.maxBuffered) {
      this.latencySamples.shift();
      this.droppedFromBuffer += 1;
    }
  }

  incrementCounter(name: string, by = 1): void {
    this.counterDeltas.set(name, (this.counterDeltas.get(name) ?? 0) + by);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  /** Writes everything buffered in one transaction (one upsert per distinct counter name, coalesced). Returns rows written. */
  flush(): number {
    if (this.missedSignals.length + this.dataQualityEvents.length + this.latencySamples.length + this.counterDeltas.size === 0) return 0;
    const missed = this.missedSignals;
    const dq = this.dataQualityEvents;
    const lat = this.latencySamples;
    const counters = this.counterDeltas;
    this.missedSignals = [];
    this.dataQualityEvents = [];
    this.latencySamples = [];
    this.counterDeltas = new Map();
    let n = 0;
    try {
      this.db.exec('BEGIN');
      for (const { id, signal } of missed) {
        this.insMissedSignal.run(id, signal.strategyVersion, signal.mint, signal.observedAtMs, signal.reason, signal.detail);
        n += 1;
      }
      for (const { id, event } of dq) {
        this.insDataQualityEvent.run(id, event.strategyVersion, event.mint, event.observedAtMs, event.kind, event.severity, event.detail);
        n += 1;
      }
      for (const { id, sample } of lat) {
        this.insLatencySample.run(
          id,
          sample.mint,
          sample.observedAtMs,
          sample.discoveryTimeMs,
          sample.signalTimeMs,
          sample.quoteTimeMs,
          sample.simulationTimeMs,
          sample.exitSignalTimeMs,
          sample.discoveryLatencyMs,
          sample.signalLatencyMs,
          sample.quoteLatencyMs,
          sample.processingLatencyMs,
          sample.detectedAtMs ?? null,
          sample.marketDataTimeMs ?? null,
          sample.marketDataLatencyMs ?? null,
          sample.shadowProcessingLatencyMs ?? null,
        );
        n += 1;
      }
      const nowMs = Date.now();
      for (const [name, by] of counters) {
        this.upsertCounter.run(name, by, nowMs);
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
}
