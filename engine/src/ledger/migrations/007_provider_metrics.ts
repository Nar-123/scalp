// Phase 5.6A: periodic provider metrics snapshots (counters and latency summaries only: no URLs, keys or headers).
export const MIGRATION_007_PROVIDER_METRICS = `
CREATE TABLE IF NOT EXISTS provider_metrics_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_metrics_at ON provider_metrics_snapshots (at_ms);
`;
