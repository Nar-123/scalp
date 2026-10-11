/**
 * Order of checks around the read-only BUY quote of an evaluation (Stage 2).
 *
 * The buy quote exists to obtain the entry-sized price impact, which only feeds the price-impact baseline filters (and,
 * when a position is held, the sell impact its exit is priced with). On the non-native (DexScreener) route the 1-minute
 * volume is known BEFORE the quote is requested, and when it is null the baseline filter `volume_1m_unavailable` fails
 * unconditionally (see `collectBaselineFilterFailures`: it does not look at the price impact), so the evaluation is
 * rejected whatever the quote returns. Requesting it only spends the provider budget (a rate-limited 0.5 req/s on the
 * keyless Jupiter host) that the safety gate's round trip for tokens that CAN still pass needs.
 *
 * Pure and deterministic. It changes ONLY whether the quote is requested -- never a filter, a threshold or a verdict:
 *   - disabled (the default)                  -> never skip (exactly the previous behaviour);
 *   - native route                            -> never skip (it makes no Jupiter request at all);
 *   - volume known (anything but `null`)      -> never skip (the impact can change the verdict);
 *   - a real OR shadow position is open       -> never skip (its exit is priced with the sell impact derived from the quote).
 * `volume1mSol` is compared strictly with `null`: an `undefined`/NaN/number all keep the quote, so any doubt requests it.
 */
export interface BuyQuoteSkipInputs {
  /** `providers.skipQuoteWhenVolumeUnavailable` (SKIP_QUOTE_WHEN_VOLUME_UNAVAILABLE), default false. */
  enabled: boolean;
  /** The evaluation is served by the native Pump.fun snapshot (no Jupiter quote exists on that route). */
  useNative: boolean;
  /** The 1-minute volume this evaluation will be judged on, already resolved. */
  volume1mSol: number | null;
  /** A real position or a shadow position is open for this mint. */
  holdsPosition: boolean;
}

/** Recorded in the evaluation's reasons when the quote was deliberately not requested, so the saving is countable. */
export const QUOTE_NOT_REQUESTED_REASON = 'quote_not_requested_volume_unavailable';

export function shouldSkipBuyQuote(input: BuyQuoteSkipInputs): boolean {
  return input.enabled === true && input.useNative === false && input.volume1mSol === null && input.holdsPosition === false;
}
