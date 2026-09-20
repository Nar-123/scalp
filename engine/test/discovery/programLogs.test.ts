import { describe, expect, it } from 'vitest';
import { getOwnLogLines, ownLogsMatchAnyMarker } from '../../src/discovery/programLogs.js';

const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const AGGREGATOR = 'G7MVcM9YzGxrmLtmobUgyt8A6WhQ2dgQX3aSJcPejdEp';
const SYSTEM = '11111111111111111111111111111111';

// Trimmed but structurally faithful excerpt of a REAL mainnet transaction
// captured during live smoke-testing of this engine: an aggregator router
// CPIs into pump.fun for a "Buy", while the unrelated ATA program elsewhere
// in the same tx logs an instruction name that contains "Create" as a
// substring. A naive whole-transaction substring search for
// "Instruction: Create" incorrectly flagged this as a pump.fun token
// creation event; this fixture is a regression test for that exact bug.
const REAL_FALSE_POSITIVE_LOGS = [
  `Program ${SYSTEM} invoke [1]`,
  `Program ${SYSTEM} success`,
  `Program ${ATA_PROGRAM} invoke [1]`,
  'Program log: CreateIdempotent',
  'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]',
  'Program log: Instruction: GetAccountDataSize',
  'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success',
  `Program ${ATA_PROGRAM} success`,
  `Program ${AGGREGATOR} invoke [1]`,
  'Program log: Instruction: Swap',
  `Program ${PUMPFUN} invoke [2]`,
  'Program log: Instruction: Buy',
  `Program ${PUMPFUN} success`,
  `Program ${AGGREGATOR} success`,
  'Program 11111111111111111111111111111111 invoke [1]',
  'Program log: Instruction: CreateTokenAccountWithSeed',
  'Program 11111111111111111111111111111111 success',
];

const SYNTHETIC_TRUE_POSITIVE_LOGS = [
  `Program ${PUMPFUN} invoke [1]`,
  'Program log: Instruction: Create',
  `Program ${PUMPFUN} consumed 12345 of 200000 compute units`,
  `Program ${PUMPFUN} success`,
];

describe('getOwnLogLines', () => {
  it('attributes each "Program log:" line only to the innermost active program', () => {
    const pumpfunLines = getOwnLogLines(REAL_FALSE_POSITIVE_LOGS, PUMPFUN);
    expect(pumpfunLines).toEqual(['Instruction: Buy']);
  });

  it('does not attribute a nested CPI log line to the outer caller', () => {
    const ataLines = getOwnLogLines(REAL_FALSE_POSITIVE_LOGS, ATA_PROGRAM);
    expect(ataLines).toEqual(['CreateIdempotent']);
  });

  it('extracts the real creation instruction for a genuine top-level invoke', () => {
    expect(getOwnLogLines(SYNTHETIC_TRUE_POSITIVE_LOGS, PUMPFUN)).toEqual(['Instruction: Create']);
  });
});

describe('ownLogsMatchAnyMarker (regression: whole-tx substring search false positive)', () => {
  it('does NOT flag a Buy routed through an aggregator as a Create, even though an unrelated program logs a Create-prefixed instruction elsewhere', () => {
    expect(ownLogsMatchAnyMarker(REAL_FALSE_POSITIVE_LOGS, PUMPFUN, ['Instruction: Create'])).toBe(false);
  });

  it('correctly flags a genuine top-level Create instruction dispatched to the target program', () => {
    expect(ownLogsMatchAnyMarker(SYNTHETIC_TRUE_POSITIVE_LOGS, PUMPFUN, ['Instruction: Create'])).toBe(true);
  });

  it('does not match when the target program never appears in the logs at all', () => {
    expect(ownLogsMatchAnyMarker(REAL_FALSE_POSITIVE_LOGS, 'SomeOtherProgramId', ['Instruction: Create'])).toBe(false);
  });
});
