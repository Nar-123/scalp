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
  /** Latency-slippage buffer charged on EACH leg (the same value the simulator charges per leg). */
  slippagePct: number;
  /** BUY-direction price impact (%), fees excluded. */
  priceImpactPct: number;
  /**
   * SELL-direction price impact (%) of liquidating the tokens the buy would actually yield, fees excluded (Phase 5.6H: a
   * complete round trip needs both legs). null/non-finite => the exit cannot be priced => the edge is NOT favorable.
   */
  sellPriceImpactPct: number | null;
  /**
   * The venue's own fee per leg in bps (Pump.fun protocol + creator fee, from the token's TradeEvents). Absent/null =>
   * the configured generic `dexFeeBps + swapFeeBps` model, exactly as the simulator prices such a leg.
   */
  venueFeeBps?: number | null;
  safetyMarginBps: number;
  positionSizeSol: number;
}

export interface EdgeResult {
  netEdgePct: number;
  netEdgeSol: number;
  isFavorable: boolean;
  breakdown: Record<string, number>;
  /** Why no estimate could be made (e.g. the sell impact was unavailable); absent for a computed edge. */
  unavailableReason?: string;
  /** Total round-trip cost (both legs, every component, excluding the configured safety margin) in % of the position. */
  roundTripCostPct?: number;
  /** Fee model both legs were priced with. */
  feeModel?: 'pumpfun_curve' | 'configured_flat';
  feeBpsPerLeg?: number;
}

export interface SafetyCheckResult {
  passed: boolean;
  reasons: string[];
  details: Record<string, unknown>;
}
