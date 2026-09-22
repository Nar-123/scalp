/**
 * Read-only decoding of a Token-2022 (Token Extensions) mint account, plus the program ids the safety layer needs.
 *
 * Deliberately self-contained (no @solana/spl-token import): the layout is small and fixed, decoding it here keeps the
 * safety decision fully deterministic and unit-testable with hand-built buffers, and lets an extension the installed
 * library does not know about be reported as UNKNOWN (fail closed) instead of being silently skipped.
 *
 * Mint account layout (spl-token-2022):
 *   0..82    base mint: mint_authority COption<Pubkey> (u32 tag + 32), supply u64, decimals u8, is_initialized u8,
 *            freeze_authority COption<Pubkey> (u32 tag + 32)
 *   82..165  zero padding (only when extensions exist)
 *   165      AccountType (1 = Mint)
 *   166..    TLV entries: type u16 LE, length u16 LE, value[length]
 *
 * A mint with NO extension is exactly 82 bytes.
 */

export const TOKEN_PROGRAM_ID_BASE58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID_BASE58 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const BASE_MINT_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;
const ACCOUNT_TYPE_MINT = 1;

/** Extension ids as defined by the Token-2022 program. Names are for reporting only; policy lives in the check. */
export const EXTENSION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  13: 'NonTransferableAccount',
  14: 'TransferHook',
  15: 'TransferHookAccount',
  16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
  25: 'ScaledUiAmount',
  26: 'Pausable',
  27: 'PausableAccount',
  28: 'PermissionedBurn',
});

export interface Token2022Extension {
  id: number;
  /** Known name, or `unknown_<id>`. */
  name: string;
  /** Raw value bytes (length as declared by the TLV entry). */
  data: Uint8Array;
}

export interface ParsedToken2022Mint {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  extensions: Token2022Extension[];
}

export type Token2022ParseResult = { ok: true; mint: ParsedToken2022Mint } | { ok: false; error: string };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet) of 32 bytes: enough to report an authority address without importing web3.js here. */
export function toBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i] as number];
  return out;
}

export function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

function coption(view: DataView, data: Uint8Array, offset: number): string | null | 'invalid' {
  const tag = view.getUint32(offset, true);
  if (tag === 0) return null;
  if (tag !== 1) return 'invalid';
  return toBase58(data.subarray(offset + 4, offset + 36));
}

/**
 * Decodes a Token-2022 mint account. Any structural problem (short buffer, bad tag, uninitialized mint, wrong account
 * type, truncated or duplicated TLV entry) is an ERROR, never a partial result: the caller fails closed.
 */
export function parseToken2022Mint(data: Uint8Array): Token2022ParseResult {
  if (data.length < BASE_MINT_LEN) return { ok: false, error: 'account_too_short' };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const mintAuthority = coption(view, data, 0);
  if (mintAuthority === 'invalid') return { ok: false, error: 'invalid_mint_authority_option' };
  const supply = view.getBigUint64(36, true);
  const decimals = view.getUint8(44);
  if (view.getUint8(45) !== 1) return { ok: false, error: 'mint_not_initialized' };
  const freezeAuthority = coption(view, data, 46);
  if (freezeAuthority === 'invalid') return { ok: false, error: 'invalid_freeze_authority_option' };

  const extensions: Token2022Extension[] = [];
  if (data.length > BASE_MINT_LEN) {
    if (data.length < TLV_START) return { ok: false, error: 'invalid_extension_region' };
    if (view.getUint8(ACCOUNT_TYPE_OFFSET) !== ACCOUNT_TYPE_MINT) return { ok: false, error: 'account_type_not_mint' };
    const seen = new Set<number>();
    let o = TLV_START;
    while (o < data.length) {
      if (o + 4 > data.length) return { ok: false, error: 'truncated_extension_header' };
      const id = view.getUint16(o, true);
      const len = view.getUint16(o + 2, true);
      if (id === 0) break; // Uninitialized: end of the TLV region (remaining bytes are padding)
      if (o + 4 + len > data.length) return { ok: false, error: 'truncated_extension_value' };
      if (seen.has(id)) return { ok: false, error: 'duplicate_extension' };
      seen.add(id);
      extensions.push({ id, name: EXTENSION_NAMES[id] ?? `unknown_${id}`, data: data.subarray(o + 4, o + 4 + len) });
      o += 4 + len;
    }
  }
  return { ok: true, mint: { mintAuthority, freezeAuthority, supply, decimals, extensions } };
}
