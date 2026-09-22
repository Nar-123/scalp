import { PublicKey } from '@solana/web3.js';
import { PUMPFUN_PROGRAM_ID } from '../volume/pumpfunTradeEventDecoder.js';
import { decodeBondingCurveAccount } from '../volume/bondingCurveAccount.js';
import { TOKEN_2022_PROGRAM_ID_BASE58, TOKEN_PROGRAM_ID_BASE58 } from './token2022Mint.js';

/**
 * Verification of the Pump.fun bonding-curve VAULT (Phase 5.6E). PURE: it only interprets account bytes it is given.
 *
 * The vault is the curve's associated token account for the mint. It holds the tokens the curve has not sold yet, plus a fixed
 * reserve kept for the later liquidity migration. It is program-controlled inventory, not a holder. The holder policy may
 * exclude it ONLY when every check below passes; anything else is UNVERIFIED and the caller fails closed.
 *
 * The seven checks (each one measured on 118 real mainnet tokens in Phase 5.6D):
 *   V1  the curve PDA and the vault address equal a fresh derivation from the mint (seeds ["bonding-curve", mint] under the
 *       Pump program; ATA seeds [curve, token program, mint])
 *   V2  the curve PDA is off the ed25519 curve (no private key can exist for it)
 *   V3  the curve account is owned by the Pump program
 *   V4  the curve account decodes as a BondingCurve
 *   V5  the vault is a token account of the mint's own token program whose `mint` is this mint and whose `owner` is the curve PDA
 *   V6  vault balance = curve real token reserves + the migration reserve (live curve), or both are 0 (graduated curve)
 *   V7  mint supply <= the curve's recorded total supply (burns only lower supply)
 * plus: the curve's mayhem-mode flag must be readable and false (mayhem tokens have 2x supply and another reserve model).
 */

/** 206,900,000 tokens x 10^6: the part of the 1,000,000,000 supply Pump.fun reserves for post-graduation liquidity. Measured as
 *  the exact difference vault - real_token_reserves on all 99 live curves; if Pump.fun changes it, V6 fails and the gate fails closed. */
export const PUMPFUN_MIGRATION_RESERVE_RAW = 206_900_000_000_000n;

const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export type MintTokenProgram = 'spl-token' | 'token-2022';

export interface RawAccount {
  owner: string;
  data: Uint8Array;
  lamports: number;
}

/** What the data source read: the two accounts at the DERIVED addresses (either may be missing). */
export interface CurveEvidence {
  curveAddress: string;
  vaultAddress: string;
  curve: RawAccount | null;
  vault: RawAccount | null;
}

export function deriveCurveAndVault(mint: string, tokenProgram: MintTokenProgram): { curvePda: PublicKey; vaultAta: PublicKey } {
  const mintPk = new PublicKey(mint);
  const [curvePda] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintPk.toBuffer()], new PublicKey(PUMPFUN_PROGRAM_ID));
  const programPk = new PublicKey(tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID_BASE58 : TOKEN_PROGRAM_ID_BASE58);
  const [vaultAta] = PublicKey.findProgramAddressSync([curvePda.toBuffer(), programPk.toBuffer(), mintPk.toBuffer()], ATA_PROGRAM);
  return { curvePda, vaultAta };
}

export type VaultVerification =
  /** No curve account exists at the mint's curve PDA: not a Pump.fun curve token, there is no vault to exclude. */
  | { status: 'not_curve_token' }
  | { status: 'verified'; phase: 'live' | 'graduated'; vaultAddress: string; vaultBalance: bigint; creator: string }
  | { status: 'unverified'; failedChecks: string[] };

/** The vault could not be read at all (RPC failure): the caller treats it exactly like `unverified`. */
export type VaultOutcome = VaultVerification | { status: 'unavailable'; cause: string };

export function verifyBondingCurveVault(mint: string, mintInfo: { tokenProgram: MintTokenProgram; supply: bigint }, ev: CurveEvidence): VaultVerification {
  let derived: { curvePda: PublicKey; vaultAta: PublicKey };
  try {
    derived = deriveCurveAndVault(mint, mintInfo.tokenProgram);
  } catch {
    return { status: 'unverified', failedChecks: ['V1_derivation_failed'] };
  }
  const failed: string[] = [];
  if (ev.curveAddress !== derived.curvePda.toBase58() || ev.vaultAddress !== derived.vaultAta.toBase58()) failed.push('V1_addresses_do_not_match_derivation');
  if (failed.length > 0) return { status: 'unverified', failedChecks: failed };

  if (ev.curve === null) return { status: 'not_curve_token' };

  if (PublicKey.isOnCurve(derived.curvePda.toBytes())) failed.push('V2_pda_on_ed25519_curve');
  if (ev.curve.owner !== PUMPFUN_PROGRAM_ID) failed.push('V3_curve_not_owned_by_pump_program');
  const decoded = decodeBondingCurveAccount({ owner: ev.curve.owner, data: ev.curve.data, lamports: ev.curve.lamports });
  const state = decoded.state;
  if (state === null || (decoded.quality !== 'VALID' && decoded.quality !== 'GRADUATED')) failed.push('V4_curve_does_not_decode');

  // V5: the vault token account (SPL and Token-2022 accounts share the first 72 bytes: mint, owner, amount)
  const tokenProgramId = mintInfo.tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM_ID_BASE58 : TOKEN_PROGRAM_ID_BASE58;
  let vaultAmount: bigint | null = null;
  const v = ev.vault;
  if (v === null || v.owner !== tokenProgramId || v.data.length < 72) {
    failed.push('V5_vault_missing_or_wrong_program');
  } else {
    const buf = Buffer.from(v.data);
    const vMint = new PublicKey(buf.subarray(0, 32)).toBase58();
    const vOwner = new PublicKey(buf.subarray(32, 64)).toBase58();
    if (vMint !== mint || vOwner !== derived.curvePda.toBase58()) failed.push('V5_vault_mint_or_owner_mismatch');
    else vaultAmount = buf.readBigUInt64LE(64);
  }

  if (state !== null) {
    if (vaultAmount !== null) {
      const ok = state.complete ? vaultAmount === 0n && state.realTokenReserves === 0n : vaultAmount === state.realTokenReserves + PUMPFUN_MIGRATION_RESERVE_RAW;
      if (!ok) failed.push('V6_vault_balance_does_not_match_curve_reserves');
    }
    if (!(mintInfo.supply <= state.tokenTotalSupply)) failed.push('V7_mint_supply_above_curve_total_supply');
    if (state.isMayhemMode !== false) failed.push(state.isMayhemMode === true ? 'mayhem_mode_curve' : 'curve_mode_unproven');
  }

  if (failed.length > 0 || state === null || vaultAmount === null) return { status: 'unverified', failedChecks: failed.length > 0 ? failed : ['unknown'] };
  return { status: 'verified', phase: state.complete ? 'graduated' : 'live', vaultAddress: derived.vaultAta.toBase58(), vaultBalance: vaultAmount, creator: state.creator };
}
