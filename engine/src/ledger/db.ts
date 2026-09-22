import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { MIGRATION_001_INIT } from './migrations/001_init.js';
import { MIGRATION_002_BACKTEST_FIELDS, MIGRATION_002_BACKTEST_FIELDS_TABLE } from './migrations/002_backtest_fields.js';
import { MIGRATION_003_ADDITIVE_COLUMNS, MIGRATION_003_SHADOW_TABLES } from './migrations/003_shadow_tables.js';
import { MIGRATION_004_PUMPFUN_EVENTS } from './migrations/004_pumpfun_trade_events.js';
import { MIGRATION_007_PROVIDER_METRICS } from './migrations/007_provider_metrics.js';
import { MIGRATION_008_PRICE_PATHS } from './migrations/008_price_paths.js';
import { MIGRATION_009_RELIABILITY_COLUMNS, MIGRATION_009_RELIABILITY_TABLE } from './migrations/009_reliability_columns.js';
import {
  MIGRATION_006_EVALUATIONS,
  MIGRATION_006_EVALUATIONS_TABLE,
  MIGRATION_006_SHADOW_TABLE,
  MIGRATION_006_SHADOW_TRADES,
  MIGRATION_006_TRADES,
  MIGRATION_006_TRADES_TABLE,
} from './migrations/006_pipeline_validation.js';
import {
  MIGRATION_005_EVALUATION_MARKET,
  MIGRATION_005_EVALUATION_MARKET_TABLE,
  MIGRATION_005_TRADE_EVENT_CURVE,
  MIGRATION_005_TRADE_EVENT_CURVE_TABLE,
} from './migrations/005_native_market_data.js';

// Loaded via createRequire rather than a static `import ... from 'node:sqlite'`
// so Vite/vitest's SSR module resolution (used to run the test suite) never
// has to resolve the specifier itself -- some Vite versions mis-resolve
// newer, less-common `node:` builtins. Runtime behavior is unaffected;
// node:sqlite is a synchronous, non-ESM-only API either way.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/**
 * Uses Node's built-in node:sqlite (stable in Node >=22.5) rather than
 * better-sqlite3, specifically to avoid requiring a native C++ build
 * toolchain (Visual Studio Build Tools on Windows) just to install
 * dependencies. It produces an ordinary SQLite file, still readable by the
 * Python analytics side via the stdlib sqlite3 module.
 */
export function openLedger(dbPath: string): DatabaseSyncType {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIGRATION_001_INIT);
  applyAdditiveColumns(db, MIGRATION_002_BACKTEST_FIELDS_TABLE, MIGRATION_002_BACKTEST_FIELDS);
  db.exec(MIGRATION_003_SHADOW_TABLES);
  for (const { table, column, ddl } of MIGRATION_003_ADDITIVE_COLUMNS) {
    applyAdditiveColumns(db, table, [{ column, ddl }]);
  }
  db.exec(MIGRATION_004_PUMPFUN_EVENTS);
  applyAdditiveColumns(db, MIGRATION_005_TRADE_EVENT_CURVE_TABLE, MIGRATION_005_TRADE_EVENT_CURVE);
  applyAdditiveColumns(db, MIGRATION_005_EVALUATION_MARKET_TABLE, MIGRATION_005_EVALUATION_MARKET);
  applyAdditiveColumns(db, MIGRATION_006_TRADES_TABLE, MIGRATION_006_TRADES);
  applyAdditiveColumns(db, MIGRATION_006_SHADOW_TABLE, MIGRATION_006_SHADOW_TRADES);
  applyAdditiveColumns(db, MIGRATION_006_EVALUATIONS_TABLE, MIGRATION_006_EVALUATIONS);
  db.exec(MIGRATION_007_PROVIDER_METRICS);
  db.exec(MIGRATION_008_PRICE_PATHS);
  applyAdditiveColumns(db, MIGRATION_009_RELIABILITY_TABLE, MIGRATION_009_RELIABILITY_COLUMNS);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
  return db;
}

/**
 * SQLite has no `ADD COLUMN IF NOT EXISTS`; this makes an additive-column
 * migration idempotent by checking `PRAGMA table_info` first, so
 * `openLedger` can be called repeatedly (as every test and every engine
 * startup does) without ever throwing "duplicate column name".
 */
function applyAdditiveColumns(
  db: DatabaseSyncType,
  table: string,
  columns: ReadonlyArray<{ column: string; ddl: string }>,
): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const { column, ddl } of columns) {
    if (!existing.has(column)) {
      db.exec(ddl);
    }
  }
}

export type { DatabaseSyncType as DatabaseSync };
