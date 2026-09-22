import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accountMatchesCurve,
  assessAccountFreshness,
  BONDING_CURVE_MIN_LENGTH,
  decodeBondingCurveAccount,
  deriveBondingCurvePda,
} from '../../src/volume/bondingCurveAccount.js';
import {
  buyPriceImpactPct,
  chainLinks,
  entryNetLamports,
  isConstantProductStep,
  preTradeState,
  realSolLiquidity,
  spotPriceSol,
  tokensOutForNetSol,
} from '../../src/volume/bondingCurveMath.js';
import { decodePumpfunNotification, PUMPFUN_PROGRAM_ID } from '../../src/volume/pumpfunTradeEventDecoder.js';
import type { CurveState } from '../../src/volume/types.js';
import { CurveSim, REAL } from './helpers.js';

interface FixtureAccount {
  kind: 'standard' | 'mayhem' | 'graduated';
  mint: string;
  pda: string;
  contextSlot: number;
  owner: string;
  lamports: number;
  len: number;
  data: string;
  mintDecimals: number;
  lastEvent: { slot: number; vsol: string; vtok: string; rsol: string; rtok: string };
}
const FIX: { global: { owner: string; len: number; data: string }; accounts: FixtureAccount[] } = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'pumpfun', 'bonding_curve_accounts.json'), 'utf8'),
);
const acct = (kind: FixtureAccount['kind'], i = 0): FixtureAccount => FIX.accounts.filter((a) => a.kind === kind)[i] as FixtureAccount;
const asAccount = (a: FixtureAccount) => ({ owner: a.owner, data: Buffer.from(a.data, 'base64'), lamports: a.lamports });
/** Measured on 300+ real accounts: lamports - real_sol_reserves == the rent-exempt minimum of the account size, 5,080 lamports per (data length + 128). */
const rentExemptMinimum = (len: number): number => 5080 * (len + 128);

describe('bonding-curve ACCOUNT decoding (real mainnet accounts)', () => {
  it('A/E/F: decodes a real standard curve: virtual and real reserves, supply, flags', () => {
    const a = acct('standard');
    const d = decodeBondingCurveAccount(asAccount(a));
    expect(d.quality).toBe('VALID');
    const s = d.state!;
    expect(s.virtualSolReserves - s.realSolReserves).toBe(30_000_000_000n); // the Global initial virtual SOL
    expect(s.virtualTokenReserves - s.realTokenReserves).toBe(279_900_000_000_000n); // 1.073e15 - 793.1e12
    expect(s.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(s.complete).toBe(false);
    expect(s.isMayhemMode).toBe(false);
    expect(s.quoteMint).toBe('11111111111111111111111111111111');
  });

  it('real_sol_reserves equals the account lamports minus rent (of its size) on every real SOL-quoted account -- the basis of the liquidity definition', () => {
    const sizes = new Set<number>();
    for (const a of FIX.accounts) {
      sizes.add(a.len);
      const s = decodeBondingCurveAccount(asAccount(a)).state!;
      // a live account keeps accruing after the snapshot fields were written only within the same slot; these were read atomically
      expect(a.lamports - Number(s.realSolReserves) - rentExemptMinimum(a.len), a.mint).toBeLessThanOrEqual(12); // <= a few lamports of drift
      expect(a.lamports - Number(s.realSolReserves) - rentExemptMinimum(a.len), a.mint).toBeGreaterThanOrEqual(-12);
    }
    expect([...sizes].sort()).toEqual([125, 151]); // both real layouts are covered
  });

  it('the PDA derivation reproduces the real account address for every fixture mint', () => {
    for (const a of FIX.accounts) expect(deriveBondingCurvePda(a.mint)).toBe(a.pda);
  });

  it('a real quiet token: the account equals the last TradeEvent state exactly (events carry the account state)', () => {
    for (const a of FIX.accounts.filter((x) => x.kind === 'mayhem').filter((x) => x.mint.startsWith('Fnz4dR') || x.mint.startsWith('F7so7d'))) {
      const s = decodeBondingCurveAccount(asAccount(a)).state!;
      expect(s.virtualSolReserves.toString()).toBe(a.lastEvent.vsol);
      expect(s.virtualTokenReserves.toString()).toBe(a.lastEvent.vtok);
      expect(s.realSolReserves.toString()).toBe(a.lastEvent.rsol);
      expect(s.realTokenReserves.toString()).toBe(a.lastEvent.rtok);
      const curve: CurveState = { virtualSolReserves: s.virtualSolReserves, virtualTokenReserves: s.virtualTokenReserves, realSolReserves: s.realSolReserves, realTokenReserves: s.realTokenReserves, feeBasisPoints: 0, creatorFeeBasisPoints: 0, mayhemMode: true };
      expect(accountMatchesCurve(s, curve)).toBe(true);
    }
  });

  it('a real mayhem-mode curve is identified by its flag', () => {
    expect(decodeBondingCurveAccount(asAccount(acct('mayhem'))).state!.isMayhemMode).toBe(true);
  });

  it('M: a real graduated curve (complete = true, reserves zeroed) is GRADUATED, never a zero price or zero liquidity', () => {
    const d = decodeBondingCurveAccount(asAccount(acct('graduated')));
    expect(d.quality).toBe('GRADUATED');
    expect(d.state!.complete).toBe(true);
    expect(d.state!.virtualSolReserves).toBe(0n);
    expect(spotPriceSol(d.state!.virtualSolReserves, d.state!.virtualTokenReserves)).toBeNull(); // 0 reserves are not a price of 0
  });

  it('N: a missing account is UNAVAILABLE', () => {
    expect(decodeBondingCurveAccount(null)).toMatchObject({ quality: 'UNAVAILABLE', reason: 'account_missing', state: null });
    expect(decodeBondingCurveAccount(undefined).quality).toBe('UNAVAILABLE');
  });

  it('C: an account owned by another program is WRONG_PROGRAM', () => {
    const a = asAccount(acct('standard'));
    expect(decodeBondingCurveAccount({ ...a, owner: '11111111111111111111111111111111' })).toMatchObject({ quality: 'WRONG_PROGRAM', state: null });
    expect(decodeBondingCurveAccount(a, PUMPFUN_PROGRAM_ID).quality).toBe('VALID');
  });

  it('D: a wrong account size is MALFORMED (too short); an oversized real account (151 B) is accepted', () => {
    const a = asAccount(acct('standard'));
    expect(a.data.length).toBe(151);
    const legacy125 = FIX.accounts.find((x) => x.len === 125)!;
    expect(decodeBondingCurveAccount(asAccount(legacy125)).quality).toBe('VALID'); // the 125-byte layout is a real, current account size
    expect(decodeBondingCurveAccount({ ...a, data: a.data.subarray(0, BONDING_CURVE_MIN_LENGTH - 1) })).toMatchObject({ quality: 'MALFORMED', reason: 'account_too_short' });
    expect(decodeBondingCurveAccount({ ...a, data: a.data.subarray(0, 0) }).quality).toBe('MALFORMED');
    expect(decodeBondingCurveAccount({ ...a, data: a.data.subarray(0, BONDING_CURVE_MIN_LENGTH) }).quality).toBe('VALID'); // legacy core layout
  });

  it('B: malformed contents are MALFORMED (wrong discriminator, non-boolean flag, real reserves above virtual)', () => {
    const base = asAccount(acct('standard'));
    const badDisc = Buffer.from(base.data);
    badDisc[0] = 0;
    expect(decodeBondingCurveAccount({ ...base, data: badDisc })).toMatchObject({ quality: 'MALFORMED', reason: 'discriminator_mismatch' });
    const badFlag = Buffer.from(base.data);
    badFlag[48] = 9;
    expect(decodeBondingCurveAccount({ ...base, data: badFlag }).quality).toBe('MALFORMED');
    const badReserves = Buffer.from(base.data);
    badReserves.writeBigUInt64LE(badReserves.readBigUInt64LE(16) + 1n, 32); // real SOL > virtual SOL
    expect(decodeBondingCurveAccount({ ...base, data: badReserves })).toMatchObject({ quality: 'MALFORMED', reason: 'real_reserves_exceed_virtual' });
  });

  it('O: an account read whose context slot lags the reference slot is STALE', () => {
    expect(assessAccountFreshness(1000, 1004, 8)).toBe('VALID');
    expect(assessAccountFreshness(1000, 1100, 8)).toBe('STALE');
  });

  it('mint decimals of every real curve token are 6 (the constant the price formula uses)', () => {
    for (const a of FIX.accounts) expect(a.mintDecimals).toBe(6);
  });
});

describe('bonding-curve MATH', () => {
  const standard = { virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, realSolReserves: 0n, realTokenReserves: 793_100_000_000_000n };

  it('G/H: spot price = (virtual SOL / 1e9) / (virtual tokens / 10^6)', () => {
    // initial curve: 30 SOL / 1,073,000,000 whole tokens
    expect(spotPriceSol(30_000_000_000n, 1_073_000_000_000_000n)).toBeCloseTo(30 / 1_073_000_000, 18);
    expect(spotPriceSol(30_000_000_000n, 1_073_000_000_000_000n, 6)).toBeCloseTo(2.7958993e-8, 14);
    // decimals matter: the same reserves with 9 decimals would be a different price
    expect(spotPriceSol(30_000_000_000n, 1_073_000_000_000_000n, 9)).toBeCloseTo(2.7958993e-5, 11); // fewer whole tokens => a 1000x higher per-token price
    expect(spotPriceSol(0n, 1n)).toBeNull();
    expect(spotPriceSol(1n, 0n)).toBeNull(); // never a division blow-up, never 0
  });

  it('G: on real events the spot price sits within the trade\'s own execution price band', () => {
    for (const n of [...REAL.sol_buy, ...REAL.sol_sell]) {
      const t = decodePumpfunNotification({ signature: n.signature, slot: n.slot, err: null, logs: n.logs, receivedAtMs: 1 }).trades[0]!;
      if (!t.curve || t.curve.mayhemMode) continue;
      const spot = spotPriceSol(t.curve.virtualSolReserves, t.curve.virtualTokenReserves)!;
      const exec = t.solAmountLamports / 1e9 / (Number(t.tokenAmount) / 1e6);
      expect(Math.abs(spot / exec - 1), n.signature).toBeLessThan(0.5); // same order; the exact bound is the trade's own impact
    }
  });

  it('I: liquiditySol is the REAL SOL reserve, not the virtual one', () => {
    expect(realSolLiquidity(21_996_158_260n)).toBeCloseTo(21.99615826, 9);
    // a fresh curve has 30 SOL VIRTUAL but 0 SOL real: it must not look like 30 SOL of liquidity
    expect(realSolLiquidity(standard.realSolReserves)).toBe(0);
    expect(Number(standard.virtualSolReserves) / 1e9).toBe(30);
  });

  it('K: the 0.3 SOL entry is priced net of the protocol + creator fee, then run through the exact curve', () => {
    const net = entryNetLamports(300_000_000n, 95, 30);
    expect(net).toBe(296_296_296n); // 0.3 SOL / 1.0125
    const impact = buyPriceImpactPct(standard, net)!;
    expect(impact).toBeGreaterThan(0.98);
    expect(impact).toBeLessThan(0.99); // 0.2963 / 30 = 0.9877 %: under the unchanged 1 % limit, on the thinnest possible curve
  });

  it('J: the exact impact equals net / virtual SOL (constant product) -- and is NOT net / real liquidity', () => {
    for (const vs of [30_000_000_000n, 42_000_000_000n, 60_000_000_000n, 115_000_000_000n]) {
      const state = { virtualSolReserves: vs, virtualTokenReserves: 1_073_000_000_000_000n * 30_000_000_000n / vs, realSolReserves: vs - 30_000_000_000n, realTokenReserves: 700_000_000_000_000n };
      const net = 296_296_296n;
      const impact = buyPriceImpactPct(state, net)!;
      const identity = (Number(net) / Number(vs)) * 100;
      expect(Math.abs(impact - identity), String(vs)).toBeLessThan(1e-6);
      if (state.realSolReserves > 0n) {
        const naive = (Number(net) / Number(state.realSolReserves)) * 100;
        expect(Math.abs(impact - naive)).toBeGreaterThan(0.05); // the "0.3 / liquidity" shortcut is wrong by orders of magnitude
      }
    }
  });

  it('J: matches what the chain actually did: tokens out for a real buy differ from the formula by ~1 lamport of dust only', () => {
    // real captured buy (busiest mint of the live sample): pre-state = previous post-state, 977,777,777 lamports in
    const pre = { vs: 48_597_853_874n, vt: 662_374_932_694_272n };
    const predicted = tokensOutForNetSol(pre.vs, pre.vt, 977_777_777n);
    const actual = 13_063_988_650_505n;
    const dust = predicted - actual;
    expect(dust).toBeGreaterThanOrEqual(0n);
    expect(Number(dust) / Number(actual)).toBeLessThan(1e-8);
  });

  it('L: a buy that would exceed the tokens left on the curve cannot be priced (null), never a made-up number', () => {
    const nearlyDone = { virtualSolReserves: 115_000_000_000n, virtualTokenReserves: 280_000_000_000_000n, realSolReserves: 85_000_000_000n, realTokenReserves: 1_000_000n };
    expect(buyPriceImpactPct(nearlyDone, 296_296_296n)).toBeNull();
    expect(buyPriceImpactPct({ ...standard, virtualSolReserves: 0n }, 1n)).toBeNull();
    expect(buyPriceImpactPct(standard, 0n)).toBeNull();
  });

  it('a constant-product chain generated by the exact formulas passes every integrity check', () => {
    const sim = new CurveSim();
    let prev: CurveState | null = null;
    for (const step of [sim.buy(100_000_000n), sim.buy(977_777_777n), sim.sell(4_000_000_000_000n), sim.buy(50_000_000n)]) {
      const post: CurveState = { virtualSolReserves: step.curve.virtualSol, virtualTokenReserves: step.curve.virtualToken, realSolReserves: step.curve.realSol, realTokenReserves: step.curve.realToken, feeBasisPoints: 95, creatorFeeBasisPoints: 30, mayhemMode: false };
      expect(isConstantProductStep(post, step.isBuy, step.solLamports, step.tokenAmount)).toBe(true);
      if (prev) expect(chainLinks(prev, post, step.isBuy, step.solLamports, step.tokenAmount)).toBe(true);
      prev = post;
    }
  });

  it('a mayhem-style step (virtual SOL moving ~100x the real SOL) is NOT a valid constant-product step', () => {
    // real captured mayhem pair: sell of 68,899,458 lamports moved virtual SOL by ~12.8 SOL
    const post: CurveState = { virtualSolReserves: 50_345_213_737n, virtualTokenReserves: 1_053_639_475_127_948n, realSolReserves: 517_175_088n, realTokenReserves: 773_739_475_127_948n, feeBasisPoints: 0, creatorFeeBasisPoints: 0, mayhemMode: true };
    expect(isConstantProductStep(post, true, 133_086_645, 3_737_255_004_156n)).toBe(false);
  });

  it('preTradeState inverts a trade exactly', () => {
    const post: CurveState = { virtualSolReserves: 100n, virtualTokenReserves: 1_000n, realSolReserves: 70n, realTokenReserves: 900n, feeBasisPoints: 0, creatorFeeBasisPoints: 0, mayhemMode: false };
    expect(preTradeState(post, true, 10, 50n)).toEqual({ virtualSol: 90n, virtualToken: 1_050n, realSol: 60n, realToken: 950n });
    expect(preTradeState(post, false, 10, 50n)).toEqual({ virtualSol: 110n, virtualToken: 950n, realSol: 80n, realToken: 850n });
  });
});
