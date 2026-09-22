import { describe, expect, it } from 'vitest';
import { computeLatencySample } from '../../src/shadow/latencyTracker.js';
import { entryEligibleTick } from './fixtures.js';

describe('computeLatencySample (all values are OBSERVED system latency)', () => {
  it('measures discovery latency only from a real detection timestamp, never from token age', () => {
    const withDetection = computeLatencySample(
      entryEligibleTick({ timings: { discoveryTimeMs: 1000, detectedAtMs: 1800, signalTimeMs: 61_000, quoteTimeMs: null, simulationTimeMs: 61_100, exitSignalTimeMs: null } }),
    );
    expect(withDetection.discoveryLatencyMs).toBe(800); // creation -> first seen, NOT the 60s token age
    const withoutDetection = computeLatencySample(
      entryEligibleTick({ timings: { discoveryTimeMs: 1000, signalTimeMs: 61_000, quoteTimeMs: null, simulationTimeMs: 61_100, exitSignalTimeMs: null } }),
    );
    expect(withoutDetection.discoveryLatencyMs).toBeNull();
  });

  it('derives market-data, quote, signal and processing latency from stage timestamps', () => {
    const s = computeLatencySample(
      entryEligibleTick({
        timings: { discoveryTimeMs: 0, detectedAtMs: 100, signalTimeMs: 10_000, marketDataTimeMs: 10_300, quoteTimeMs: 10_700, simulationTimeMs: 11_200, exitSignalTimeMs: null },
      }),
      1.5,
    );
    expect(s.marketDataLatencyMs).toBe(300);
    expect(s.quoteLatencyMs).toBe(400); // after market data
    expect(s.signalLatencyMs).toBe(500); // after data acquisition -> handoff (includes safety gate wait)
    expect(s.processingLatencyMs).toBe(1200); // tick start -> handoff
    expect(s.shadowProcessingLatencyMs).toBe(1.5);
  });

  it('leaves optional stages null instead of inventing them', () => {
    const s = computeLatencySample(
      entryEligibleTick({ timings: { discoveryTimeMs: 0, signalTimeMs: 100, quoteTimeMs: null, simulationTimeMs: 200, exitSignalTimeMs: null } }),
    );
    expect(s.marketDataLatencyMs).toBeNull();
    expect(s.quoteLatencyMs).toBeNull();
    expect(s.shadowProcessingLatencyMs).toBeNull();
  });

  it('is a pure function of the tick timings (never derived from the assumed fill-latency buffer)', () => {
    const t = { discoveryTimeMs: 0, signalTimeMs: 100, quoteTimeMs: null, simulationTimeMs: 200, exitSignalTimeMs: null };
    expect(computeLatencySample(entryEligibleTick({ timings: t }))).toEqual(computeLatencySample(entryEligibleTick({ timings: t })));
  });
});
