export interface EntrySignalInputs {
  momentumPct5s: number;
  volumeAccelerationX: number;
  buySellRatio: number;
  txVelocityPerSec: number;
  liquiditySol: number;
  estimatedSlippagePct: number;
  estimatedPriceImpactPct: number;
}

export interface EntryScoreResult {
  score: number;
  components: Record<string, number>;
  passesThreshold: boolean;
  minScore: number;
}

export interface EdgeInputs {
  expectedGrossMovePct: number;
  dexFeeBps: number;
  swapFeeBps: number;
  networkFeeSol: number;
  priorityFeeSol: number;
  slippagePct: number;
  priceImpactPct: number;
  safetyMarginBps: number;
  positionSizeSol: number;
}

export interface EdgeResult {
  netEdgePct: number;
  netEdgeSol: number;
  isFavorable: boolean;
  breakdown: Record<string, number>;
}

export interface SafetyCheckResult {
  passed: boolean;
  reasons: string[];
  details: Record<string, unknown>;
}
