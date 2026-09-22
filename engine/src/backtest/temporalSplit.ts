import type { BacktestTrade } from './types.js';

/**
 * Strictly chronological train/validation/out-of-sample split, mirroring
 * python/learning/validation.py's split_train_validation_oos /
 * assert_no_temporal_leakage (same algorithm, reimplemented here because
 * the sequence being split lives on this side of the language boundary --
 * see docs/PHASE_3_ALT_BACKTEST_LEARNING.md for why this one utility is
 * duplicated rather than shared, unlike the risk/exit/fee logic which is
 * genuinely reused).
 */
export class TemporalLeakageError extends Error {}

export interface PeriodBounds {
  startMs: number;
  endMs: number;
}

export interface TemporalSplit<T extends { entryTimeMs: number }> {
  train: T[];
  validation: T[];
  outOfSample: T[];
  trainingPeriod: PeriodBounds | null;
  validationPeriod: PeriodBounds | null;
  oosPeriod: PeriodBounds | null;
}

function periodOf(items: Array<{ entryTimeMs: number }>): PeriodBounds | null {
  if (items.length === 0) return null;
  const times = items.map((i) => i.entryTimeMs);
  return { startMs: Math.min(...times), endMs: Math.max(...times) };
}

export function splitTrainValidationOos<T extends { entryTimeMs: number }>(
  itemsInChronologicalOrder: T[],
  trainFrac = 0.6,
  validationFrac = 0.2,
): TemporalSplit<T> {
  if (!(trainFrac > 0 && trainFrac < 1) || !(validationFrac > 0 && validationFrac < 1) || trainFrac + validationFrac >= 1) {
    throw new RangeError('trainFrac and validationFrac must each be in (0, 1) and sum to less than 1');
  }

  const n = itemsInChronologicalOrder.length;
  const trainEnd = Math.floor(n * trainFrac);
  const validationEnd = trainEnd + Math.floor(n * validationFrac);

  const split: TemporalSplit<T> = {
    train: itemsInChronologicalOrder.slice(0, trainEnd),
    validation: itemsInChronologicalOrder.slice(trainEnd, validationEnd),
    outOfSample: itemsInChronologicalOrder.slice(validationEnd),
    trainingPeriod: null,
    validationPeriod: null,
    oosPeriod: null,
  };
  split.trainingPeriod = periodOf(split.train);
  split.validationPeriod = periodOf(split.validation);
  split.oosPeriod = periodOf(split.outOfSample);

  assertNoTemporalLeakage(split);
  return split;
}

export function assertNoTemporalLeakage<T extends { entryTimeMs: number }>(split: TemporalSplit<T>): void {
  const trainMax = split.trainingPeriod?.endMs ?? null;
  const validationMin = split.validation.length ? Math.min(...split.validation.map((t) => t.entryTimeMs)) : null;
  const validationMax = split.validationPeriod?.endMs ?? null;
  const oosMin = split.outOfSample.length ? Math.min(...split.outOfSample.map((t) => t.entryTimeMs)) : null;

  if (trainMax !== null && validationMin !== null && trainMax > validationMin) {
    throw new TemporalLeakageError('Validation set contains an item that occurred before the latest training item.');
  }
  if (validationMax !== null && oosMin !== null && validationMax > oosMin) {
    throw new TemporalLeakageError('Out-of-sample set contains an item that occurred before the latest validation item.');
  }
  if (trainMax !== null && oosMin !== null && trainMax > oosMin) {
    throw new TemporalLeakageError('Out-of-sample set contains an item that occurred before the latest training item.');
  }
}

/** Convenience overload for BacktestTrade[] specifically, used by compareStrategies.ts. */
export function splitTrades(trades: BacktestTrade[], trainFrac = 0.6, validationFrac = 0.2): TemporalSplit<BacktestTrade> {
  return splitTrainValidationOos(trades, trainFrac, validationFrac);
}
