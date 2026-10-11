import { describe, expect, it } from 'vitest';
import { collectBaselineFilterFailures } from '../../src/orchestrator/baselineFilters.js';
import { QUOTE_NOT_REQUESTED_REASON, shouldSkipBuyQuote, type BuyQuoteSkipInputs } from '../../src/orchestrator/quoteOrdering.js';
import { getDefaultConfig } from '../../src/config/defaults.js';

/**
 * Stage 2: `shouldSkipBuyQuote` is pure. It may answer true ONLY when the quote cannot change the baseline verdict and no
 * position needs it; every doubt keeps the quote.
 */

const all = (): BuyQuoteSkipInputs[] => {
  const out: BuyQuoteSkipInputs[] = [];
  for (const enabled of [false, true]) for (const useNative of [false, true]) for (const volume1mSol of [null, 0, 0.0001, 5, 250]) for (const holdsPosition of [false, true]) out.push({ enabled, useNative, volume1mSol, holdsPosition });
  return out;
};

describe('shouldSkipBuyQuote (pure)', () => {
  it('skips in exactly one situation: enabled, non-native route, volume null, no position', () => {
    const skipping = all().filter(shouldSkipBuyQuote);
    expect(skipping).toEqual([{ enabled: true, useNative: false, volume1mSol: null, holdsPosition: false }]);
  });

  it.each(all())('table: %o', (input) => {
    const expected = input.enabled && !input.useNative && input.volume1mSol === null && !input.holdsPosition;
    expect(shouldSkipBuyQuote(input)).toBe(expected);
  });

  it('is disabled by default semantics: with enabled=false it never skips, whatever else is true', () => {
    for (const i of all().filter((x) => !x.enabled)) expect(shouldSkipBuyQuote(i)).toBe(false);
  });

  it('any open position (real or shadow, expressed as holdsPosition) keeps the quote', () => {
    for (const i of all().filter((x) => x.holdsPosition)) expect(shouldSkipBuyQuote(i)).toBe(false);
  });

  it('a volume that is not literally null keeps the quote (undefined / NaN / numbers are all "known or doubtful")', () => {
    for (const v of [undefined, Number.NaN, 0, 1, -1, Number.POSITIVE_INFINITY] as unknown as Array<number | null>) {
      expect(shouldSkipBuyQuote({ enabled: true, useNative: false, volume1mSol: v, holdsPosition: false })).toBe(false);
    }
  });

  it('the marker has the agreed, explicit name', () => {
    expect(QUOTE_NOT_REQUESTED_REASON).toBe('quote_not_requested_volume_unavailable');
  });
});

describe('decision invariance: whenever the quote is skipped, the baseline filters reject for EVERY possible impact value', () => {
  const cfg = getDefaultConfig({});
  // every liquidity / ratio / velocity / acceleration combination a graduated token can present, with volume null
  const liquidity = [0, 0.3, 19.99, 20, 120, 5000];
  const ratio = [null, 0, 1.49, 1.5, 3, Number.POSITIVE_INFINITY];
  const velocity = [-5, 0, 0.99, 1, 4];
  const accel = [null, 0, 1.49, 1.5, 10, Number.POSITIVE_INFINITY];
  const impacts: Array<number | null> = [null, 0, 0.0001, 0.4, 1, 1.0001, 5, 99, -1, Number.NaN, Number.POSITIVE_INFINITY];

  it('volume_1m_unavailable is present (and so the verdict is "reject") regardless of the price impact', () => {
    let checked = 0;
    for (const l of liquidity) for (const r of ratio) for (const v of velocity) for (const a of accel) {
      const verdicts = impacts.map((impact) => collectBaselineFilterFailures({ liquiditySol: l, volume1mSol: null, buySellRatio: r }, v, a, impact, cfg));
      for (const f of verdicts) {
        expect(f).toContain('volume_1m_unavailable');
        expect(f.length).toBeGreaterThan(0);
      }
      // and the only thing the impact can change is WHICH price-impact reasons are listed -- never the non-impact reasons
      const nonImpact = (f: string[]): string[] => f.filter((x) => !x.startsWith('price_impact_') && x !== 'hard_max_price_impact_exceeded').sort();
      const first = nonImpact(verdicts[0]!);
      for (const f of verdicts) expect(nonImpact(f)).toEqual(first);
      checked += 1;
    }
    expect(checked).toBe(liquidity.length * ratio.length * velocity.length * accel.length);
  });
});
