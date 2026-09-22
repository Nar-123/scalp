import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  detectPumpFunCreation,
  detectRaydiumAmmV4PoolCreation,
  findFreshMintInitializations,
  findProgramInstructions,
  getSignerAccountSet,
  PUMPFUN_CREATE_V2_DISCRIMINATOR,
  RAYDIUM_AMM_V4_INITIALIZE2_TAG,
  RAYDIUM_AMM_V4_PROGRAM_ID,
} from '../../src/discovery/creationDetector.js';
import { hydrateParsedTransaction } from './fixtures/hydrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM = RAYDIUM_AMM_V4_PROGRAM_ID;

function loadFixture(name: string): ParsedTransactionWithMeta {
  const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
  return hydrateParsedTransaction(raw);
}

describe('detectPumpFunCreation -- real captured transactions', () => {
  it('ACCEPTS a genuine top-level CreateV2 (real tx 2SJ4Yr...)', () => {
    const tx = loadFixture('pumpfun_create_v2_top_level.json');
    const result = detectPumpFunCreation(tx, PUMPFUN);
    expect(result.detected).toBe(true);
    expect(result.mint).toBe('MAP8KCX3mbsCXUTrMhbbTr54urw5Cy48hbaxpPjpump');
    expect(result.evidence).toContain('pumpfun_create_v2_discriminator_match');
    expect(result.evidence).toContain('top_level_instruction');
    expect(result.evidence).toContain('mint_account_is_transaction_signer');
  });

  it('ACCEPTS a genuine CreateV2 nested inside a third-party bundler program (real tx 3FwawF...)', () => {
    const tx = loadFixture('pumpfun_create_v2_nested_bundler.json');
    const result = detectPumpFunCreation(tx, PUMPFUN);
    expect(result.detected).toBe(true);
    expect(result.mint).toBe('FdGPCx5arfwW32SqskjFh1Q7dyetTnRHoJBeZPFkpump');
    expect(result.evidence).toContain('nested_cpi_instruction');
  });

  it('REJECTS an ordinary Buy on an existing token routed through an aggregator (real tx pxJTGc..., the original false-positive)', () => {
    const tx = loadFixture('ordinary_swap_aggregator_buy.json');
    const result = detectPumpFunCreation(tx, PUMPFUN);
    expect(result.detected).toBe(false);
    expect(result.mint).toBeUndefined();
  });

  it('REJECTS a transaction that never mentions pump.fun at all (real tx: plain SOL transfer)', () => {
    const tx = loadFixture('unrelated_transfer.json');
    const result = detectPumpFunCreation(tx, PUMPFUN);
    expect(result.detected).toBe(false);
  });

  it('REJECTS safely (no throw) when the transaction is null-ish / has no innerInstructions', () => {
    const tx = loadFixture('unrelated_transfer.json');
    // Simulate a minimal/legacy response shape missing optional fields.
    const malformed = { ...tx, meta: { ...tx.meta, innerInstructions: undefined, preTokenBalances: undefined } } as unknown as ParsedTransactionWithMeta;
    expect(() => detectPumpFunCreation(malformed, PUMPFUN)).not.toThrow();
    expect(detectPumpFunCreation(malformed, PUMPFUN).detected).toBe(false);
  });

  it('REJECTS safely when message.instructions is empty and there is no meta at all', () => {
    const empty = {
      slot: 0,
      blockTime: null,
      transaction: { message: { accountKeys: [], instructions: [] } },
      meta: null,
    } as unknown as ParsedTransactionWithMeta;
    expect(() => detectPumpFunCreation(empty, PUMPFUN)).not.toThrow();
    expect(detectPumpFunCreation(empty, PUMPFUN).detected).toBe(false);
  });

  it('does NOT match on discriminator prefix collision alone -- requires the exact 8-byte discriminator', () => {
    const tx = loadFixture('pumpfun_create_v2_top_level.json');
    // Sanity: the real discriminator constant used by the detector matches
    // what's actually in the fixture's instruction data (bs58-decoded).
    const occ = findProgramInstructions(tx, PUMPFUN).find((o) => o.topLevel);
    expect(occ).toBeDefined();
    expect(Array.from(occ!.data.slice(0, 8))).toEqual(PUMPFUN_CREATE_V2_DISCRIMINATOR);
  });
});

describe('findProgramInstructions -- scans both top-level and inner instructions', () => {
  it('finds the nested CreateV2 call that a top-level-only scan would miss', () => {
    const tx = loadFixture('pumpfun_create_v2_nested_bundler.json');
    const occurrences = findProgramInstructions(tx, PUMPFUN);
    expect(occurrences.some((o) => !o.topLevel)).toBe(true);
  });

  it('returns nothing for a program that never appears in the transaction', () => {
    const tx = loadFixture('unrelated_transfer.json');
    expect(findProgramInstructions(tx, PUMPFUN)).toEqual([]);
    expect(findProgramInstructions(tx, RAYDIUM)).toEqual([]);
  });
});

describe('getSignerAccountSet', () => {
  it('includes the fresh mint keypair that signed the real creation transaction', () => {
    const tx = loadFixture('pumpfun_create_v2_top_level.json');
    const signers = getSignerAccountSet(tx);
    expect(signers.has('MAP8KCX3mbsCXUTrMhbbTr54urw5Cy48hbaxpPjpump')).toBe(true);
  });
});

describe('findFreshMintInitializations', () => {
  it('finds the newly initialized mint in the nested-bundler creation (via inner spl-token InitializeMint2)', () => {
    const tx = loadFixture('pumpfun_create_v2_nested_bundler.json');
    const fresh = findFreshMintInitializations(tx);
    expect(fresh).toContain('FdGPCx5arfwW32SqskjFh1Q7dyetTnRHoJBeZPFkpump');
  });

  it('finds nothing in an ordinary swap on a pre-existing mint', () => {
    const tx = loadFixture('ordinary_swap_aggregator_buy.json');
    expect(findFreshMintInitializations(tx)).toEqual([]);
  });

  it('returns an empty array (not a throw) when preTokenBalances/innerInstructions are absent', () => {
    const empty = {
      transaction: { message: { instructions: [] } },
      meta: {},
    } as unknown as ParsedTransactionWithMeta;
    expect(() => findFreshMintInitializations(empty)).not.toThrow();
    expect(findFreshMintInitializations(empty)).toEqual([]);
  });
});

// ===========================================================================
// detectRaydiumAmmV4PoolCreation -- Phase 1.1.1 hardening
//
// No genuine Raydium AMM V4 initialize2 transaction has ever been captured
// (see docs/PHASE_1_1_DISCOVERY_VALIDATION.md and
// docs/PHASE_1_1_1_RAYDIUM_HARDENING.md for the repeated live attempts), so
// the "valid" case here is a carefully constructed SYNTHETIC transaction
// matching the documented initialize2 account layout exactly -- clearly
// labeled as such, never claimed as a captured real transaction. The
// "ordinary swap" REJECT case, however, IS a real captured transaction: a
// genuine Raydium SwapBaseIn call nested inside the same real bundler
// transaction used elsewhere in this file for the pump.fun tests.
// ===========================================================================

const acct = (id: string) => ({ toBase58: () => id });

const RAY_ACCOUNTS = {
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ASSOCIATED_TOKEN_PROGRAM: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  SYSTEM_PROGRAM: '11111111111111111111111111111111',
  RENT_SYSVAR: 'SysvarRent111111111111111111111111111111',
  AMM_POOL: 'PoolAccount11111111111111111111111111111a',
  AMM_AUTHORITY: 'AmmAuthority1111111111111111111111111111a',
  AMM_OPEN_ORDERS: 'OpenOrders111111111111111111111111111111a',
  LP_MINT: 'LpMint1111111111111111111111111111111111a',
  COIN_MINT: 'CoinMint11111111111111111111111111111111a',
  PC_MINT: 'So11111111111111111111111111111111111111112',
  COIN_VAULT: 'CoinVault111111111111111111111111111111111a',
  PC_VAULT: 'PcVault111111111111111111111111111111111111a',
  WITHDRAW_QUEUE: 'WithdrawQueue11111111111111111111111111111a',
  AMM_TARGET_ORDERS: 'TargetOrders1111111111111111111111111111111a',
  LP_VAULT: 'LpVault1111111111111111111111111111111111a',
  MARKET_PROGRAM: 'MarketProgram111111111111111111111111111a',
  MARKET: 'Market111111111111111111111111111111111111a',
  USER_WALLET: 'UserWallet11111111111111111111111111111111a',
  USER_TOKEN_COIN: 'UserTokenCoin111111111111111111111111111a',
  USER_TOKEN_PC: 'UserTokenPc1111111111111111111111111111111a',
  USER_TOKEN_LP: 'UserTokenLp1111111111111111111111111111111a',
} as const;

const RAY_ACCOUNT_ORDER = [
  RAY_ACCOUNTS.TOKEN_PROGRAM,
  RAY_ACCOUNTS.ASSOCIATED_TOKEN_PROGRAM,
  RAY_ACCOUNTS.SYSTEM_PROGRAM,
  RAY_ACCOUNTS.RENT_SYSVAR,
  RAY_ACCOUNTS.AMM_POOL,
  RAY_ACCOUNTS.AMM_AUTHORITY,
  RAY_ACCOUNTS.AMM_OPEN_ORDERS,
  RAY_ACCOUNTS.LP_MINT,
  RAY_ACCOUNTS.COIN_MINT,
  RAY_ACCOUNTS.PC_MINT,
  RAY_ACCOUNTS.COIN_VAULT,
  RAY_ACCOUNTS.PC_VAULT,
  RAY_ACCOUNTS.WITHDRAW_QUEUE,
  RAY_ACCOUNTS.AMM_TARGET_ORDERS,
  RAY_ACCOUNTS.LP_VAULT,
  RAY_ACCOUNTS.MARKET_PROGRAM,
  RAY_ACCOUNTS.MARKET,
  RAY_ACCOUNTS.USER_WALLET,
  RAY_ACCOUNTS.USER_TOKEN_COIN,
  RAY_ACCOUNTS.USER_TOKEN_PC,
  RAY_ACCOUNTS.USER_TOKEN_LP,
];

interface SyntheticOptions {
  programId?: string;
  tag?: number;
  accountOrder?: string[];
  includeLpMintInitialization?: boolean;
  extraFreshMint?: string; // simulates a fresh mint that is NOT the LP mint
  topLevel?: boolean;
}

function buildSyntheticRaydiumTx(opts: SyntheticOptions = {}): ParsedTransactionWithMeta {
  const programId = opts.programId ?? RAYDIUM_AMM_V4_PROGRAM_ID;
  const tag = opts.tag ?? RAYDIUM_AMM_V4_INITIALIZE2_TAG;
  const accountOrder = opts.accountOrder ?? RAY_ACCOUNT_ORDER;
  const topLevel = opts.topLevel ?? true;

  const raydiumIx = {
    programId: acct(programId),
    accounts: accountOrder.map(acct),
    data: bs58.encode(Uint8Array.from([tag])),
  };

  const initializeMintIxs = [];
  if (opts.includeLpMintInitialization !== false) {
    initializeMintIxs.push({
      programId: acct(RAY_ACCOUNTS.TOKEN_PROGRAM),
      program: 'spl-token',
      parsed: { type: 'initializeMint2', info: { mint: RAY_ACCOUNTS.LP_MINT } },
    });
  }
  if (opts.extraFreshMint) {
    initializeMintIxs.push({
      programId: acct(RAY_ACCOUNTS.TOKEN_PROGRAM),
      program: 'spl-token',
      parsed: { type: 'initializeMint2', info: { mint: opts.extraFreshMint } },
    });
  }

  return {
    slot: 1,
    blockTime: 1_700_000_000,
    transaction: {
      message: {
        accountKeys: [
          { pubkey: acct(RAY_ACCOUNTS.USER_WALLET), signer: true, writable: true },
          { pubkey: acct(RAY_ACCOUNTS.AMM_POOL), signer: false, writable: true },
        ],
        instructions: topLevel ? [raydiumIx] : [],
      },
    },
    meta: {
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: topLevel ? [{ index: 0, instructions: initializeMintIxs }] : [{ index: 0, instructions: [raydiumIx, ...initializeMintIxs] }],
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('detectRaydiumAmmV4PoolCreation -- program ID scoping (tasks 1/2)', () => {
  it('REJECTS immediately when called with a program ID other than Raydium AMM V4, without inspecting the transaction', () => {
    const tx = buildSyntheticRaydiumTx({ programId: 'SomeOtherRaydiumProgram1111111111111111111' });
    const result = detectRaydiumAmmV4PoolCreation(tx, 'SomeOtherRaydiumProgram1111111111111111111');
    expect(result.detected).toBe(false);
    expect(result.evidence).toContain('unsupported_raydium_program_id');
  });

  it('REJECTS a well-formed initialize2-shaped transaction when the caller passes the wrong program ID constant (e.g. pump.fun\'s)', () => {
    const tx = buildSyntheticRaydiumTx();
    const result = detectRaydiumAmmV4PoolCreation(tx, PUMPFUN);
    expect(result.detected).toBe(false);
    expect(result.evidence).toContain('unsupported_raydium_program_id');
  });
});

describe('detectRaydiumAmmV4PoolCreation -- valid synthetic initialize2', () => {
  it('ACCEPTS a synthetic transaction matching the full documented account layout (top-level)', () => {
    const tx = buildSyntheticRaydiumTx();
    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(true);
    expect(result.mint).toBe(RAY_ACCOUNTS.LP_MINT);
    expect(result.pool).toBe(RAY_ACCOUNTS.AMM_POOL);
    expect(result.evidence).toContain('lp_mint_freshly_initialized_at_canonical_position');
    expect(result.evidence).toContain('user_wallet_is_transaction_signer');
    expect(result.evidence).toContain('coin_mint_pre_existing');
    expect(result.evidence).toContain('amm_pool_account_writable');
  });

  it('ACCEPTS when the same well-formed instruction is nested (CPI) rather than top-level', () => {
    const tx = buildSyntheticRaydiumTx({ topLevel: false });
    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(true);
    expect(result.evidence).toContain('nested_cpi_instruction');
  });

  it('records coin_mint_also_freshly_initialized when the underlying token is created in the same transaction', () => {
    const tx = buildSyntheticRaydiumTx({ extraFreshMint: RAY_ACCOUNTS.COIN_MINT });
    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(true);
    expect(result.evidence).toContain('coin_mint_also_freshly_initialized');
  });
});

describe('detectRaydiumAmmV4PoolCreation -- real captured ordinary swap (REJECT)', () => {
  it('REJECTS a real captured Raydium SwapBaseIn call (tag 9), nested inside a real bundler transaction', () => {
    const tx = loadFixture('pumpfun_create_v2_nested_bundler.json');
    // Sanity: this fixture really does contain a nested Raydium AMM V4 call.
    const occ = findProgramInstructions(tx, RAYDIUM);
    expect(occ.length).toBeGreaterThan(0);
    expect(occ[0]!.data[0]).toBe(9); // SwapBaseIn, not initialize2

    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(false);
  });

  it('REJECTS an unrelated transaction (real tx: plain SOL transfer)', () => {
    const tx = loadFixture('unrelated_transfer.json');
    expect(detectRaydiumAmmV4PoolCreation(tx, RAYDIUM).detected).toBe(false);
  });

  it('REJECTS a pump.fun creation transaction (no Raydium instruction present)', () => {
    const tx = loadFixture('pumpfun_create_v2_top_level.json');
    expect(detectRaydiumAmmV4PoolCreation(tx, RAYDIUM).detected).toBe(false);
  });
});

describe('detectRaydiumAmmV4PoolCreation -- wrong instruction tag', () => {
  it('REJECTS when the tag byte is not the initialize2 tag, even with an otherwise perfect layout', () => {
    const tx = buildSyntheticRaydiumTx({ tag: 9 });
    expect(detectRaydiumAmmV4PoolCreation(tx, RAYDIUM).detected).toBe(false);
  });
});

describe('detectRaydiumAmmV4PoolCreation -- missing mint initialization', () => {
  it('REJECTS when no fresh mint exists anywhere in the transaction', () => {
    const tx = buildSyntheticRaydiumTx({ includeLpMintInitialization: false });
    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(false);
  });
});

describe('detectRaydiumAmmV4PoolCreation -- mismatched mint account', () => {
  it('REJECTS when a fresh mint exists in the transaction but is NOT at the LP mint position', () => {
    // The LP mint itself is never initialized; some other, unrelated
    // account happens to be a fresh mint elsewhere in the same tx. The old
    // (pre-hardening) "anywhere in accounts" check would have accepted
    // this if that unrelated mint happened to appear among the
    // instruction's accounts; the hardened positional check must not.
    const tx = buildSyntheticRaydiumTx({ includeLpMintInitialization: false, extraFreshMint: RAY_ACCOUNTS.USER_TOKEN_LP });
    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(false);
    expect(result.mint).toBeUndefined();
  });
});

describe('detectRaydiumAmmV4PoolCreation -- malformed instruction (fails closed, task 5)', () => {
  it('REJECTS when the account list is truncated below the minimum required count', () => {
    const tx = buildSyntheticRaydiumTx({ accountOrder: RAY_ACCOUNT_ORDER.slice(0, 10) });
    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(false);
  });

  it('REJECTS when required accounts collapse into duplicates (inconsistent/corrupted account list)', () => {
    const collapsed = [...RAY_ACCOUNT_ORDER];
    collapsed[RAY_ACCOUNTS_INDEX('COIN_MINT')] = RAY_ACCOUNTS.PC_MINT; // coin_mint == pc_mint, should never happen
    const tx = buildSyntheticRaydiumTx({ accountOrder: collapsed });
    const result = detectRaydiumAmmV4PoolCreation(tx, RAYDIUM);
    expect(result.detected).toBe(false);
  });

  it('REJECTS safely (no throw) on an empty instruction data buffer', () => {
    const tx = buildSyntheticRaydiumTx();
    (tx as any).transaction.message.instructions[0].data = bs58.encode(new Uint8Array(0));
    expect(() => detectRaydiumAmmV4PoolCreation(tx, RAYDIUM)).not.toThrow();
    expect(detectRaydiumAmmV4PoolCreation(tx, RAYDIUM).detected).toBe(false);
  });

  it('REJECTS safely (no throw) on a completely empty/malformed transaction shape', () => {
    const malformed = { transaction: { message: { instructions: [] } }, meta: null } as unknown as ParsedTransactionWithMeta;
    expect(() => detectRaydiumAmmV4PoolCreation(malformed, RAYDIUM)).not.toThrow();
    expect(detectRaydiumAmmV4PoolCreation(malformed, RAYDIUM).detected).toBe(false);
  });
});

function RAY_ACCOUNTS_INDEX(name: keyof typeof RAY_ACCOUNTS): number {
  return RAY_ACCOUNT_ORDER.indexOf(RAY_ACCOUNTS[name]);
}
