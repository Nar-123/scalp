import { describe, expect, it } from 'vitest';
import { splitTrainValidationOos, assertNoTemporalLeakage, TemporalLeakageError } from '../../src/backtest/temporalSplit.js';

interface Item {
  entryTimeMs: number;
}

function itemsAt(times: number[]): Item[] {
  return times.map((entryTimeMs) => ({ entryTimeMs }));
}

describe('splitTrainValidationOos', () => {
  it('splits strictly chronologically with default 60/20/20 fractions', () => {
    const items = itemsAt(Array.from({ length: 10 }, (_, i) => i * 1000));
    const split = splitTrainValidationOos(items);
    expect(split.train).toHaveLength(6);
    expect(split.validation).toHaveLength(2);
    expect(split.outOfSample).toHaveLength(2);
    expect(split.trainingPeriod).toEqual({ startMs: 0, endMs: 5000 });
    expect(split.validationPeriod).toEqual({ startMs: 6000, endMs: 7000 });
    expect(split.oosPeriod).toEqual({ startMs: 8000, endMs: 9000 });
  });

  it('never lets a later item end up earlier in the split than an earlier item', () => {
    const items = itemsAt([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    const split = splitTrainValidationOos(items, 0.5, 0.3);
    expect(Math.max(...split.train.map((i) => i.entryTimeMs))).toBeLessThanOrEqual(
      Math.min(...split.validation.map((i) => i.entryTimeMs)),
    );
    expect(Math.max(...split.validation.map((i) => i.entryTimeMs))).toBeLessThanOrEqual(
      Math.min(...split.outOfSample.map((i) => i.entryTimeMs)),
    );
  });

  it('rejects fractions outside (0,1) or summing to >= 1', () => {
    const items = itemsAt([0, 1000]);
    expect(() => splitTrainValidationOos(items, 0.7, 0.4)).toThrow(RangeError);
    expect(() => splitTrainValidationOos(items, 0, 0.5)).toThrow(RangeError);
    expect(() => splitTrainValidationOos(items, 0.5, 1)).toThrow(RangeError);
  });

  it('assertNoTemporalLeakage throws if a hand-built split puts a later item in an earlier bucket', () => {
    const bogus = {
      train: itemsAt([5000]),
      validation: itemsAt([1000]), // earlier than the train item -- leakage
      outOfSample: itemsAt([9000]),
      trainingPeriod: { startMs: 5000, endMs: 5000 },
      validationPeriod: { startMs: 1000, endMs: 1000 },
      oosPeriod: { startMs: 9000, endMs: 9000 },
    };
    expect(() => assertNoTemporalLeakage(bogus)).toThrow(TemporalLeakageError);
  });

  it('handles empty validation/oos buckets without throwing', () => {
    const items = itemsAt([0, 1000]);
    const split = splitTrainValidationOos(items, 0.9, 0.05);
    expect(split.validation).toEqual([]);
    expect(() => assertNoTemporalLeakage(split)).not.toThrow();
  });
});
