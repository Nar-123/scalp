/**
 * Solana program logs interleave every program invoked in a transaction,
 * including nested CPIs, in one flat array. A naive substring search for a
 * marker anywhere in that array produces false positives confirmed against
 * real mainnet transactions during this pass -- e.g. a DEX aggregator
 * router CPI-ing into our target program for an ordinary "Buy", while some
 * *unrelated* program elsewhere in the same transaction (the SPL
 * Associated Token Account program creating the buyer's ATA, say) logs an
 * instruction name that happens to contain our marker substring
 * ("Instruction: CreateTokenAccountWithSeed" contains "Instruction: Create").
 *
 * "Program log: ..." lines are only ever emitted by whichever program is
 * currently executing -- the innermost program on the invoke stack at that
 * point in the trace. This walks that stack so only log lines truly emitted
 * BY our target program itself are considered, never lines from something
 * it happens to call (a nested CPI) or something that happens to call it
 * (an aggregator wrapping it).
 */
const LOG_LINE_PREFIX = 'Program log: ';

export function getOwnLogLines(logs: string[], programId: string): string[] {
  const invokeRe = new RegExp(`^Program (\\S+) invoke \\[(\\d+)\\]$`);
  const endRe = new RegExp(`^Program (\\S+) (success|failed.*)$`);
  const stack: string[] = [];
  const ownLines: string[] = [];

  for (const line of logs) {
    const invokeMatch = invokeRe.exec(line);
    if (invokeMatch) {
      stack.push(invokeMatch[1] as string);
      continue;
    }
    const endMatch = endRe.exec(line);
    if (endMatch && stack.length > 0 && stack[stack.length - 1] === endMatch[1]) {
      stack.pop();
      continue;
    }
    if (line.startsWith(LOG_LINE_PREFIX) && stack[stack.length - 1] === programId) {
      ownLines.push(line.slice(LOG_LINE_PREFIX.length));
    }
  }

  return ownLines;
}

export function ownLogsMatchAnyMarker(logs: string[], programId: string, markers: string[]): boolean {
  const ownLines = getOwnLogLines(logs, programId);
  return ownLines.some((line) => markers.some((marker) => line.includes(marker)));
}

const PROGRAM_DATA_PREFIX = 'Program data: ';

export interface OwnProgramDataPayload {
  /** Position among ALL `Program data:` lines emitted by this program in the transaction (0-based). */
  index: number;
  /** Raw base64 payload of the log line (the Anchor event: 8-byte discriminator + borsh body). */
  base64: string;
}

/**
 * `Program data: <base64>` lines emitted BY `programId` itself (Anchor
 * `emit!` events written with sol_log_data). Same invoke-stack attribution as
 * `getOwnLogLines`: a wrapper/aggregator that logs its own `Program data:`
 * line, or a program this one CPIs into, is never attributed to `programId`
 * (verified live in Phase 5.4A -- wrappers do log their own data lines).
 */
export function getOwnProgramDataPayloads(logs: string[], programId: string): OwnProgramDataPayload[] {
  const invokeRe = /^Program (\S+) invoke \[(\d+)\]$/;
  const endRe = /^Program (\S+) (success|failed.*)$/;
  const stack: string[] = [];
  const payloads: OwnProgramDataPayload[] = [];
  let index = 0;

  for (const line of logs) {
    const invokeMatch = invokeRe.exec(line);
    if (invokeMatch) {
      stack.push(invokeMatch[1] as string);
      continue;
    }
    const endMatch = endRe.exec(line);
    if (endMatch && stack.length > 0 && stack[stack.length - 1] === endMatch[1]) {
      stack.pop();
      continue;
    }
    if (line.startsWith(PROGRAM_DATA_PREFIX) && stack[stack.length - 1] === programId) {
      payloads.push({ index: index++, base64: line.slice(PROGRAM_DATA_PREFIX.length) });
    }
  }
  return payloads;
}

/** The runtime writes this marker when a transaction's log output exceeded its size limit; later lines are missing. */
export function logsWereTruncated(logs: string[]): boolean {
  return logs.some((line) => line === 'Log truncated' || line.startsWith('Log truncated'));
}
