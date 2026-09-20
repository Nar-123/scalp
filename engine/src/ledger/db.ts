import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { MIGRATION_001_INIT } from './migrations/001_init.js';

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
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
  return db;
}

export type { DatabaseSyncType as DatabaseSync };
