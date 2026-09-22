import { PublicKey } from '@solana/web3.js';
import { PUMPFUN_PROGRAM_ID } from './pumpfunTradeEventDecoder.js';
import type { CurveState } from './types.js';

/**
 * Pump.fun BondingCurve account decoder (PURE). Layout from pump.fun's on-chain
 * Anchor IDL, confirmed on 8 real mainnet accounts (151 bytes each; the IDL
 * struct is 125 bytes, the account carries reserved padding):
 *
 *   0   discriminator      [23,183,248,55,96,216,172,96]
 *   8   virtual_token_reserves  u64
 *   16  virtual_quote_reserves  u64   (virtual SOL for a native-SOL curve)
 *   24  real_token_reserves     u64
 *   32  real_quote_reserves     u64   (real SOL; == account lamports - rent, exactly)
 *   40  token_total_supply      u64
 *   48  complete                bool  (true = graduated; reserves are zeroed on migration)
 *   49  creator                 pubkey
 *   81  is_mayhem_mode          bool
 *   82  is_cashback_coin        bool
 *   83  quote_mint              pubkey
 *   115 creator_fee_bps         u64
 *   123 can_edit_creator_fee    bool
 *   124 is_holder_reward        bool
 *
 * PDA: seeds ["bonding-curve", mint] under the Pump.fun program.
 *
 * In production the curve state comes from the TradeEvents already on the
 * shared log stream (no account read at all). This decoder exists to VERIFY
 * that state against the chain (tests, live validation) and to classify any
 * account that is ever read, without trusting it blindly.
 */

export const BONDING_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]);
/** The legacy core (discriminator + 5 u64 + complete + creator). Anything shorter is malformed. */
export const BONDING_CURVE_MIN_LENGTH = 8 + 5 * 8 + 1 + 32;

export type DataQuality = 'VALID' | 'UNAVAILABLE' | 'STALE' | 'MALFORMED' | 'GRADUATED' | 'WRONG_PROGRAM' | 'TIMESTAMP_SKEW';

export interface BondingCurveAccountState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean | null;
  quoteMint: string | null;
  creatorFeeBps: number | null;
}

export interface AccountLike {
  owner: string;
  data: Uint8Array;
  lamports?: number;
}

export interface DecodedBondingCurveAccount {
  quality: DataQuality;
  reason: string | null;
  state: BondingCurveAccountState | null;
}

export function deriveBondingCurvePda(mint: string, program: string = PUMPFUN_PROGRAM_ID): string {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], new PublicKey(program));
  return pda.toBase58();
}

export function decodeBondingCurveAccount(account: AccountLike | null | undefined, program: string = PUMPFUN_PROGRAM_ID): DecodedBondingCurveAccount {
  if (!account) return { quality: 'UNAVAILABLE', reason: 'account_missing', state: null };
  if (account.owner !== program) return { quality: 'WRONG_PROGRAM', reason: 'owner_is_not_the_pumpfun_program', state: null };
  const data = Buffer.from(account.data);
  if (data.length < BONDING_CURVE_MIN_LENGTH) return { quality: 'MALFORMED', reason: 'account_too_short', state: null };
  if (!data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return { quality: 'MALFORMED', reason: 'discriminator_mismatch', state: null };

  const completeByte = data.readUInt8(48);
  if (completeByte > 1) return { quality: 'MALFORMED', reason: 'complete_flag_not_boolean', state: null };
  const mayhemByte = data.length > 81 ? data.readUInt8(81) : null;
  const state: BondingCurveAccountState = {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: completeByte === 1,
    creator: new PublicKey(data.subarray(49, 81)).toBase58(),
    isMayhemMode: mayhemByte === null || mayhemByte > 1 ? null : mayhemByte === 1,
    quoteMint: data.length >= 115 ? new PublicKey(data.subarray(83, 115)).toBase58() : null,
    creatorFeeBps: data.length >= 123 ? Number(data.readBigUInt64LE(115)) : null,
  };
  if (state.complete) return { quality: 'GRADUATED', reason: 'bonding_curve_complete', state };
  if (state.realSolReserves > state.virtualSolReserves || state.realTokenReserves > state.virtualTokenReserves) {
    return { quality: 'MALFORMED', reason: 'real_reserves_exceed_virtual', state: null };
  }
  return { quality: 'VALID', reason: null, state };
}

/** An account read is STALE if its context slot is too far behind the slot the caller is reasoning about. */
export function assessAccountFreshness(contextSlot: number, referenceSlot: number, maxSlotLag: number): 'VALID' | 'STALE' {
  return referenceSlot - contextSlot > maxSlotLag ? 'STALE' : 'VALID';
}

/** Does an account snapshot equal the state carried by a TradeEvent (all four reserves)? */
export function accountMatchesCurve(account: BondingCurveAccountState, curve: Pick<CurveState, 'virtualSolReserves' | 'virtualTokenReserves' | 'realSolReserves' | 'realTokenReserves'>): boolean {
  return (
    account.virtualSolReserves === curve.virtualSolReserves &&
    account.virtualTokenReserves === curve.virtualTokenReserves &&
    account.realSolReserves === curve.realSolReserves &&
    account.realTokenReserves === curve.realTokenReserves
  );
}
