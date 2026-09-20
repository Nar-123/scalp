import type { RoundTripQuote } from '../../types/market.js';

export type { RoundTripQuote };

export function evaluateSellability(
  quote: RoundTripQuote | null,
  maxImpliedRoundTripLossPct: number,
): { passed: boolean; reason?: string; impliedRoundTripLossPct?: number } {
  if (!quote) return { passed: false, reason: 'quote_unavailable' };
  if (quote.sellPriceImpactPct === null) {
    return { passed: false, reason: 'no_sell_route_found' };
  }
  const impliedRoundTripLossPct = quote.buyPriceImpactPct + quote.sellPriceImpactPct;
  if (!Number.isFinite(impliedRoundTripLossPct)) {
    return { passed: false, reason: 'invalid_quote_data' };
  }
  if (impliedRoundTripLossPct > maxImpliedRoundTripLossPct) {
    return { passed: false, reason: 'excessive_round_trip_loss', impliedRoundTripLossPct };
  }
  return { passed: true, impliedRoundTripLossPct };
}
