#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { openLedger } from '../ledger/db.js';
import { utcDateString } from '../utils/time.js';
import { HealthCounters, buildShadowStatusReport } from './shadowStatus.js';
import { ShadowLedger } from './shadowLedger.js';

/**
 * Read-only shadow monitoring status (task 23). Prints one JSON object --
 * safe to wrap later with a read-only Telegram `/status`-style command
 * (task 24: no such command is built in this phase, but this CLI's plain
 * JSON output is exactly the shape such a read-only adapter would forward
 * verbatim, never accepting a command that could act back on it).
 *
 * Usage: node dist/shadow/cli.js --db <ledger.sqlite> --strategy-version V1 [--strategy-version V2 ...]
 */

export interface CliArgs {
  dbPath: string;
  strategyVersions: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: { dbPath?: string; strategyVersions: string[] } = { strategyVersions: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--db') {
      args.dbPath = value;
      i += 1;
    } else if (flag === '--strategy-version') {
      args.strategyVersions.push(value!);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.dbPath) throw new Error('--db is required');
  if (args.strategyVersions.length === 0) throw new Error('at least one --strategy-version is required');
  return { dbPath: args.dbPath, strategyVersions: args.strategyVersions };
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = openLedger(args.dbPath);
  const ledger = new ShadowLedger(db);
  const report = buildShadowStatusReport(ledger, args.strategyVersions, utcDateString, Date.now(), new HealthCounters(undefined, ledger.getCounters()));
  process.stdout.write(JSON.stringify(report, null, 2));
}

const isDirectlyExecuted = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectlyExecuted) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`shadow-cli-error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
