import type { MintAccountSummary } from '../../types/token.js';
import { isAllZero } from '../token2022Mint.js';

/**
 * Token-2022 extension safety contract.
 *
 * Token-2022 support means "the gate can READ and EVALUATE the mint", never "accept Token-2022". The only property this
 * project needs from a token is: a holder can buy it and later SELL it at the quoted route without anyone else being able
 * to take, freeze, tax, block or hide it. Every extension is classified against exactly that:
 *
 *   ALLOW                  no effect on transferability, ownership, fees or visible balances
 *   REJECT                 always defeats a safety requirement
 *   REQUIRES_VERIFICATION  harmless only for a specific payload; the payload is decoded here and anything not provably
 *                          inert is rejected
 *   NOT_RELEVANT           account-level extension: it cannot exist on a mint, so seeing it there is malformed data
 *
 * Anything not listed (an id this code does not know) is UNSUPPORTED = fail closed. "Unknown" is never "safe".
 * Nothing here changes a threshold or the classic-SPL behavior: a classic mint has no `token2022` field and is skipped.
 */

export type ExtensionClass = 'ALLOW' | 'REJECT' | 'REQUIRES_VERIFICATION' | 'NOT_RELEVANT';

export interface ExtensionPolicy {
  id: number;
  name: string;
  class: ExtensionClass;
  /** Reason code added when the extension makes the mint unsafe (or unverifiable). */
  rejectReason?: string;
  why: string;
}

export const TOKEN_2022_UNSUPPORTED_EXTENSION = 'token2022_unsupported_extension';
export const TOKEN_2022_MALFORMED_EXTENSION = 'token2022_extension_data_malformed';

const policy = (p: ExtensionPolicy): ExtensionPolicy => p;

export const TOKEN_2022_EXTENSION_POLICY: readonly ExtensionPolicy[] = Object.freeze([
  policy({ id: 18, name: 'MetadataPointer', class: 'ALLOW', why: 'Only records where the metadata lives. No effect on transfers, balances or fees. Present on every Pump.fun Token-2022 mint sampled on mainnet.' }),
  policy({ id: 19, name: 'TokenMetadata', class: 'ALLOW', why: 'Name/symbol/uri stored in the mint. Cosmetic; cannot move, freeze or tax tokens.' }),
  policy({ id: 20, name: 'GroupPointer', class: 'ALLOW', why: 'Pointer to a group account (collection membership). No transfer semantics.' }),
  policy({ id: 21, name: 'TokenGroup', class: 'ALLOW', why: 'Group bookkeeping (size / max size). No transfer semantics.' }),
  policy({ id: 22, name: 'GroupMemberPointer', class: 'ALLOW', why: 'Pointer to a group-member account. No transfer semantics.' }),
  policy({ id: 23, name: 'TokenGroupMember', class: 'ALLOW', why: 'Group-member bookkeeping. No transfer semantics.' }),
  policy({ id: 3, name: 'MintCloseAuthority', class: 'REQUIRES_VERIFICATION', rejectReason: 'token2022_mint_close_authority_with_zero_supply', why: 'A mint can only be closed when its supply is 0, so with supply > 0 the authority cannot affect any holder. Zero supply is not tradable and is rejected.' }),
  policy({ id: 1, name: 'TransferFeeConfig', class: 'REQUIRES_VERIFICATION', rejectReason: 'token2022_transfer_fee_nonzero', why: 'A transfer fee is charged on every buy and sell. The execution simulation, position sizing and expected-net-edge are gross-amount based and do not model a token-side fee, so ANY non-zero fee (current or scheduled) is rejected rather than silently treated as zero. Both fee schedules must be exactly 0 bps.' }),
  policy({ id: 14, name: 'TransferHook', class: 'REQUIRES_VERIFICATION', rejectReason: 'token2022_transfer_hook', why: 'A hook program runs on every transfer and can block a sell. Accepted only when inert AND immutable: hook program unset and hook authority unset (an authority could install a hook at any time).' }),
  policy({ id: 12, name: 'PermanentDelegate', class: 'REQUIRES_VERIFICATION', rejectReason: 'token2022_permanent_delegate', why: 'A permanent delegate can transfer or burn any holder\'s tokens. Accepted only when no delegate is set (it cannot be set later).' }),
  policy({ id: 6, name: 'DefaultAccountState', class: 'REQUIRES_VERIFICATION', rejectReason: 'token2022_default_account_state_frozen', why: 'New token accounts start Frozen and cannot transfer until thawed. Accepted only when the default state is Initialized (changing it needs the freeze authority, which the existing check already requires to be renounced).' }),
  policy({ id: 9, name: 'NonTransferable', class: 'REJECT', rejectReason: 'token2022_non_transferable', why: 'The token cannot be transferred, so it cannot be sold.' }),
  policy({ id: 4, name: 'ConfidentialTransferMint', class: 'REJECT', rejectReason: 'token2022_confidential_transfer', why: 'Balances can be hidden, so getTokenLargestAccounts no longer shows real holder concentration.' }),
  policy({ id: 16, name: 'ConfidentialTransferFeeConfig', class: 'REJECT', rejectReason: 'token2022_confidential_transfer', why: 'Confidential fee machinery: hidden balances and fees.' }),
  policy({ id: 24, name: 'ConfidentialMintBurn', class: 'REJECT', rejectReason: 'token2022_confidential_transfer', why: 'Confidential supply changes: supply and balances not verifiable from public data.' }),
  policy({ id: 26, name: 'Pausable', class: 'REJECT', rejectReason: 'token2022_pausable', why: 'A pause authority can halt all transfers, blocking any sell.' }),
  policy({ id: 28, name: 'PermissionedBurn', class: 'REQUIRES_VERIFICATION', rejectReason: TOKEN_2022_UNSUPPORTED_EXTENSION, why: 'Burn semantics not evaluated by this gate (not observed on any sampled mint): unverified => rejected.' }),
  policy({ id: 10, name: 'InterestBearingConfig', class: 'REQUIRES_VERIFICATION', rejectReason: TOKEN_2022_UNSUPPORTED_EXTENSION, why: 'Changes the displayed (UI) amount only, but price/volume pipelines that read UI amounts are not verified against it: unverified => rejected.' }),
  policy({ id: 25, name: 'ScaledUiAmount', class: 'REQUIRES_VERIFICATION', rejectReason: TOKEN_2022_UNSUPPORTED_EXTENSION, why: 'Scales the displayed amount; same unverified pipeline effect as InterestBearingConfig: rejected.' }),
  ...[2, 5, 7, 8, 11, 13, 15, 17, 27].map((id) => policy({ id, name: `account_level_${id}`, class: 'NOT_RELEVANT', rejectReason: TOKEN_2022_MALFORMED_EXTENSION, why: 'Account-level extension type: it cannot legitimately appear on a mint. Seeing it means the data is not what it claims to be: rejected.' })),
]);

const BY_ID = new Map(TOKEN_2022_EXTENSION_POLICY.map((p) => [p.id, p]));

export interface Token2022CheckResult {
  passed: boolean;
  /** Deduplicated reason codes, empty when passed. */
  reasons: string[];
  /** Extension names present on the mint (for reporting; never used for a decision). */
  extensions: string[];
}

const U16 = (d: Uint8Array, o: number): number => (d[o] as number) | ((d[o + 1] as number) << 8);

/** Decoded verdict for one extension. Returns a reason code when the payload is unsafe/unverifiable, null when inert. */
function evaluatePayload(id: number, data: Uint8Array, supply: bigint): string | null {
  switch (id) {
    case 1: {
      // TransferFeeConfig: authority(32) withdrawAuthority(32) withheld u64 | older{epoch u64, max u64, bps u16} | newer{...} = 108
      if (data.length !== 108) return TOKEN_2022_MALFORMED_EXTENSION;
      const olderBps = U16(data, 32 + 32 + 8 + 16);
      const newerBps = U16(data, 32 + 32 + 8 + 18 + 16);
      return olderBps === 0 && newerBps === 0 ? null : 'token2022_transfer_fee_nonzero';
    }
    case 14: {
      if (data.length !== 64) return TOKEN_2022_MALFORMED_EXTENSION;
      return isAllZero(data.subarray(0, 32)) && isAllZero(data.subarray(32, 64)) ? null : 'token2022_transfer_hook';
    }
    case 12: {
      if (data.length !== 32) return TOKEN_2022_MALFORMED_EXTENSION;
      return isAllZero(data) ? null : 'token2022_permanent_delegate';
    }
    case 6: {
      if (data.length !== 1) return TOKEN_2022_MALFORMED_EXTENSION;
      if (data[0] === 1) return null; // Initialized
      if (data[0] === 2) return 'token2022_default_account_state_frozen';
      return TOKEN_2022_MALFORMED_EXTENSION; // 0 = Uninitialized is not a valid default state
    }
    case 3: {
      if (data.length !== 32) return TOKEN_2022_MALFORMED_EXTENSION;
      return supply > 0n ? null : 'token2022_mint_close_authority_with_zero_supply';
    }
    case 18:
    case 20:
    case 22:
      // pointers are two optional pubkeys (authority + address) = 64 bytes; a different length is not what it claims to be
      return data.length === 64 ? null : TOKEN_2022_MALFORMED_EXTENSION;
    default:
      return null;
  }
}

/**
 * Evaluates a mint summary against the Token-2022 contract. A classic SPL mint (no `token2022` field) passes untouched.
 * A Token-2022 mint passes only when EVERY extension present is understood and safe.
 */
export function evaluateToken2022Extensions(summary: MintAccountSummary | null): Token2022CheckResult {
  if (!summary || summary.tokenProgram !== 'token-2022') return { passed: true, reasons: [], extensions: [] };
  const info = summary.token2022;
  // Token-2022 mint without decoded extension data: nothing was verified => fail closed (never "no extensions")
  if (!info) return { passed: false, reasons: [TOKEN_2022_MALFORMED_EXTENSION], extensions: [] };

  const reasons = new Set<string>();
  const names: string[] = [];
  for (const ext of info.extensions) {
    names.push(ext.name);
    const p = BY_ID.get(ext.id);
    if (!p) {
      reasons.add(TOKEN_2022_UNSUPPORTED_EXTENSION); // unknown id: never treated as safe
      continue;
    }
    if (p.class === 'ALLOW') {
      const bad = evaluatePayload(ext.id, ext.data, summary.supply);
      if (bad) reasons.add(bad);
      continue;
    }
    if (p.class === 'REJECT' || p.class === 'NOT_RELEVANT') {
      reasons.add(p.rejectReason as string);
      continue;
    }
    // REQUIRES_VERIFICATION: decoded payload decides; no decoder => unverified => the policy's reject reason
    const decoded = [1, 14, 12, 6, 3].includes(ext.id) ? evaluatePayload(ext.id, ext.data, summary.supply) : (p.rejectReason as string);
    if (decoded) reasons.add(decoded);
  }
  return { passed: reasons.size === 0, reasons: [...reasons], extensions: names };
}
