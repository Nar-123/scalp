import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../src/config/defaults.js';
import { HARD_RISK_PARAMETERS } from '../../src/config/hardRisk.js';
import { collectBaselineFilterFailures } from '../../src/orchestrator/baselineFilters.js';

/**
 * P1 fix #6: HARD_RISK_PARAMETERS.maxPriceImpactBps (100 bps = 1%) must be a real, structural ceiling on buy price
 * impact -- entry filtering previously depended ENTIRELY on the configurable `cfg.filters.maxPriceImpactPct`
 * (schema only requires it to be non-negative), which happened to default to the same 1% but was never actually
 * bound BY the hard limit. See orchestrator/baselineFilters.ts.
 */

const HARD_MAX_PCT = HARD_RISK_PARAMETERS.maxPriceImpactBps / 100; // 1%

function liquidityOk() {
  return { liquiditySol: 100, volume1mSol: 100, buySellRatio: 5 };
}

function passingNonImpactInputs(cfg = getDefaultConfig()) {
  // priceVelocity/volumeAcceleration set comfortably above their minimums so ONLY price-impact failures show up.
  return { liquidityVolume: liquidityOk(), priceVelocity5sPct: cfg.filters.minPriceVelocity5sPct + 10, volumeAccelerationX: cfg.filters.minVolumeAccelerationX + 10 };
}

describe('collectBaselineFilterFailures: hard price-impact ceiling', () => {
  it('filter = 1%, hard limit = 1% (defaults): an impact at the shared boundary is NOT a failure (exact-boundary behavior)', () => {
    const cfg = getDefaultConfig(); // filters.maxPriceImpactPct defaults to 1, matching the hard limit
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, HARD_MAX_PCT, cfg);
    expect(failures).toEqual([]);
  });

  it('an impact even slightly above the shared 1% boundary fails BOTH the hard and the configured check', () => {
    const cfg = getDefaultConfig();
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, HARD_MAX_PCT + 0.0001, cfg);
    expect(failures).toContain('hard_max_price_impact_exceeded');
    expect(failures).toContain('price_impact_above_maximum');
  });

  it('a STRICTER configured filter than the hard limit: the stricter (configured) filter wins for an impact between the two', () => {
    const cfg = getDefaultConfig({ filters: { maxPriceImpactPct: 0.5 } }); // stricter than the 1% hard limit
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, 0.8, cfg); // under hard limit, over the configured one
    expect(failures).toEqual(['price_impact_above_maximum']);
    expect(failures).not.toContain('hard_max_price_impact_exceeded');
  });

  it('a LOOSER configured filter than the hard limit: the hard limit wins for an impact between the two -- no entry can bypass it', () => {
    const cfg = getDefaultConfig({ filters: { maxPriceImpactPct: 5 } }); // looser than the 1% hard limit -- exactly the bug scenario
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, 2, cfg); // under the configured 5%, over the hard 1%
    expect(failures).toContain('hard_max_price_impact_exceeded');
  });

  it('an impact under BOTH limits passes cleanly, whichever is looser', () => {
    const cfg = getDefaultConfig({ filters: { maxPriceImpactPct: 5 } });
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, 0.5, cfg);
    expect(failures).toEqual([]);
  });

  it('exact boundary at the HARD limit itself, with a looser configured filter, is not a failure', () => {
    const cfg = getDefaultConfig({ filters: { maxPriceImpactPct: 10 } });
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, HARD_MAX_PCT, cfg);
    expect(failures).toEqual([]);
  });

  it('a configured filter cannot bypass the hard limit even when set absurdly high', () => {
    const cfg = getDefaultConfig({ filters: { maxPriceImpactPct: 100 } });
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, 50, cfg); // absurd impact, under the misconfigured 100% filter
    expect(failures).toContain('hard_max_price_impact_exceeded');
  });

  it('NaN price impact is treated as unavailable, not as "no impact at all" (never silently passes a broken numeric comparison)', () => {
    const cfg = getDefaultConfig();
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, Number.NaN, cfg);
    expect(failures).toEqual(['price_impact_unavailable']);
  });

  it('Infinity price impact is treated as unavailable and fails closed', () => {
    const cfg = getDefaultConfig();
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, Number.POSITIVE_INFINITY, cfg);
    expect(failures).toEqual(['price_impact_unavailable']);
  });

  it('a negative price impact is treated as unavailable, not as a physically meaningful "negative cost"', () => {
    const cfg = getDefaultConfig();
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, -0.5, cfg);
    expect(failures).toEqual(['price_impact_unavailable']);
  });

  it('null price impact is unavailable, exactly as before this fix', () => {
    const cfg = getDefaultConfig();
    const { liquidityVolume, priceVelocity5sPct, volumeAccelerationX } = passingNonImpactInputs(cfg);
    const failures = collectBaselineFilterFailures(liquidityVolume, priceVelocity5sPct, volumeAccelerationX, null, cfg);
    expect(failures).toEqual(['price_impact_unavailable']);
  });

  it('HARD_RISK_PARAMETERS itself is never modified by any of this', () => {
    const frozenBefore = JSON.stringify(HARD_RISK_PARAMETERS);
    getDefaultConfig({ filters: { maxPriceImpactPct: 999 } });
    expect(JSON.stringify(HARD_RISK_PARAMETERS)).toBe(frozenBefore);
    expect(HARD_RISK_PARAMETERS.maxPriceImpactBps).toBe(100);
    expect(Object.isFrozen(HARD_RISK_PARAMETERS)).toBe(true);
  });
});
