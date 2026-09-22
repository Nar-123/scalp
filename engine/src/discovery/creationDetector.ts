import bs58 from 'bs58';
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from '@solana/web3.js';

/**
 * Instruction-level, evidence-based creation detection -- deliberately NOT
 * a log-string search. Verified live during Phase 1.1 against real mainnet
 * transactions (see docs/PHASE_1_1_DISCOVERY_VALIDATION.md) that:
 *
 *  - The genuine creation instruction can appear NESTED inside a top-level
 *    instruction from a completely different (bundler/launchpad) program,
 *    not just as pump.fun's/Raydium's own top-level instruction. Any
 *    detector that only looks at `message.instructions` (top-level) misses
 *    these. This module checks inner instructions too.
 *  - Anchor's 8-byte instruction discriminator (the first 8 bytes of the
 *    instruction's raw data) is exact and binary -- unlike a log line, it
 *    cannot be confused with a similarly-named-but-different instruction
 *    ("Instruction: CreateTokenAccountWithSeed" vs "Instruction: Create").
 *    pump.fun's discriminators here are read directly from its own
 *    on-chain Anchor IDL account (fetched and decoded during this pass),
 *    not guessed.
 *  - Structural/account evidence corroborates the discriminator: pump.fun's
 *    `create`/`create_v2` instructions both declare their first account as
 *    the new mint, and it is *always* both a signer and writable (a fresh
 *    keypair signing to become the new token) -- this can be cross-checked
 *    against the transaction's overall signer set regardless of whether
 *    the instruction is top-level or nested.
 */

export interface ProgramInstructionOccurrence {
  programId: string;
  accounts: string[];
  data: Uint8Array;
  topLevel: boolean;
}

function isPartiallyDecoded(ix: unknown): ix is PartiallyDecodedInstruction & { programId: { toBase58(): string } } {
  return typeof ix === 'object' && ix !== null && 'data' in ix && 'programId' in ix && 'accounts' in ix;
}

/**
 * Every instruction (top-level AND inner/CPI) in this transaction whose
 * program is `programId`, with its raw (still base58-encoded by the RPC)
 * data decoded to bytes. Non-Anchor-parsed instructions only -- pump.fun
 * and Raydium are both unrecognized by web3.js's built-in instruction
 * parsers, so they always arrive as PartiallyDecodedInstruction (raw data),
 * never pre-parsed.
 */
export function findProgramInstructions(tx: ParsedTransactionWithMeta, programId: string): ProgramInstructionOccurrence[] {
  const occurrences: ProgramInstructionOccurrence[] = [];

  for (const ix of tx.transaction?.message?.instructions ?? []) {
    if (isPartiallyDecoded(ix) && ix.programId.toBase58() === programId) {
      occurrences.push({
        programId,
        accounts: ix.accounts.map((a) => a.toBase58()),
        data: bs58.decode(ix.data),
        topLevel: true,
      });
    }
  }

  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (isPartiallyDecoded(ix) && ix.programId.toBase58() === programId) {
        occurrences.push({
          programId,
          accounts: ix.accounts.map((a) => a.toBase58()),
          data: bs58.decode(ix.data),
          topLevel: false,
        });
      }
    }
  }

  return occurrences;
}

/** Every account pubkey in this transaction that signed it (works uniformly for legacy and v0/ALT transactions via the parsed jsonParsed accountKeys list). */
export function getSignerAccountSet(tx: ParsedTransactionWithMeta): Set<string> {
  const signers = new Set<string>();
  for (const key of tx.transaction?.message?.accountKeys ?? []) {
    if (key.signer) signers.add(key.pubkey.toBase58());
  }
  return signers;
}

/** Every account pubkey in this transaction flagged writable at the message level. */
export function getWritableAccountSet(tx: ParsedTransactionWithMeta): Set<string> {
  const writable = new Set<string>();
  for (const key of tx.transaction?.message?.accountKeys ?? []) {
    if (key.writable) writable.add(key.pubkey.toBase58());
  }
  return writable;
}

function startsWithBytes(data: Uint8Array, prefix: number[]): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

// Read directly from pump.fun's on-chain Anchor IDL account during this
// pass (not guessed) -- see docs/PHASE_1_1_DISCOVERY_VALIDATION.md.
export const PUMPFUN_CREATE_DISCRIMINATOR = [24, 30, 200, 40, 5, 28, 7, 119];
export const PUMPFUN_CREATE_V2_DISCRIMINATOR = [214, 144, 76, 236, 95, 139, 49, 180];

export interface CreationDetectionResult {
  detected: boolean;
  evidence: string[];
  mint?: string;
  /** The pool/AMM account, when the detector can identify one (Raydium only). */
  pool?: string;
}

/**
 * Genuine pump.fun token creation: an Anchor `create` or `create_v2`
 * instruction dispatched to the pump.fun program (top-level or nested),
 * AND its first account (the new mint, per pump.fun's own IDL) is a real
 * signer of this transaction -- the fresh-keypair-signs-to-become-a-mint
 * pattern that a log line alone cannot prove.
 */
export function detectPumpFunCreation(tx: ParsedTransactionWithMeta, programId: string): CreationDetectionResult {
  const occurrences = findProgramInstructions(tx, programId);
  const signers = getSignerAccountSet(tx);

  for (const occ of occurrences) {
    const isCreate = startsWithBytes(occ.data, PUMPFUN_CREATE_DISCRIMINATOR);
    const isCreateV2 = startsWithBytes(occ.data, PUMPFUN_CREATE_V2_DISCRIMINATOR);
    if (!isCreate && !isCreateV2) continue;

    const mintAccount = occ.accounts[0];
    if (mintAccount && signers.has(mintAccount)) {
      return {
        detected: true,
        mint: mintAccount,
        evidence: [
          isCreateV2 ? 'pumpfun_create_v2_discriminator_match' : 'pumpfun_create_discriminator_match',
          occ.topLevel ? 'top_level_instruction' : 'nested_cpi_instruction',
          'mint_account_is_transaction_signer',
        ],
      };
    }
  }

  return { detected: false, evidence: [] };
}

interface ParsedSplTokenInstructionLike {
  program: string;
  parsed?: { type?: string; info?: { mint?: string } };
}

function isParsedSplTokenInstruction(ix: unknown): ix is ParsedSplTokenInstructionLike {
  return typeof ix === 'object' && ix !== null && 'program' in ix && (ix as { program: unknown }).program === 'spl-token';
}

/**
 * Mint accounts genuinely initialized (spl-token/-2022 InitializeMint(2))
 * somewhere in this transaction's full instruction tree, that did NOT
 * already exist beforehand (absent from preTokenBalances). This is
 * program-agnostic: it works as corroborating evidence regardless of which
 * program orchestrated the creation, and regardless of nesting depth.
 */
export function findFreshMintInitializations(tx: ParsedTransactionWithMeta): string[] {
  const preMints = new Set((tx.meta?.preTokenBalances ?? []).map((b) => b.mint));
  const fresh = new Set<string>();

  const allInstructions = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];

  for (const ix of allInstructions) {
    if (!isParsedSplTokenInstruction(ix)) continue;
    if (ix.parsed?.type !== 'initializeMint' && ix.parsed?.type !== 'initializeMint2') continue;
    const mint = ix.parsed.info?.mint;
    if (mint && !preMints.has(mint)) fresh.add(mint);
  }

  return [...fresh];
}

// ===========================================================================
// Raydium AMM V4 -- SUPPORTED. Every other Raydium program (CPMM, CLMM,
// Stable-swap, or any future Raydium deployment) is explicitly NOT
// supported: it has a different program ID, a different instruction
// encoding, and this detector never attempts to decode it (see the
// programId guard in detectRaydiumAmmV4PoolCreation below and
// docs/PHASE_1_1_1_RAYDIUM_HARDENING.md for the full supported/unsupported
// list).
// ===========================================================================

/** The only Raydium program this detector understands. Matches `discovery.raydiumProgramId`'s default in config/schema.ts. */
export const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

// Publicly documented as Raydium AMM V4's "Initialize2" instruction tag
// across the ecosystem's tooling and the (historical) open-source
// raydium-io/raydium-amm repo. Raydium is a native, non-Anchor program with
// no on-chain IDL to confirm this against, and Phase 1.1's live scan (see
// docs/PHASE_1_1_DISCOVERY_VALIDATION.md) found a DIFFERENT instruction tag
// (16) dominating current mainnet traffic that doesn't match this
// engineer's recollection of the historical enum -- meaning that enum may
// be stale for the currently deployed program build, and no real
// initialize2 transaction has been captured and ACCEPTED by this detector
// live (see docs/PHASE_1_1_1_RAYDIUM_HARDENING.md for what was attempted).
export const RAYDIUM_AMM_V4_INITIALIZE2_TAG = 1;

/**
 * Canonical `initialize2` account order, per the historically well-known,
 * widely-replicated (every major Solana trading SDK/bot decodes it this
 * way) open-source raydium-io/raydium-amm instruction layout. Like the tag
 * above, this has NOT been confirmed against a live-captured `initialize2`
 * transaction in this project -- if the currently deployed program build
 * has reordered or added accounts, a real creation could still fail these
 * checks even though the tag and fresh-mint evidence would otherwise
 * support it. That's an accepted, documented trade-off: recall for
 * precision (see task 5 -- fail closed on any inconsistency).
 */
const RAYDIUM_AMM_V4_INITIALIZE2_ACCOUNTS = {
  TOKEN_PROGRAM: 0,
  ASSOCIATED_TOKEN_PROGRAM: 1,
  SYSTEM_PROGRAM: 2,
  RENT_SYSVAR: 3,
  AMM_POOL: 4,
  AMM_AUTHORITY: 5,
  AMM_OPEN_ORDERS: 6,
  LP_MINT: 7,
  COIN_MINT: 8,
  PC_MINT: 9,
  COIN_VAULT: 10,
  PC_VAULT: 11,
  WITHDRAW_QUEUE: 12,
  AMM_TARGET_ORDERS: 13,
  LP_VAULT: 14,
  MARKET_PROGRAM: 15,
  MARKET: 16,
  USER_WALLET: 17,
  USER_TOKEN_COIN: 18,
  USER_TOKEN_PC: 19,
  USER_TOKEN_LP: 20,
} as const;

const RAYDIUM_AMM_V4_MIN_ACCOUNTS = 21;

/**
 * Structural validation of the initialize2 account layout -- task 3/5:
 * every field the spec named (pool, LP mint, coin mint, PC mint, vaults,
 * market, user wallet) is checked, and any incompleteness or inconsistency
 * fails closed (returns null, never a partial/best-guess match).
 *
 * Hard requirements (all must hold):
 *  - at least RAYDIUM_AMM_V4_MIN_ACCOUNTS accounts (rejects a
 *    truncated/malformed instruction outright)
 *  - pool, LP mint, coin mint, PC mint, both vaults, market, and user
 *    wallet are all present and pairwise distinct (catches a corrupted or
 *    degenerate account list -- e.g. the same key repeated where six
 *    different accounts are expected)
 *  - the LP mint is a genuinely freshly-initialized mint (Raydium always
 *    creates a brand-new LP mint on pool init; this is not
 *    scenario-dependent the way the underlying coin mint's freshness is)
 *  - the user wallet is a real signer of the transaction
 *
 * Soft/informational (recorded in evidence, never gates detection):
 *  - whether the coin mint is itself fresh (a from-scratch token+pool
 *    launch bundled in one transaction is legitimate and not rare, so this
 *    is not required either way)
 *  - whether the AMM pool account is flagged writable at the message level
 *    (expected, since pool init modifies it, but not made a hard gate --
 *    this project has not independently re-verified that per-instruction
 *    account metadata always round-trips through getParsedTransaction
 *    exactly as expected for a partially-decoded native-program instruction)
 */
function validateRaydiumInitialize2Layout(
  occ: ProgramInstructionOccurrence,
  freshMints: Set<string>,
  signers: Set<string>,
  writableAccounts: Set<string>,
): { valid: boolean; lpMint?: string; pool?: string; evidence: string[] } {
  const A = RAYDIUM_AMM_V4_INITIALIZE2_ACCOUNTS;
  const evidence: string[] = [];

  if (occ.accounts.length < RAYDIUM_AMM_V4_MIN_ACCOUNTS) {
    return { valid: false, evidence: ['incomplete_account_list'] };
  }

  const pool = occ.accounts[A.AMM_POOL];
  const lpMint = occ.accounts[A.LP_MINT];
  const coinMint = occ.accounts[A.COIN_MINT];
  const pcMint = occ.accounts[A.PC_MINT];
  const coinVault = occ.accounts[A.COIN_VAULT];
  const pcVault = occ.accounts[A.PC_VAULT];
  const market = occ.accounts[A.MARKET];
  const userWallet = occ.accounts[A.USER_WALLET];

  const required = { pool, lpMint, coinMint, pcMint, coinVault, pcVault, market, userWallet };
  for (const [name, value] of Object.entries(required)) {
    if (!value) return { valid: false, evidence: [`missing_${name}_account`] };
  }

  const distinctCheckSet = new Set([pool, lpMint, coinMint, pcMint, coinVault, pcVault, market, userWallet]);
  if (distinctCheckSet.size !== 8) {
    return { valid: false, evidence: ['account_list_not_pairwise_distinct'] };
  }

  if (!freshMints.has(lpMint as string)) {
    return { valid: false, evidence: ['lp_mint_not_freshly_initialized'] };
  }
  evidence.push('lp_mint_freshly_initialized_at_canonical_position');

  if (!signers.has(userWallet as string)) {
    return { valid: false, evidence: ['user_wallet_not_a_transaction_signer'] };
  }
  evidence.push('user_wallet_is_transaction_signer');

  evidence.push(freshMints.has(coinMint as string) ? 'coin_mint_also_freshly_initialized' : 'coin_mint_pre_existing');
  evidence.push(writableAccounts.has(pool as string) ? 'amm_pool_account_writable' : 'amm_pool_account_writable_flag_not_confirmed');

  return { valid: true, lpMint: lpMint as string, pool: pool as string, evidence };
}

/**
 * Genuine Raydium AMM V4 pool creation. Requires ALL of: (1) `programId`
 * is exactly the AMM V4 program (never applied to any other Raydium
 * program -- task 1/2); (2) a matching instruction (top-level or nested)
 * whose first data byte is the initialize2 tag; (3) the full structural
 * account-layout validation above, including the fresh-LP-mint and
 * signer-user-wallet checks. Any failure at any stage fails closed --
 * this function never returns a partial or best-effort positive.
 */
export function detectRaydiumAmmV4PoolCreation(tx: ParsedTransactionWithMeta, programId: string): CreationDetectionResult {
  if (programId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
    return { detected: false, evidence: ['unsupported_raydium_program_id'] };
  }

  const occurrences = findProgramInstructions(tx, programId);
  const freshMints = new Set(findFreshMintInitializations(tx));
  const signers = getSignerAccountSet(tx);
  const writableAccounts = getWritableAccountSet(tx);

  for (const occ of occurrences) {
    if (occ.data.length === 0 || occ.data[0] !== RAYDIUM_AMM_V4_INITIALIZE2_TAG) continue;

    const layout = validateRaydiumInitialize2Layout(occ, freshMints, signers, writableAccounts);
    if (!layout.valid || !layout.lpMint) continue;

    return {
      detected: true,
      mint: layout.lpMint,
      pool: layout.pool,
      evidence: [
        'raydium_amm_v4_initialize2_tag_match_unconfirmed_live',
        occ.topLevel ? 'top_level_instruction' : 'nested_cpi_instruction',
        ...layout.evidence,
      ],
    };
  }

  return { detected: false, evidence: [] };
}
