import { PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HolderBalance } from '../../src/types/token.js';

// getMint stands in for the classic-SPL mint read, exactly as in safetyGate.test.ts / token2022.test.ts.
const getMintMock = vi.fn();
vi.mock('@solana/spl-token', () => ({ getMint: (...args: unknown[]) => getMintMock(...args) }));

const { runSafetyGate } = await import('../../src/safety/safetyGate.js');
const { CachedSafetyDataSource, DirectSafetyDataSource } = await import('../../src/safety/dataSource.js');
const { PUMPFUN_MIGRATION_RESERVE_RAW, deriveCurveAndVault, verifyBondingCurveVault } = await import('../../src/safety/bondingCurveVault.js');
const { evaluateHolderPolicy } = await import('../../src/safety/checks/holderPolicy.js');
const { evaluateHolderConcentration } = await import('../../src/safety/checks/holderConcentrationCheck.js');
const { loadConfig } = await import('../../src/config/loader.js');
const { getDefaultConfig } = await import('../../src/config/defaults.js');
const { TOKEN_2022_PROGRAM_ID_BASE58, TOKEN_PROGRAM_ID_BASE58 } = await import('../../src/safety/token2022Mint.js');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
const T = 1_000_000_000_000n; // 1M tokens

// ---------- deterministic on-chain account builders ----------
function curveData(o: { realTok: bigint; complete?: boolean; total?: bigint; creator?: PublicKey; mayhem?: number | null; disc?: Buffer; length?: number }): Buffer {
  const len = o.length ?? 151;
  const b = Buffer.alloc(len);
  (o.disc ?? Buffer.from([23, 183, 248, 55, 96, 216, 172, 96])).copy(b, 0);
  b.writeBigUInt64LE(o.realTok + 279_900_000_000_000n, 8);
  b.writeBigUInt64LE(60_000_000_000n, 16);
  b.writeBigUInt64LE(o.realTok, 24);
  b.writeBigUInt64LE(30_000_000_000n, 32);
  b.writeBigUInt64LE(o.total ?? SUPPLY, 40);
  b.writeUInt8(o.complete ? 1 : 0, 48);
  (o.creator ?? PublicKey.unique()).toBuffer().copy(b, 49);
  if (len > 81 && o.mayhem !== null) b.writeUInt8(o.mayhem ?? 0, 81);
  return b;
}
function tokenAccountData(o: { mint: string; owner: string; amount: bigint }): Buffer {
  const b = Buffer.alloc(165);
  new PublicKey(o.mint).toBuffer().copy(b, 0);
  new PublicKey(o.owner).toBuffer().copy(b, 32);
  b.writeBigUInt64LE(o.amount, 64);
  b.writeUInt8(1, 108);
  return b;
}
interface World {
  mint: string;
  program: 'spl-token' | 'token-2022';
  curvePda: string;
  vaultAta: string;
  creator: PublicKey;
  /** tokens SOLD by the curve = circulating supply */
  circulating: bigint;
  curveAcc: { owner: string; data: Buffer; lamports: number } | null;
  vaultAcc: { owner: string; data: Buffer; lamports: number } | null;
}
function world(o: { program?: 'spl-token' | 'token-2022'; sold?: bigint; complete?: boolean; mayhem?: number | null; total?: bigint; curveLen?: number } = {}): World {
  const mint = PublicKey.unique().toBase58();
  const program = o.program ?? 'spl-token';
  const { curvePda, vaultAta } = deriveCurveAndVault(mint, program);
  const creator = PublicKey.unique();
  const sold = o.sold ?? 300n * T;
  const complete = o.complete === true;
  const realTok = complete ? 0n : 793_100_000_000_000n - sold;
  const vaultBalance = complete ? 0n : realTok + PUMPFUN_MIGRATION_RESERVE_RAW;
  const tokenProgramId = program === 'token-2022' ? TOKEN_2022_PROGRAM_ID_BASE58 : TOKEN_PROGRAM_ID_BASE58;
  return {
    mint, program, curvePda: curvePda.toBase58(), vaultAta: vaultAta.toBase58(), creator, circulating: SUPPLY - vaultBalance,
    curveAcc: { owner: PUMP, data: curveData({ realTok, complete, creator, mayhem: o.mayhem === undefined ? 0 : o.mayhem, total: o.total, length: o.curveLen }), lamports: 1 },
    vaultAcc: { owner: tokenProgramId, data: tokenAccountData({ mint, owner: curvePda.toBase58(), amount: vaultBalance }), lamports: 1 },
  };
}
const evidence = (w: World) => ({ curveAddress: w.curvePda, vaultAddress: w.vaultAta, curve: w.curveAcc, vault: w.vaultAcc });
const verify = (w: World, supply: bigint = SUPPLY) => verifyBondingCurveVault(w.mint, { tokenProgram: w.program, supply }, evidence(w));

// ---------- the seven checks ----------
describe('verifyBondingCurveVault: the seven checks', () => {
  it('a live curve with a consistent vault is VERIFIED (SPL Token and Token-2022)', () => {
    for (const program of ['spl-token', 'token-2022'] as const) {
      const w = world({ program });
      const v = verify(w);
      expect(v.status).toBe('verified');
      if (v.status === 'verified') {
        expect(v.phase).toBe('live');
        expect(v.vaultAddress).toBe(w.vaultAta);
        expect(v.vaultBalance).toBe(SUPPLY - w.circulating);
        expect(v.creator).toBe(w.creator.toBase58());
      }
    }
  });

  it('a graduated curve (complete, vault 0, reserves 0) is VERIFIED as graduated', () => {
    const v = verify(world({ complete: true }));
    expect(v).toMatchObject({ status: 'verified', phase: 'graduated', vaultBalance: 0n });
  });

  it('no curve account at the derived PDA => not a Pump.fun curve token (nothing to exclude)', () => {
    const w = world();
    expect(verify({ ...w, curveAcc: null })).toEqual({ status: 'not_curve_token' });
    expect(verify({ ...w, curveAcc: null, vaultAcc: null })).toEqual({ status: 'not_curve_token' });
  });

  it('V1: addresses that do not equal a fresh derivation are unverified (wrong curve address, wrong vault address)', () => {
    const w = world();
    const other = PublicKey.unique().toBase58();
    expect(verifyBondingCurveVault(w.mint, { tokenProgram: w.program, supply: SUPPLY }, { ...evidence(w), curveAddress: other })).toMatchObject({ status: 'unverified', failedChecks: ['V1_addresses_do_not_match_derivation'] });
    expect(verifyBondingCurveVault(w.mint, { tokenProgram: w.program, supply: SUPPLY }, { ...evidence(w), vaultAddress: other })).toMatchObject({ status: 'unverified', failedChecks: ['V1_addresses_do_not_match_derivation'] });
    // the vault of the OTHER token program is not this mint's vault
    const t22 = deriveCurveAndVault(w.mint, 'token-2022').vaultAta.toBase58();
    expect(verifyBondingCurveVault(w.mint, { tokenProgram: 'spl-token', supply: SUPPLY }, { ...evidence(w), vaultAddress: t22 })).toMatchObject({ status: 'unverified' });
  });

  it('V2: every derived curve PDA is off the ed25519 curve (no private key can exist)', () => {
    for (let i = 0; i < 25; i += 1) expect(PublicKey.isOnCurve(deriveCurveAndVault(PublicKey.unique().toBase58(), 'spl-token').curvePda.toBytes())).toBe(false);
  });

  it('V3: a curve account owned by any other program is unverified', () => {
    const w = world();
    const v = verify({ ...w, curveAcc: { ...w.curveAcc!, owner: PublicKey.unique().toBase58() } });
    expect(v).toMatchObject({ status: 'unverified' });
    if (v.status === 'unverified') expect(v.failedChecks).toContain('V3_curve_not_owned_by_pump_program');
  });

  it.each([
    ['too short', (w: World) => ({ ...w.curveAcc!, data: w.curveAcc!.data.subarray(0, 60) })],
    ['wrong discriminator', (w: World) => ({ ...w.curveAcc!, data: curveData({ realTok: 1n, disc: Buffer.alloc(8, 9) }) })],
    ['complete flag not a boolean', (w: World) => { const d = Buffer.from(w.curveAcc!.data); d.writeUInt8(2, 48); return { ...w.curveAcc!, data: d }; }],
  ])('V4: a curve account that does not decode (%s) is unverified', (_n, mutate) => {
    const w = world();
    const v = verify({ ...w, curveAcc: mutate(w) });
    expect(v).toMatchObject({ status: 'unverified' });
    if (v.status === 'unverified') expect(v.failedChecks).toContain('V4_curve_does_not_decode');
  });

  it('V5: a missing vault, a vault of another token program, a wrong mint field or a wrong owner field is unverified', () => {
    const w = world();
    const failed = (x: World) => { const v = verify(x); return v.status === 'unverified' ? v.failedChecks : ['NOT_UNVERIFIED']; };
    expect(failed({ ...w, vaultAcc: null })).toContain('V5_vault_missing_or_wrong_program');
    expect(failed({ ...w, vaultAcc: { ...w.vaultAcc!, owner: TOKEN_2022_PROGRAM_ID_BASE58 } })).toContain('V5_vault_missing_or_wrong_program');
    expect(failed({ ...w, vaultAcc: { ...w.vaultAcc!, data: w.vaultAcc!.data.subarray(0, 40) } })).toContain('V5_vault_missing_or_wrong_program');
    expect(failed({ ...w, vaultAcc: { ...w.vaultAcc!, data: tokenAccountData({ mint: PublicKey.unique().toBase58(), owner: w.curvePda, amount: 1n }) } })).toContain('V5_vault_mint_or_owner_mismatch');
    expect(failed({ ...w, vaultAcc: { ...w.vaultAcc!, data: tokenAccountData({ mint: w.mint, owner: PublicKey.unique().toBase58(), amount: 1n }) } })).toContain('V5_vault_mint_or_owner_mismatch');
  });

  it('V6: the vault balance must equal real reserves + the migration reserve (live) or be 0 with 0 reserves (graduated)', () => {
    const w = world();
    const wrong = (amount: bigint): World => ({ ...w, vaultAcc: { ...w.vaultAcc!, data: tokenAccountData({ mint: w.mint, owner: w.curvePda, amount: (SUPPLY - w.circulating) + amount }) } });
    for (const delta of [1n, -1n, 5n * T]) {
      const v = verify(wrong(delta));
      expect(v.status).toBe('unverified');
      if (v.status === 'unverified') expect(v.failedChecks).toContain('V6_vault_balance_does_not_match_curve_reserves');
    }
    // graduated curve whose vault still holds tokens
    const g = world({ complete: true });
    const dirty: World = { ...g, vaultAcc: { ...g.vaultAcc!, data: tokenAccountData({ mint: g.mint, owner: g.curvePda, amount: 10n }) } };
    expect(verify(dirty)).toMatchObject({ status: 'unverified' });
  });

  it('V7: a mint supply above the curve total supply is unverified (mayhem tokens have 2x supply)', () => {
    const w = world();
    const v = verify(w, SUPPLY + 1n);
    expect(v.status).toBe('unverified');
    if (v.status === 'unverified') expect(v.failedChecks).toContain('V7_mint_supply_above_curve_total_supply');
    expect(verify(w, SUPPLY - 5n).status).toBe('verified'); // burns only lower supply
  });

  it('mayhem-mode curves and curves whose mode is unreadable are unverified (fail closed)', () => {
    const mayhem = verify(world({ mayhem: 1 }));
    expect(mayhem).toMatchObject({ status: 'unverified' });
    if (mayhem.status === 'unverified') expect(mayhem.failedChecks).toContain('mayhem_mode_curve');
    const unreadable = verify(world({ curveLen: 81 })); // legacy core only: no mode byte
    expect(unreadable).toMatchObject({ status: 'unverified' });
    if (unreadable.status === 'unverified') expect(unreadable.failedChecks).toContain('curve_mode_unproven');
  });

  it('several failures are all reported', () => {
    const w = world();
    const v = verify({ ...w, curveAcc: { ...w.curveAcc!, owner: PublicKey.unique().toBase58() }, vaultAcc: null });
    expect(v.status).toBe('unverified');
    if (v.status === 'unverified') expect(v.failedChecks.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------- the policy ----------
const acct = (address: string, amount: bigint): HolderBalance => ({ address, amount });
const others = (n: number, amount: bigint, prefix = 'h'): HolderBalance[] => Array.from({ length: n }, (_, i) => acct(`${prefix}${i}`, amount));
const verifiedLive = (vaultBalance: bigint, creator = 'CREATOR') => ({ status: 'verified' as const, phase: 'live' as const, vaultAddress: 'VAULT', vaultBalance, creator });
const base = { maxTop10Pct: 60, minCirculatingSharePct: 0, minVisibleHolders: 0, excludeAddresses: [] as string[], creatorBalanceRaw: null as bigint | null };

describe('evaluateHolderPolicy', () => {
  it('BEFORE/AFTER: the vault dominates the old metric; the new metric measures the circulating holders', () => {
    // supply 1000: vault 700 (unsold), 19 holders x 15 = 285, tail 15
    const largest = [acct('VAULT', 700n), ...others(19, 15n)];
    const oldMetric = evaluateHolderConcentration({ largestAccounts: largest, totalSupply: 1000n, excludeAddresses: [] }, 60);
    expect(oldMetric).toMatchObject({ passed: false, reason: 'holder_concentration_too_high' });
    expect(oldMetric.top10Pct).toBe(83.5);
    const r = evaluateHolderPolicy({ ...base, largestAccounts: largest, totalSupply: 1000n, vault: verifiedLive(700n) });
    expect(r.passed).toBe(true);
    expect(r.top10Pct).toBe(50); // 10 x 15 / 300 circulating
    expect(r.diagnostics).toMatchObject({ policy: 'verified_vault_excluded', vaultStatus: 'verified', phase: 'live', circulatingRaw: '300', legacyTop10Pct: 83.5 });
  });

  it('concentration above 60% of circulating rejects; exactly 60% passes (limit unchanged, not-greater-than)', () => {
    const at = evaluateHolderPolicy({ ...base, largestAccounts: [acct('VAULT', 700n), ...others(10, 18n)], totalSupply: 1000n, vault: verifiedLive(700n) });
    expect(at.top10Pct).toBe(60);
    expect(at.passed).toBe(true);
    const over = evaluateHolderPolicy({ ...base, largestAccounts: [acct('VAULT', 700n), ...others(10, 19n)], totalSupply: 1000n, vault: verifiedLive(700n) });
    expect(over.reasons).toEqual(['holder_concentration_too_high']);
    expect(over.passed).toBe(false);
  });

  it('removes ONLY the verified vault: a developer wallet, an LP-like or unknown large account stays counted', () => {
    const largest = [acct('LP_OR_UNKNOWN', 200n), acct('VAULT', 600n), acct('DEV', 100n), ...others(8, 5n)]; // supply 1000, circulating 400
    const r = evaluateHolderPolicy({ ...base, largestAccounts: largest, totalSupply: 1000n, vault: verifiedLive(600n) });
    expect(r.top10Pct).toBe(85); // (200 + 100 + 8x5) / 400
    expect(r.reasons).toEqual(['holder_concentration_too_high']);
  });

  it('a vault that is not among the returned accounts removes nothing else', () => {
    const r = evaluateHolderPolicy({ ...base, largestAccounts: others(20, 10n), totalSupply: 1000n, vault: verifiedLive(700n) });
    expect(r.top10Pct).toBe(33.3333); // 100 / 300
  });

  it('the configured excludeAddresses still apply in addition to the vault', () => {
    const r = evaluateHolderPolicy({ ...base, excludeAddresses: ['BURN'], largestAccounts: [acct('VAULT', 700n), acct('BURN', 100n), ...others(10, 10n)], totalSupply: 1000n, vault: verifiedLive(700n) });
    expect(r.top10Pct).toBe(33.3333); // BURN removed: 10 x 10 / 300
  });

  it('zero or negative circulating supply rejects with no concentration figure', () => {
    const zero = evaluateHolderPolicy({ ...base, largestAccounts: [acct('VAULT', 1000n)], totalSupply: 1000n, vault: verifiedLive(1000n) });
    expect(zero).toMatchObject({ passed: false, reasons: ['holder_circulating_supply_invalid'], top10Pct: null });
    const negative = evaluateHolderPolicy({ ...base, largestAccounts: [acct('VAULT', 900n)], totalSupply: 1000n, vault: verifiedLive(1200n) });
    expect(negative).toMatchObject({ passed: false, reasons: ['holder_circulating_supply_invalid'], top10Pct: null });
  });

  it('invalid total supply rejects (as before)', () => {
    for (const vault of [verifiedLive(0n), { status: 'not_curve_token' as const }, { status: 'unavailable' as const, cause: 'x' }]) {
      expect(evaluateHolderPolicy({ ...base, largestAccounts: others(3, 1n), totalSupply: 0n, vault }).reasons).toEqual(['invalid_supply']);
    }
  });

  it('an UNVERIFIED or UNAVAILABLE vault is holder_vault_unknown (fail closed) even when the holders look perfectly spread', () => {
    const spread = others(20, 1n);
    const unverified = evaluateHolderPolicy({ ...base, largestAccounts: spread, totalSupply: 1_000_000n, vault: { status: 'unverified', failedChecks: ['V6_vault_balance_does_not_match_curve_reserves'] } });
    expect(unverified).toMatchObject({ passed: false, reasons: ['holder_vault_unknown'], top10Pct: null });
    expect(unverified.diagnostics.vaultFailedChecks).toEqual(['V6_vault_balance_does_not_match_curve_reserves']);
    const unavailable = evaluateHolderPolicy({ ...base, largestAccounts: spread, totalSupply: 1_000_000n, vault: { status: 'unavailable', cause: 'provider:rate_limited' } });
    expect(unavailable).toMatchObject({ passed: false, reasons: ['holder_vault_unknown'], top10Pct: null });
    expect(unavailable.diagnostics.vaultUnavailableCause).toBe('provider:rate_limited');
  });

  it('a graduated curve keeps the previous metric exactly (PumpSwap-owned accounts stay counted; no exclusion, no floors)', () => {
    const largest = [acct('PUMPSWAP_OWNED', 900n), ...others(10, 5n)];
    const old = evaluateHolderConcentration({ largestAccounts: largest, totalSupply: 1000n, excludeAddresses: [] }, 60);
    const r = evaluateHolderPolicy({ ...base, minCirculatingSharePct: 99, minVisibleHolders: 50, largestAccounts: largest, totalSupply: 1000n, vault: { status: 'verified', phase: 'graduated', vaultAddress: 'VAULT', vaultBalance: 0n, creator: 'C' } });
    expect(r).toMatchObject({ passed: old.passed, top10Pct: old.top10Pct, reasons: ['holder_concentration_too_high'] });
    expect(r.diagnostics.policy).toBe('legacy_total_supply');
    const ok = evaluateHolderPolicy({ ...base, minCirculatingSharePct: 99, largestAccounts: others(20, 10n), totalSupply: 1000n, vault: { status: 'verified', phase: 'graduated', vaultAddress: 'V', vaultBalance: 0n, creator: 'C' } });
    expect(ok.passed).toBe(true); // floors are not applied to graduated tokens
  });

  it('a token with no bonding curve keeps the previous metric exactly', () => {
    for (const largest of [others(20, 10n), [acct('WHALE', 800n), ...others(5, 1n)]]) {
      const old = evaluateHolderConcentration({ largestAccounts: largest, totalSupply: 1000n, excludeAddresses: [] }, 60);
      const r = evaluateHolderPolicy({ ...base, largestAccounts: largest, totalSupply: 1000n, vault: { status: 'not_curve_token' } });
      expect(r.passed).toBe(old.passed);
      expect(r.top10Pct).toBe(old.top10Pct);
      expect(r.reasons).toEqual(old.reason ? [old.reason] : []);
    }
  });

  describe('configurable safeguards (OFF by default)', () => {
    const tiny = { largestAccounts: [acct('VAULT', 999n), acct('a', 1n)], totalSupply: 1000n, vault: verifiedLive(999n) }; // 0.1% circulating, one holder

    it('off (0) by default: a tiny circulating base is not blocked by a safeguard (only the concentration limit applies)', () => {
      const r = evaluateHolderPolicy({ ...base, ...tiny });
      expect(r.diagnostics.circulatingSharePct).toBe(0.1);
      expect(r.reasons).toEqual(['holder_concentration_too_high']); // 100% of a tiny base, from the concentration rule
      const spread = evaluateHolderPolicy({ ...base, largestAccounts: [acct('VAULT', 999n), ...others(10, 0n)], totalSupply: 1000n, vault: verifiedLive(999n) });
      expect(spread.reasons).not.toContain('holder_circulating_share_too_low');
    });

    it('minimum circulating share: below rejects, equal passes, above passes', () => {
      const mk = (min: number, sold: bigint) => evaluateHolderPolicy({ ...base, minCirculatingSharePct: min, largestAccounts: [acct('VAULT', 1000n - sold), ...others(20, sold / 20n)], totalSupply: 1000n, vault: verifiedLive(1000n - sold) });
      expect(mk(10, 100n).reasons).toEqual([]); // exactly 10%
      expect(mk(10, 99n).reasons).toEqual(['holder_circulating_share_too_low']);
      expect(mk(10, 300n).reasons).toEqual([]);
      expect(mk(0, 1n).reasons).toEqual([]); // off
    });

    it('minimum visible holders counts non-vault, non-excluded accounts with a balance', () => {
      const largest = [acct('VAULT', 700n), acct('a', 100n), acct('b', 100n), acct('zero', 0n), acct('EXC', 100n)];
      const r = (min: number) => evaluateHolderPolicy({ ...base, minVisibleHolders: min, excludeAddresses: ['EXC'], largestAccounts: largest, totalSupply: 1000n, vault: verifiedLive(700n) });
      expect(r(2).diagnostics.visibleHolders).toBe(2);
      expect(r(2).reasons).not.toContain('holder_visible_holders_too_low');
      expect(r(3).reasons).toContain('holder_visible_holders_too_low');
      expect(r(0).reasons).not.toContain('holder_visible_holders_too_low');
    });

    it('safeguards do not mask the concentration rule: every failing rule is reported', () => {
      const r = evaluateHolderPolicy({ ...base, minCirculatingSharePct: 50, minVisibleHolders: 5, ...tiny });
      expect(r.reasons).toEqual(['holder_concentration_too_high', 'holder_circulating_share_too_low', 'holder_visible_holders_too_low']);
    });
  });

  describe('creator concentration is diagnostic only', () => {
    it('is recorded (a lower bound) and never adds a rejection reason', () => {
      const largest = [acct('VAULT', 700n), acct('CREATOR_ACCT', 90n), ...others(9, 10n)]; // top-10 non-vault = 90 + 8x10... circulating 300
      const r = evaluateHolderPolicy({ ...base, largestAccounts: largest, totalSupply: 1000n, vault: verifiedLive(700n), creatorBalanceRaw: 90n });
      expect(r.diagnostics.creatorPctOfCirculating).toBe(30);
      expect(r.reasons.join(' ')).not.toMatch(/creator/);
      expect(r.passed).toBe(true);
    });

    it('a creator holding almost all circulating supply is rejected by the CONCENTRATION rule, not by a creator rule', () => {
      const r = evaluateHolderPolicy({ ...base, largestAccounts: [acct('VAULT', 700n), acct('CREATOR_ACCT', 290n)], totalSupply: 1000n, vault: verifiedLive(700n), creatorBalanceRaw: 290n });
      expect(r.diagnostics.creatorPctOfCirculating).toBeCloseTo(96.6667, 3);
      expect(r.reasons).toEqual(['holder_concentration_too_high']);
    });

    it('an unknown creator share is null and changes nothing', () => {
      const withNull = evaluateHolderPolicy({ ...base, largestAccounts: [acct('VAULT', 700n), ...others(19, 15n)], totalSupply: 1000n, vault: verifiedLive(700n), creatorBalanceRaw: null });
      expect(withNull.diagnostics.creatorPctOfCirculating).toBeNull();
      expect(withNull.passed).toBe(true);
    });
  });
});

// ---------- the full gate, on-chain shaped data ----------
const cfg = (over: { minCirculatingSharePct?: number; minVisibleHolders?: number } = {}) => ({
  safety: { maxTop10HolderPct: 60, excludeAddresses: [] as string[], ...over },
  filters: { minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 },
  edge: { dexFeeBps: 25, swapFeeBps: 5, networkFeeSol: 0.000005, priorityFeeSol: 0.0005, safetyMarginBps: 50 },
});
const goodAggregator = { getLiquidityAndVolume: vi.fn().mockResolvedValue({ liquiditySol: 40, volume1mSol: 10, buySellRatio: 2, txCount1m: 5 }) } as never;
const goodRoundTrip = () => vi.fn().mockResolvedValue({ buyPriceImpactPct: 0.4, sellPriceImpactPct: 0.5 }) as never;

/** A connection whose accounts are keyed by address; `missing` keys read as null; `fail` makes the batch read throw. */
function connectionFor(w: World, o: { holders: Array<{ address: string; amount: bigint }> | 'throw'; owners?: Record<string, string>; failCurveRead?: boolean; failOwnersRead?: boolean; extra?: Record<string, { owner: string; data: Buffer; lamports: number } | null> } ) {
  const accounts = new Map<string, { owner: string; data: Buffer; lamports: number } | null>([[w.curvePda, w.curveAcc], [w.vaultAta, w.vaultAcc]]);
  for (const [addr, owner] of Object.entries(o.owners ?? {})) accounts.set(addr, { owner: w.program === 'token-2022' ? TOKEN_2022_PROGRAM_ID_BASE58 : TOKEN_PROGRAM_ID_BASE58, data: tokenAccountData({ mint: w.mint, owner, amount: 1n }), lamports: 1 });
  for (const [addr, acc] of Object.entries(o.extra ?? {})) accounts.set(addr, acc);
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) => {
    const isCurveRead = keys.length === 2 && keys[0]!.toBase58() === w.curvePda;
    if (isCurveRead && o.failCurveRead) throw new Error('rpc down');
    if (!isCurveRead && o.failOwnersRead) throw new Error('rpc down');
    return keys.map((k) => { const a = accounts.get(k.toBase58()); return a ? { owner: new PublicKey(a.owner), data: a.data, lamports: a.lamports } : null; });
  });
  return {
    getMultipleAccountsInfo,
    getAccountInfo: vi.fn(async () => null),
    getTokenLargestAccounts: vi.fn(async () => {
      if (o.holders === 'throw') throw new Error('rpc down');
      return { value: o.holders.map((h) => ({ address: new PublicKey(h.address), amount: String(h.amount) })) };
    }),
  } as never;
}
const wrongOwner = (): Error => Object.assign(new Error('Invalid account owner'), { name: 'TokenInvalidAccountOwnerError' });

/** 19 holders of 15M each on top of the vault: circulating 300M, the vault holds the other 700M. */
function spreadHolders(w: World): Array<{ address: string; amount: bigint }> {
  return [{ address: w.vaultAta, amount: SUPPLY - w.circulating }, ...Array.from({ length: 19 }, () => ({ address: PublicKey.unique().toBase58(), amount: 15n * T }))];
}
async function gate(w: World, conn: unknown, c = cfg(), extra: { onUnavailable?: (s: string, r: string) => void } = {}) {
  return runSafetyGate(w.mint, { connection: conn as never, aggregator: goodAggregator, getRoundTripQuote: goodRoundTrip(), ...(extra.onUnavailable ? { onUnavailable: extra.onUnavailable as never } : {}) }, c);
}

describe('runSafetyGate with the verified-vault holder policy', () => {
  beforeEach(() => {
    getMintMock.mockReset();
    getMintMock.mockImplementation(async () => ({ mintAuthority: null, freezeAuthority: null, supply: SUPPLY, decimals: 6 }));
  });

  it('BEFORE/AFTER on a live curve: the old metric would reject (83.5%), the new policy passes (50% of circulating) and records why', async () => {
    const w = world();
    const holders = spreadHolders(w);
    const r = await gate(w, connectionFor(w, { holders }));
    const oldMetric = evaluateHolderConcentration({ largestAccounts: holders.map((h) => acct(h.address, h.amount)), totalSupply: SUPPLY, excludeAddresses: [] }, 60);
    expect(oldMetric.passed).toBe(false);
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.top10HolderPct).toBe(50);
    expect(r.holderPolicy).toMatchObject({ policy: 'verified_vault_excluded', vaultStatus: 'verified', phase: 'live', circulatingSharePct: 30, visibleHolders: 19 });
  });

  it('the same live curve with a high concentration among circulating holders still rejects (limit 60%)', async () => {
    const w = world();
    const holders = [{ address: w.vaultAta, amount: SUPPLY - w.circulating }, { address: PublicKey.unique().toBase58(), amount: 250n * T }, { address: PublicKey.unique().toBase58(), amount: 50n * T }];
    const r = await gate(w, connectionFor(w, { holders }));
    expect(r.passed).toBe(false);
    expect(r.reasons).toEqual(['holder_concentration_too_high']);
  });

  it('Token-2022 live curve: the vault is the Token-2022 ATA and is verified and excluded', async () => {
    const w = world({ program: 'token-2022' });
    getMintMock.mockRejectedValue(wrongOwner());
    const mintAcc = Buffer.alloc(82);
    mintAcc.writeBigUInt64LE(SUPPLY, 36);
    mintAcc.writeUInt8(6, 44);
    mintAcc.writeUInt8(1, 45);
    const conn = connectionFor(w, { holders: spreadHolders(w) }) as { getAccountInfo: ReturnType<typeof vi.fn> };
    conn.getAccountInfo.mockResolvedValue({ owner: new PublicKey(TOKEN_2022_PROGRAM_ID_BASE58), data: mintAcc, lamports: 1 });
    const r = await gate(w, conn);
    expect(r.holderPolicy).toMatchObject({ policy: 'verified_vault_excluded', vaultStatus: 'verified' });
    expect(r.passed).toBe(true);
  });

  it('a tampered vault (balance does not match the curve) => holder_vault_unknown, not passed, no concentration figure', async () => {
    const w = world();
    const bad: World = { ...w, vaultAcc: { ...w.vaultAcc!, data: tokenAccountData({ mint: w.mint, owner: w.curvePda, amount: 5n * T }) } };
    const r = await gate(w, connectionFor(bad, { holders: spreadHolders(w) }));
    expect(r.passed).toBe(false);
    expect(r.reasons).toEqual(['holder_vault_unknown']);
    expect(r.top10HolderPct).toBeNull();
    expect(r.holderPolicy?.vaultFailedChecks).toContain('V6_vault_balance_does_not_match_curve_reserves');
  });

  it('a mayhem-mode curve (2x supply) => holder_vault_unknown', async () => {
    const w = world({ mayhem: 1 });
    const r = await gate(w, connectionFor(w, { holders: spreadHolders(w) }));
    expect(r.reasons).toEqual(['holder_vault_unknown']);
    expect(r.holderPolicy?.vaultFailedChecks).toContain('mayhem_mode_curve');
  });

  it('an RPC failure while reading the curve/vault => holder_vault_unknown, recorded as a provider failure', async () => {
    const w = world();
    const seen: Array<[string, string]> = [];
    const r = await gate(w, connectionFor(w, { holders: spreadHolders(w), failCurveRead: true }), cfg(), { onUnavailable: (s, why) => seen.push([s, why]) });
    expect(r.passed).toBe(false);
    expect(r.reasons).toEqual(['holder_vault_unknown']);
    expect(r.details.dataFailures).toMatchObject({ vault: 'provider:error' });
    expect(seen).toContainEqual(['vault', 'provider:error']);
    expect(r.top10HolderPct).toBeNull();
  });

  it('zero circulating supply (nothing sold yet) rejects even though the vault is verified', async () => {
    const w = world({ sold: 0n });
    const r = await gate(w, connectionFor(w, { holders: [{ address: w.vaultAta, amount: SUPPLY }] }));
    expect(r.passed).toBe(false);
    expect(r.reasons).toEqual(['holder_circulating_supply_invalid']);
  });

  it('graduated curve: the previous metric applies unchanged (the pool-like account is counted and rejects)', async () => {
    const w = world({ complete: true });
    const r = await gate(w, connectionFor(w, { holders: [{ address: PublicKey.unique().toBase58(), amount: 900n * T }, ...Array.from({ length: 5 }, () => ({ address: PublicKey.unique().toBase58(), amount: 10n * T }))] }));
    expect(r.reasons).toEqual(['holder_concentration_too_high']);
    expect(r.holderPolicy?.policy).toBe('legacy_total_supply');
    expect(r.top10HolderPct).toBe(95);
  });

  it('a token with no bonding curve: the previous metric applies unchanged', async () => {
    const w = world();
    const noCurve: World = { ...w, curveAcc: null, vaultAcc: null };
    const r = await gate(w, connectionFor(noCurve, { holders: [{ address: PublicKey.unique().toBase58(), amount: 10n * T }] }));
    expect(r.passed).toBe(true);
    expect(r.holderPolicy).toMatchObject({ policy: 'legacy_total_supply', vaultStatus: 'not_curve_token' });
  });

  it('holder data unavailable is unchanged and the curve is not even read', async () => {
    const w = world();
    const conn = connectionFor(w, { holders: 'throw' });
    const r = await gate(w, conn);
    expect(r.reasons).toContain('holder_data_unavailable');
    expect((conn as unknown as { getMultipleAccountsInfo: ReturnType<typeof vi.fn> }).getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it('mint unavailable is unchanged (no holder or curve reads)', async () => {
    const w = world();
    getMintMock.mockRejectedValue(new Error('rpc down'));
    const conn = connectionFor(w, { holders: spreadHolders(w) });
    const r = await gate(w, conn);
    expect(r.reasons).toEqual(expect.arrayContaining(['mint_account_unavailable', 'holder_data_unavailable']));
    expect((conn as unknown as { getMultipleAccountsInfo: ReturnType<typeof vi.fn> }).getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it('configurable safeguards apply to live curves only when set: minimum circulating share and minimum visible holders', async () => {
    const w = world(); // circulating 30%, 19 visible holders
    const holders = spreadHolders(w);
    expect((await gate(w, connectionFor(w, { holders }), cfg())).passed).toBe(true); // off by default
    expect((await gate(w, connectionFor(w, { holders }), cfg({ minCirculatingSharePct: 30 }))).passed).toBe(true); // equal passes
    const share = await gate(w, connectionFor(w, { holders }), cfg({ minCirculatingSharePct: 31 }));
    expect(share.reasons).toEqual(['holder_circulating_share_too_low']);
    const few = await gate(w, connectionFor(w, { holders }), cfg({ minVisibleHolders: 20 }));
    expect(few.reasons).toEqual(['holder_visible_holders_too_low']);
    expect((await gate(w, connectionFor(w, { holders }), cfg({ minVisibleHolders: 19 }))).passed).toBe(true);
  });

  it('creator share is recorded when the account owners can be read, never rejects, and an unreadable owner lookup changes nothing', async () => {
    const w = world();
    const holders = spreadHolders(w);
    const creatorAcct = holders[1]!.address;
    const ok = await gate(w, connectionFor(w, { holders, owners: { [creatorAcct]: w.creator.toBase58() } }));
    expect(ok.passed).toBe(true);
    expect(ok.holderPolicy?.creatorPctOfCirculating).toBe(5); // 15M of 300M circulating
    const failed = await gate(w, connectionFor(w, { holders, owners: { [creatorAcct]: w.creator.toBase58() }, failOwnersRead: true }));
    expect(failed.passed).toBe(true);
    expect(failed.holderPolicy?.creatorPctOfCirculating).toBeNull();
    // a creator holding 100% of circulating supply is rejected by the concentration rule
    const soleHolder = [{ address: w.vaultAta, amount: SUPPLY - w.circulating }, { address: creatorAcct, amount: w.circulating }];
    const heavy = await gate(w, connectionFor(w, { holders: soleHolder, owners: { [creatorAcct]: w.creator.toBase58() } }));
    expect(heavy.holderPolicy?.creatorPctOfCirculating).toBe(100);
    expect(heavy.reasons).toEqual(['holder_concentration_too_high']);
  });

  it('every other existing check is untouched: mint authority, freeze authority, sellability still reject on a live curve', async () => {
    const w = world();
    getMintMock.mockResolvedValue({ mintAuthority: { toBase58: () => 'AUTH' }, freezeAuthority: { toBase58: () => 'FRZ' }, supply: SUPPLY, decimals: 6 });
    const r = await gate(w, connectionFor(w, { holders: spreadHolders(w) }));
    expect(r.reasons).toEqual(expect.arrayContaining(['mint_authority_not_renounced', 'freeze_authority_present']));
    getMintMock.mockResolvedValue({ mintAuthority: null, freezeAuthority: null, supply: SUPPLY, decimals: 6 });
    const noQuote = await runSafetyGate(w.mint, { connection: connectionFor(w, { holders: spreadHolders(w) }), aggregator: goodAggregator, getRoundTripQuote: vi.fn().mockResolvedValue(null) as never }, cfg());
    expect(noQuote.reasons).toEqual(['quote_unavailable']);
  });
});

describe('CachedSafetyDataSource: curve evidence', () => {
  it('a successful read is reused within the TTL and a failure is never cached', async () => {
    const w = world();
    let calls = 0;
    let failNext = true;
    const inner = {
      getMintSummary: vi.fn(), getLargestHolders: vi.fn(), getTokenAccountOwners: vi.fn(),
      getBondingCurveAccounts: vi.fn(async () => {
        calls += 1;
        if (failNext) { failNext = false; return { value: null, failure: { kind: 'provider' as const, reason: 'rate_limited' }, asOfMs: Date.now() }; }
        return { value: evidence(w), failure: null, asOfMs: Date.now() };
      }),
    };
    const cached = new CachedSafetyDataSource(inner as never, { ttlMs: 10_000 });
    const summary = { mint: w.mint, mintAuthority: null, freezeAuthority: null, supply: SUPPLY, decimals: 6 };
    expect((await cached.getBondingCurveAccounts(w.mint, summary)).value).toBeNull();
    expect((await cached.getBondingCurveAccounts(w.mint, summary)).value).not.toBeNull();
    await cached.getBondingCurveAccounts(w.mint, summary);
    expect(calls).toBe(2); // failure retried, success reused
  });

  it('the direct source derives the two addresses and reads them in ONE batch (same slot)', async () => {
    const w = world();
    const conn = connectionFor(w, { holders: [] }) as unknown as { getMultipleAccountsInfo: ReturnType<typeof vi.fn> };
    const out = await new DirectSafetyDataSource(conn as never).getBondingCurveAccounts(w.mint, { mint: w.mint, mintAuthority: null, freezeAuthority: null, supply: SUPPLY, decimals: 6 });
    expect(conn.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(out.value).toMatchObject({ curveAddress: w.curvePda, vaultAddress: w.vaultAta });
    expect(out.value?.curve?.owner).toBe(PUMP);
  });
});

describe('configuration', () => {
  it('the two safeguards default to OFF (0) and the 60% concentration limit is unchanged', () => {
    const c = getDefaultConfig();
    expect(c.safety).toMatchObject({ maxTop10HolderPct: 60, minCirculatingSharePct: 0, minVisibleHolders: 0 });
    const l = loadConfig({} as NodeJS.ProcessEnv);
    expect(l.safety.minCirculatingSharePct).toBe(0);
    expect(l.safety.minVisibleHolders).toBe(0);
  });

  it('SAFETY_MIN_CIRCULATING_SHARE_PCT and SAFETY_MIN_VISIBLE_HOLDERS are read from the environment', () => {
    const l = loadConfig({ SAFETY_MIN_CIRCULATING_SHARE_PCT: '12.5', SAFETY_MIN_VISIBLE_HOLDERS: '4' } as NodeJS.ProcessEnv);
    expect(l.safety).toMatchObject({ minCirculatingSharePct: 12.5, minVisibleHolders: 4, maxTop10HolderPct: 60 });
  });

  it('an invalid value fails loudly instead of silently switching the safeguard off', () => {
    expect(() => loadConfig({ SAFETY_MIN_CIRCULATING_SHARE_PCT: 'abc' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ SAFETY_MIN_CIRCULATING_SHARE_PCT: '150' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ SAFETY_MIN_CIRCULATING_SHARE_PCT: '-1' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ SAFETY_MIN_VISIBLE_HOLDERS: '2.5' } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ SAFETY_MIN_VISIBLE_HOLDERS: '-3' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('V1 entry filters and hard risk are untouched', () => {
    const c = getDefaultConfig();
    expect(c.filters).toMatchObject({ minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 });
    expect(c.dryRun).toBe(true);
  });
});
