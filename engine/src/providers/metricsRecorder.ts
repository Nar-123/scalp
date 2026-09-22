import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logging/logger.js';
import { redactSecrets } from './redact.js';
import type { ProviderMetrics } from './providerMetrics.js';

/** Periodically logs and persists provider metrics (bounded retention). Observer only: failures never affect trading. */
export class ProviderMetricsRecorder {
  private timer: ReturnType<typeof setInterval> | null = null;
  written = 0;

  constructor(
    private readonly metrics: ProviderMetrics,
    private readonly db: DatabaseSync | null,
    private readonly logger: Logger | undefined,
    private readonly intervalMs: number,
    private readonly retentionRows = 5000,
  ) {}

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => this.snapshot(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.snapshot();
  }

  snapshot(): void {
    const snap = this.metrics.snapshot();
    // counters only, but scrub anyway: defence in depth against a future field carrying text
    const json = redactSecrets(JSON.stringify(snap));
    this.logger?.info({ providerMetrics: JSON.parse(json) }, 'provider metrics');
    if (!this.db) return;
    try {
      this.db.prepare('INSERT INTO provider_metrics_snapshots (at_ms, snapshot_json) VALUES (?, ?)').run(snap.atMs, json);
      this.db.prepare('DELETE FROM provider_metrics_snapshots WHERE id <= (SELECT MAX(id) FROM provider_metrics_snapshots) - ?').run(this.retentionRows);
      this.written += 1;
    } catch {
      // observer only
    }
  }
}
