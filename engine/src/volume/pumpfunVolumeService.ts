import type { Connection } from '@solana/web3.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logging/logger.js';
import { PumpfunVolumeEngine, type EngineSizes, type EngineStats, type PumpfunVolumeEngineOptions } from './pumpfunVolumeEngine.js';
import { TradeEventRecorder } from './tradeEventRecorder.js';
import type { NativeMarketProvider, NativeMarketSnapshot, NativeSellImpact, OneMinuteVolume, OneMinuteVolumeProvider } from './types.js';

export interface PumpfunLogNotification {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
  receivedAtMs: number;
}

export interface PumpfunVolumeServiceOptions {
  engine?: PumpfunVolumeEngineOptions;
  /** When a database is given, accepted events + coverage changes are recorded (bounded retention). */
  db?: DatabaseSync;
  recordRetentionHours?: number;
  logger?: Pick<Logger, 'info' | 'warn' | 'debug'>;
  /** Interval of the liveness watchdog and of the periodic stats line. */
  watchdogIntervalMs?: number;
  statsLogIntervalMs?: number;
}

interface WsLike {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/**
 * Glue between the ONE shared Pump.fun `onLogs` subscription (owned by
 * PumpFunLogSubscriber, which forwards every notification here) and the
 * volume engine. It adds the operational pieces the pure engine deliberately
 * lacks: websocket state hooks, the silence watchdog, event recording and
 * periodic metrics. It performs no RPC request of its own and holds no
 * wallet/signer.
 */
export class PumpfunVolumeService implements OneMinuteVolumeProvider, NativeMarketProvider {
  readonly engine: PumpfunVolumeEngine;
  readonly recorder: TradeEventRecorder | null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private wsHooksAttached = false;
  private lastStatsAtMs = 0;
  private lastStatsNotifications = 0;
  private lastStatsTrades = 0;

  constructor(private readonly options: PumpfunVolumeServiceOptions = {}) {
    this.recorder = options.db ? new TradeEventRecorder(options.db, { retentionHours: options.recordRetentionHours }) : null;
    const rec = this.recorder;
    this.engine = new PumpfunVolumeEngine({
      ...options.engine,
      onTradeAccepted: (e) => rec?.recordTrade(e),
      onLifecycle: (l) => rec?.recordLifecycle(l),
      onCoverageChange: (c) => rec?.recordCoverage(c),
    });
  }

  /** Marks the stream started (coverage stays UNKNOWN until events prove it) and starts the watchdog/recorder. */
  start(nowMs: number = Date.now()): void {
    this.engine.markStreamStarted(nowMs);
    this.recorder?.start();
    const interval = this.options.watchdogIntervalMs ?? 1000;
    this.watchdog = setInterval(() => this.engine.checkLiveness(Date.now()), interval);
    this.watchdog.unref?.();
    const statsEvery = this.options.statsLogIntervalMs ?? 60_000;
    if (statsEvery > 0 && this.options.logger) {
      this.lastStatsAtMs = nowMs;
      this.statsTimer = setInterval(() => this.logStats(Date.now()), statsEvery);
      this.statsTimer.unref?.();
    }
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.watchdog = null;
    this.statsTimer = null;
    this.recorder?.stop();
  }

  /** Called by the Pump.fun log subscriber for EVERY notification on the shared subscription. */
  onLogNotification(n: PumpfunLogNotification): void {
    this.engine.onNotification(n);
  }

  /**
   * Observes the underlying web3.js websocket. web3.js re-subscribes on its own
   * after a drop but never replays missed notifications and never tells the
   * caller, so the drop itself must be observed here. This reaches into a
   * private field of web3.js; if it is absent the silence watchdog remains
   * the only detector and `wsHooksAttached` stays false (reported in stats).
   */
  attachConnectionHooks(connection: Connection): boolean {
    const ws = (connection as unknown as { _rpcWebSocket?: WsLike })._rpcWebSocket;
    if (!ws || typeof ws.on !== 'function') {
      this.options.logger?.warn({}, 'volume: websocket state hooks unavailable; relying on the silence watchdog only');
      return false;
    }
    ws.on('close', () => this.engine.markDisconnected('stream_disconnected', Date.now()));
    ws.on('open', () => this.engine.markReconnected(Date.now()));
    ws.on('error', () => this.engine.recordStreamError(Date.now()));
    this.wsHooksAttached = true;
    return true;
  }

  getOneMinuteVolume(mint: string, nowMs: number = Date.now()): OneMinuteVolume {
    return this.engine.getOneMinuteVolume(mint, nowMs);
  }

  getNativeMarketSnapshot(mint: string, entrySizeSol: number, nowMs: number = Date.now()): NativeMarketSnapshot {
    return this.engine.getNativeMarketSnapshot(mint, entrySizeSol, nowMs);
  }

  getNativeSellImpact(mint: string, tokenAmountRaw: bigint, nowMs: number = Date.now()): NativeSellImpact {
    return this.engine.getNativeSellImpact(mint, tokenAmountRaw, nowMs);
  }

  snapshot(nowMs: number = Date.now()): {
    stats: EngineStats;
    sizes: EngineSizes;
    health: ReturnType<PumpfunVolumeEngine['health']>;
    wsHooksAttached: boolean;
    decode: ReturnType<PumpfunVolumeEngine['decodeLatency']['summary']>;
    aggregation: ReturnType<PumpfunVolumeEngine['aggregationLatency']['summary']>;
    recorder: { written: number; droppedFromBuffer: number; writeFailures: number } | null;
    heapUsedMb: number;
  } {
    return {
      stats: { ...this.engine.stats },
      sizes: this.engine.sizes(),
      health: this.engine.health(nowMs),
      wsHooksAttached: this.wsHooksAttached,
      decode: this.engine.decodeLatency.summary(),
      aggregation: this.engine.aggregationLatency.summary(),
      recorder: this.recorder ? { written: this.recorder.written, droppedFromBuffer: this.recorder.droppedFromBuffer, writeFailures: this.recorder.writeFailures } : null,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    };
  }

  private logStats(nowMs: number): void {
    const snap = this.snapshot(nowMs);
    const secs = Math.max(1, (nowMs - this.lastStatsAtMs) / 1000);
    const perSec = {
      notifications: +((snap.stats.notifications - this.lastStatsNotifications) / secs).toFixed(1),
      tradeEvents: +((snap.stats.tradesAccepted - this.lastStatsTrades) / secs).toFixed(1),
    };
    this.lastStatsAtMs = nowMs;
    this.lastStatsNotifications = snap.stats.notifications;
    this.lastStatsTrades = snap.stats.tradesAccepted;
    this.options.logger?.info(
      {
        perSec,
        coverageHealthy: snap.health.coverageSinceSec !== null,
        breakReason: snap.health.breakReason,
        epoch: snap.health.epoch,
        stats: snap.stats,
        sizes: snap.sizes,
        decode: snap.decode,
        aggregation: snap.aggregation,
        recorder: snap.recorder,
        wsHooksAttached: snap.wsHooksAttached,
        heapUsedMb: snap.heapUsedMb,
      },
      'pumpfun native volume stream',
    );
  }
}
