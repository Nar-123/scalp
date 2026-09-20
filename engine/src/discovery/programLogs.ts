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
