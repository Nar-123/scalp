import type { LatencySampleRecord, ShadowMarketTick } from './types.js';

/**
 * Computes OBSERVED SYSTEM LATENCY -- real wall-clock deltas between
 * pipeline stages, measured within this process for THIS tick.
 *
 * This is categorically different from
 * SimulationAssumptions.latencySlippageBufferPct, an ASSUMED cost applied to
 * a simulated fill because shadow/backtest never performs a real on-chain
 * execution whose confirmation latency could be measured. Nothing here
 * feeds that buffer, and nothing here measures blockchain execution.
 */
export function computeLatencySample(tick: ShadowMarketTick, shadowProcessingLatencyMs: number | null = null): LatencySampleRecord {
  const t = tick.timings;
  const dataDone = t.marketDataTimeMs ?? null;
  const quoteStart = dataDone ?? t.signalTimeMs;
  const handoff = t.simulationTimeMs;
  const afterAcquisition = t.quoteTimeMs ?? dataDone ?? t.signalTimeMs;

  return {
    mint: tick.mint,
    observedAtMs: tick.observedAtMs,
    discoveryTimeMs: t.discoveryTimeMs,
    detectedAtMs: t.detectedAtMs ?? null,
    marketDataTimeMs: dataDone,
    signalTimeMs: t.signalTimeMs,
    quoteTimeMs: t.quoteTimeMs,
    simulationTimeMs: handoff,
    exitSignalTimeMs: t.exitSignalTimeMs,
    discoveryLatencyMs: t.detectedAtMs != null ? t.detectedAtMs - t.discoveryTimeMs : null,
    marketDataLatencyMs: dataDone !== null ? dataDone - t.signalTimeMs : null,
    quoteLatencyMs: t.quoteTimeMs !== null ? t.quoteTimeMs - quoteStart : null,
    signalLatencyMs: handoff - afterAcquisition,
    processingLatencyMs: handoff - t.signalTimeMs,
    shadowProcessingLatencyMs,
  };
}
