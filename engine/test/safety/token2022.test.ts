import { PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MintAccountSummary } from '../../src/types/token.js';

// Same mocking style as safetyGate.test.ts: getMint stands in for the classic-SPL read. For a Token-2022 mint the real
// getMint throws TokenInvalidAccountOwnerError (measured on mainnet), which is what the mock reproduces.
const getMintMock = vi.fn();
vi.mock('@solana/spl-token', () => ({ getMint: (...args: unknown[]) => getMintMock(...args) }));

const { runSafetyGate } = await import('../../src/safety/safetyGate.js');
const { DirectSafetyDataSource, classifyFetchError } = await import('../../src/safety/dataSource.js');
const { evaluateToken2022Extensions, TOKEN_2022_EXTENSION_POLICY } = await import('../../src/safety/checks/token2022ExtensionCheck.js');
const { parseToken2022Mint, toBase58, EXTENSION_NAMES, TOKEN_2022_PROGRAM_ID_BASE58 } = await import('../../src/safety/token2022Mint.js');

const T22 = new PublicKey(TOKEN_2022_PROGRAM_ID_BASE58);
const CLASSIC = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MINT = 'So11111111111111111111111111111111111111112';

// ---------- deterministic Token-2022 mint account builder ----------
interface Ext { id: number; data: Uint8Array }
interface MintSpec { mintAuthority?: Uint8Array | null; freezeAuthority?: Uint8Array | null; supply?: bigint; decimals?: number; extensions?: Ext[]; initialized?: number; accountType?: number }

const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const zeros = (n: number): Uint8Array => new Uint8Array(n);

function buildMint(spec: MintSpec = {}): Buffer {
  const exts = spec.extensions ?? [];
  const tlvLen = exts.reduce((a, e) => a + 4 + e.data.length, 0);
  const len = exts.length === 0 ? 82 : 166 + tlvLen;
  const buf = Buffer.alloc(len);
  const setOpt = (off: number, k: Uint8Array | null | undefined): void => {
    if (k) {
      buf.writeUInt32LE(1, off);
      Buffer.from(k).copy(buf, off + 4);
    }
  };
  setOpt(0, spec.mintAuthority ?? null);
  buf.writeBigUInt64LE(spec.supply ?? 1_000_000_000_000_000n, 36);
  buf.writeUInt8(spec.decimals ?? 6, 44);
  buf.writeUInt8(spec.initialized ?? 1, 45);
  setOpt(46, spec.freezeAuthority ?? null);
  if (exts.length > 0) {
    buf.writeUInt8(spec.accountType ?? 1, 165);
    let o = 166;
    for (const e of exts) {
      buf.writeUInt16LE(e.id, o);
      buf.writeUInt16LE(e.data.length, o + 2);
      Buffer.from(e.data).copy(buf, o + 4);
      o += 4 + e.data.length;
    }
  }
  return buf;
}

const metadataPointer = (): Ext => ({ id: 18, data: Buffer.concat([zeros(32), Buffer.from(key(7))]) });
const tokenMetadata = (): Ext => ({ id: 19, data: Buffer.alloc(120, 1) });
function transferFee(olderBps: number, newerBps: number, maxFee = 1000n): Ext {
  const b = Buffer.alloc(108);
  b.writeBigUInt64LE(0n, 64);
  b.writeBigUInt64LE(10n, 72); b.writeBigUInt64LE(maxFee, 80); b.writeUInt16LE(olderBps, 88);
  b.writeBigUInt64LE(12n, 90); b.writeBigUInt64LE(maxFee, 98); b.writeUInt16LE(newerBps, 106);
  return { id: 1, data: b };
}
const transferHook = (authority: Uint8Array, program: Uint8Array): Ext => ({ id: 14, data: Buffer.concat([authority, program]) });
const permanentDelegate = (d: Uint8Array): Ext => ({ id: 12, data: Buffer.from(d) });
const defaultState = (s: number): Ext => ({ id: 6, data: Buffer.from([s]) });
const nonTransferable = (): Ext => ({ id: 9, data: Buffer.alloc(0) });

function summaryFrom(buf: Buffer, over: Partial<MintAccountSummary> = {}): MintAccountSummary {
  const r = parseToken2022Mint(buf);
  if (!r.ok) throw new Error('fixture must parse: ' + r.error);
  return { mint: MINT, mintAuthority: r.mint.mintAuthority, freezeAuthority: r.mint.freezeAuthority, supply: r.mint.supply, decimals: r.mint.decimals, tokenProgram: 'token-2022', token2022: { extensions: r.mint.extensions }, ...over };
}
const verdict = (spec: MintSpec) => evaluateToken2022Extensions(summaryFrom(buildMint(spec)));

// ---------- pure parser ----------
describe('parseToken2022Mint', () => {
  it('decodes authorities, supply, decimals and base58 addresses exactly like web3.js', () => {
    const pk = PublicKey.unique();
    const r = parseToken2022Mint(buildMint({ mintAuthority: pk.toBytes(), freezeAuthority: null, supply: 123_456_789n, decimals: 9 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mint.mintAuthority).toBe(pk.toBase58());
    expect(r.mint.freezeAuthority).toBeNull();
    expect(r.mint.supply).toBe(123_456_789n);
    expect(r.mint.decimals).toBe(9);
    expect(r.mint.extensions).toEqual([]);
    expect(toBase58(pk.toBytes())).toBe(pk.toBase58());
    expect(toBase58(new Uint8Array(32))).toBe(new PublicKey(new Uint8Array(32)).toBase58());
  });

  it('decodes the extension region (the real Pump.fun shape: MetadataPointer + TokenMetadata)', () => {
    const r = parseToken2022Mint(buildMint({ extensions: [metadataPointer(), tokenMetadata()] }));
    expect(r.ok && r.mint.extensions.map((e) => e.name)).toEqual(['MetadataPointer', 'TokenMetadata']);
  });

  it.each([
    ['too short', Buffer.alloc(40), 'account_too_short'],
    ['not initialized', buildMint({ initialized: 0 }), 'mint_not_initialized'],
    ['bad mint-authority option tag', (() => { const b = buildMint(); b.writeUInt32LE(7, 0); return b; })(), 'invalid_mint_authority_option'],
    ['bad freeze-authority option tag', (() => { const b = buildMint(); b.writeUInt32LE(9, 46); return b; })(), 'invalid_freeze_authority_option'],
    ['extension region shorter than the account-type offset', (() => { const b = Buffer.alloc(120); b.writeUInt8(1, 45); return b; })(), 'invalid_extension_region'],
    ['account type is not Mint', buildMint({ extensions: [metadataPointer()], accountType: 2 }), 'account_type_not_mint'],
    ['duplicate extension', buildMint({ extensions: [metadataPointer(), metadataPointer()] }), 'duplicate_extension'],
    ['truncated extension value', buildMint({ extensions: [metadataPointer()] }).subarray(0, 166 + 4 + 10), 'truncated_extension_value'],
    ['truncated extension header', Buffer.concat([buildMint({ extensions: [metadataPointer()] }), Buffer.from([1, 2])]), 'truncated_extension_header'],
  ])('rejects malformed data: %s', (_n, buf, error) => {
    const r = parseToken2022Mint(buf as Buffer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  });
});

// ---------- extension policy ----------
describe('Token-2022 extension contract', () => {
  it('B. no dangerous extension: metadata-only mint (the real Pump.fun shape) is safe; a mint with no extension at all is safe', () => {
    expect(verdict({ extensions: [metadataPointer(), tokenMetadata()] })).toMatchObject({ passed: true, reasons: [], extensions: ['MetadataPointer', 'TokenMetadata'] });
    expect(verdict({}).passed).toBe(true);
  });

  it('C. transfer fee: any non-zero fee (current OR scheduled) is rejected; a genuine 0 bps config is inert', () => {
    expect(verdict({ extensions: [transferFee(100, 0)] })).toMatchObject({ passed: false, reasons: ['token2022_transfer_fee_nonzero'] });
    expect(verdict({ extensions: [transferFee(0, 50)] })).toMatchObject({ passed: false, reasons: ['token2022_transfer_fee_nonzero'] }); // scheduled increase
    expect(verdict({ extensions: [transferFee(0, 0)] }).passed).toBe(true);
    expect(verdict({ extensions: [transferFee(1, 0, 0n)] }).passed).toBe(false); // a maximumFee of 0 is not trusted to neutralise a non-zero rate
  });

  it('C. malformed transfer-fee payload fails closed (never read as 0)', () => {
    expect(verdict({ extensions: [{ id: 1, data: Buffer.alloc(50) }] })).toMatchObject({ passed: false, reasons: ['token2022_extension_data_malformed'] });
  });

  it('D. transfer hook: accepted only when the hook program AND authority are both unset', () => {
    expect(verdict({ extensions: [transferHook(zeros(32), key(9))] })).toMatchObject({ passed: false, reasons: ['token2022_transfer_hook'] });
    expect(verdict({ extensions: [transferHook(key(3), zeros(32))] })).toMatchObject({ passed: false, reasons: ['token2022_transfer_hook'] }); // could install a hook later
    expect(verdict({ extensions: [transferHook(key(3), key(9))] }).passed).toBe(false);
    expect(verdict({ extensions: [transferHook(zeros(32), zeros(32))] }).passed).toBe(true);
    expect(verdict({ extensions: [{ id: 14, data: Buffer.alloc(10) }] }).reasons).toEqual(['token2022_extension_data_malformed']);
  });

  it('E. permanent delegate: rejected when a delegate is set, inert when unset', () => {
    expect(verdict({ extensions: [permanentDelegate(key(5))] })).toMatchObject({ passed: false, reasons: ['token2022_permanent_delegate'] });
    expect(verdict({ extensions: [permanentDelegate(zeros(32))] }).passed).toBe(true);
    expect(verdict({ extensions: [{ id: 12, data: Buffer.alloc(3) }] }).reasons).toEqual(['token2022_extension_data_malformed']);
  });

  it('F. non-transferable: always rejected', () => {
    expect(verdict({ extensions: [nonTransferable()] })).toMatchObject({ passed: false, reasons: ['token2022_non_transferable'] });
  });

  it('G. default account state: Frozen is rejected, Initialized is fine, anything else is malformed', () => {
    expect(verdict({ extensions: [defaultState(2)] })).toMatchObject({ passed: false, reasons: ['token2022_default_account_state_frozen'] });
    expect(verdict({ extensions: [defaultState(1)] }).passed).toBe(true);
    expect(verdict({ extensions: [defaultState(0)] }).reasons).toEqual(['token2022_extension_data_malformed']);
    expect(verdict({ extensions: [defaultState(7)] }).reasons).toEqual(['token2022_extension_data_malformed']);
  });

  it('mint close authority is harmless while supply > 0 and rejected at zero supply', () => {
    const ext: Ext = { id: 3, data: Buffer.from(key(4)) };
    expect(verdict({ extensions: [ext], supply: 5n }).passed).toBe(true);
    expect(verdict({ extensions: [ext], supply: 0n }).reasons).toEqual(['token2022_mint_close_authority_with_zero_supply']);
  });

  it('confidential transfer, pausable, interest-bearing, scaled UI amount and permissioned burn are rejected', () => {
    expect(verdict({ extensions: [{ id: 4, data: Buffer.alloc(65) }] }).reasons).toEqual(['token2022_confidential_transfer']);
    expect(verdict({ extensions: [{ id: 16, data: Buffer.alloc(10) }] }).reasons).toEqual(['token2022_confidential_transfer']);
    expect(verdict({ extensions: [{ id: 26, data: Buffer.alloc(33) }] }).reasons).toEqual(['token2022_pausable']);
    for (const id of [10, 25, 28]) expect(verdict({ extensions: [{ id, data: Buffer.alloc(20) }] }).reasons).toEqual(['token2022_unsupported_extension']);
  });

  it('H. unknown extension id fails closed (unknown is never safe), even alongside allowed ones', () => {
    expect(verdict({ extensions: [metadataPointer(), { id: 999, data: Buffer.alloc(4) }] })).toMatchObject({ passed: false, reasons: ['token2022_unsupported_extension'] });
    expect(verdict({ extensions: [{ id: 29, data: Buffer.alloc(0) }] }).passed).toBe(false);
  });

  it('H. account-level extensions cannot legitimately appear on a mint: rejected as malformed', () => {
    for (const id of [2, 5, 7, 8, 11, 13, 15, 17, 27]) expect(verdict({ extensions: [{ id, data: Buffer.alloc(8) }] }).reasons).toEqual(['token2022_extension_data_malformed']);
  });

  it('H. a wrong-length metadata pointer is not what it claims to be', () => {
    expect(verdict({ extensions: [{ id: 18, data: Buffer.alloc(12) }] }).reasons).toEqual(['token2022_extension_data_malformed']);
  });

  it('every reason is reported once even when several extensions are unsafe', () => {
    const r = verdict({ extensions: [nonTransferable(), permanentDelegate(key(5)), transferHook(key(1), key(2)), defaultState(2), transferFee(300, 0)] });
    expect(r.passed).toBe(false);
    expect([...r.reasons].sort()).toEqual(['token2022_default_account_state_frozen', 'token2022_non_transferable', 'token2022_permanent_delegate', 'token2022_transfer_fee_nonzero', 'token2022_transfer_hook']);
  });

  it('a Token-2022 summary with no decoded extension data fails closed; a classic summary is untouched', () => {
    const bare: MintAccountSummary = { mint: MINT, mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, tokenProgram: 'token-2022' };
    expect(evaluateToken2022Extensions(bare)).toMatchObject({ passed: false, reasons: ['token2022_extension_data_malformed'] });
    expect(evaluateToken2022Extensions({ mint: MINT, mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6 })).toEqual({ passed: true, reasons: [], extensions: [] });
    expect(evaluateToken2022Extensions(null)).toEqual({ passed: true, reasons: [], extensions: [] }); // absence is handled by the existing mint checks
  });

  it('the policy table is complete: every named extension has a classification and a justification', () => {
    const covered = new Set(TOKEN_2022_EXTENSION_POLICY.map((p) => p.id));
    for (const id of Object.keys(EXTENSION_NAMES).map(Number)) expect(covered.has(id), `extension ${id} ${EXTENSION_NAMES[id]} needs a policy`).toBe(true);
    for (const p of TOKEN_2022_EXTENSION_POLICY) {
      expect(p.why.length).toBeGreaterThan(20);
      if (p.class !== 'ALLOW') expect(p.rejectReason).toBeTruthy();
    }
    expect(TOKEN_2022_EXTENSION_POLICY.filter((p) => p.class === 'ALLOW').map((p) => p.name).sort()).toEqual(['GroupMemberPointer', 'GroupPointer', 'MetadataPointer', 'TokenGroup', 'TokenGroupMember', 'TokenMetadata']);
  });
});

// ---------- data source + full gate ----------
const cfg = {
  safety: { maxTop10HolderPct: 60, excludeAddresses: [] as string[] },
  filters: { minLiquiditySol: 20, minVolume1mSol: 5, minBuySellRatio: 1.5, minPriceVelocity5sPct: 1, minVolumeAccelerationX: 1.5, maxPriceImpactPct: 1 },
  edge: { dexFeeBps: 25, swapFeeBps: 5, networkFeeSol: 0.000005, priorityFeeSol: 0.0005, safetyMarginBps: 50 },
};
const wrongOwner = (): Error => Object.assign(new Error('Invalid account owner'), { name: 'TokenInvalidAccountOwnerError' });
const goodRoundTrip = { buyPriceImpactPct: 0.4, sellPriceImpactPct: 0.5 };
const goodAggregator = { getLiquidityAndVolume: vi.fn().mockResolvedValue({ liquiditySol: 40, volume1mSol: 10, buySellRatio: 2, txCount1m: 5 }) } as never;

function connectionFor(opts: { account?: { owner: PublicKey; data: Buffer } | null | 'throw'; holders?: Array<{ address: string; amount: string }> | 'throw' }) {
  return {
    getMultipleAccountsInfo: vi.fn(async () => [null, null]), // Phase 5.6E: no Pump.fun bonding curve for this mint
    getAccountInfo: vi.fn(async () => {
      if (opts.account === 'throw') throw new Error('rpc down');
      return opts.account === null ? null : opts.account;
    }),
    getTokenLargestAccounts: vi.fn(async () => {
      if (opts.holders === 'throw') throw new Error('rpc down');
      return { value: (opts.holders ?? [{ address: 'h1', amount: '100' }]).map((h) => ({ address: { toBase58: () => h.address }, amount: h.amount })) };
    }),
  } as never;
}

async function gate(spec: MintSpec, opts: { holders?: Array<{ address: string; amount: string }> | 'throw'; roundTrip?: unknown } = {}) {
  const connection = connectionFor({ account: { owner: T22, data: buildMint(spec) }, ...(opts.holders ? { holders: opts.holders } : {}) });
  return runSafetyGate(MINT, { connection, aggregator: goodAggregator, getRoundTripQuote: vi.fn().mockResolvedValue(opts.roundTrip === undefined ? goodRoundTrip : opts.roundTrip) as never }, cfg);
}

describe('full safety gate on Token-2022 mints', () => {
  beforeEach(() => {
    getMintMock.mockReset();
  });

  it('A. classic SPL mint: behavior unchanged (no extension check, no second RPC)', async () => {
    getMintMock.mockResolvedValue({ mintAuthority: null, freezeAuthority: null, supply: 1_000_000n, decimals: 6 });
    const connection = connectionFor({ account: null });
    const r = await runSafetyGate(MINT, { connection, aggregator: goodAggregator, getRoundTripQuote: vi.fn().mockResolvedValue(goodRoundTrip) as never }, cfg);
    expect(r.passed).toBe(true);
    expect((connection as unknown as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo).not.toHaveBeenCalled();
    expect(r.details.tokenProgram).toBe('spl-token');
  });

  it('B. safe Token-2022 mint (metadata only) is EVALUATED and passes every check, with real holder data', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    const r = await gate({ extensions: [metadataPointer(), tokenMetadata()] });
    expect(r).toMatchObject({ passed: true, reasons: [], mintAuthorityRenounced: true, freezeAuthorityRenounced: true, top10HolderPct: 0 });
    expect(r.details.tokenProgram).toBe('token-2022');
    expect(r.details.token2022Extensions).toEqual(['MetadataPointer', 'TokenMetadata']);
  });

  it.each([
    ['C. transfer fee', [transferFee(200, 0)], 'token2022_transfer_fee_nonzero'],
    ['D. transfer hook', [transferHook(zeros(32), key(9))], 'token2022_transfer_hook'],
    ['E. permanent delegate', [permanentDelegate(key(5))], 'token2022_permanent_delegate'],
    ['F. non-transferable', [nonTransferable()], 'token2022_non_transferable'],
    ['G. default frozen', [defaultState(2)], 'token2022_default_account_state_frozen'],
    ['H. unknown extension', [{ id: 777, data: Buffer.alloc(2) }], 'token2022_unsupported_extension'],
  ])('%s is REJECTED by the gate even though the quote looks fine', async (_n, extensions, reason) => {
    getMintMock.mockRejectedValue(wrongOwner());
    const r = await gate({ extensions: [metadataPointer(), ...(extensions as Ext[])] });
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain(reason);
  });

  it('the existing authority checks still apply to Token-2022 mints (mint and freeze authority present => rejected)', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    const r = await gate({ extensions: [metadataPointer()], mintAuthority: key(1), freezeAuthority: key(2) });
    expect(r.reasons).toEqual(expect.arrayContaining(['mint_authority_not_renounced', 'freeze_authority_present']));
    expect(r.passed).toBe(false);
    expect(r.mintAuthorityRenounced).toBe(false);
  });

  it('H. malformed extension region => the mint is UNAVAILABLE (mint_account_unavailable), no partial data', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    const connection = connectionFor({ account: { owner: T22, data: buildMint({ extensions: [metadataPointer(), metadataPointer()] }) } });
    const r = await runSafetyGate(MINT, { connection, aggregator: goodAggregator, getRoundTripQuote: vi.fn().mockResolvedValue(goodRoundTrip) as never }, cfg);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain('mint_account_unavailable');
    expect(r.mintAuthorityRenounced).toBeNull();
    expect(r.details.dataFailures).toMatchObject({ mint: 'token:token2022_extension_data_malformed' });
  });

  it('I. unreadable mint: account missing, RPC failure, wrong owner => fail closed with the cause recorded', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    const run = (account: unknown) => runSafetyGate(MINT, { connection: connectionFor({ account: account as never }), aggregator: goodAggregator, getRoundTripQuote: vi.fn().mockResolvedValue(goodRoundTrip) as never }, cfg);
    const missing = await run(null);
    const down = await run('throw');
    const other = await run({ owner: new PublicKey('11111111111111111111111111111111'), data: buildMint({}) });
    for (const r of [missing, down, other]) {
      expect(r.passed).toBe(false);
      expect(r.reasons).toEqual(expect.arrayContaining(['mint_account_unavailable', 'holder_data_unavailable']));
      expect(r.mintAuthorityRenounced).toBeNull();
      expect(r.top10HolderPct).toBeNull();
    }
    expect(missing.details.dataFailures).toMatchObject({ mint: 'token:account_not_found' });
    expect(down.details.dataFailures).toMatchObject({ mint: 'provider:error' });
    expect(other.details.dataFailures).toMatchObject({ mint: 'token:unsupported_token_program' });
  });

  it('J. unreadable holder data on a safe Token-2022 mint fails closed and inserts no concentration value', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    const r = await gate({ extensions: [metadataPointer()] }, { holders: 'throw' });
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain('holder_data_unavailable');
    expect(r.top10HolderPct).toBeNull();
  });

  it('holder concentration is still enforced on Token-2022 mints (no bypass)', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    const r = await gate({ extensions: [metadataPointer()], supply: 1000n }, { holders: [{ address: 'whale', amount: '900' }] });
    expect(r.reasons).toContain('holder_concentration_too_high');
    expect(r.passed).toBe(false);
  });

  it('sellability is still enforced on Token-2022 mints (unavailable / no route / excessive loss all fail closed)', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    expect((await gate({ extensions: [metadataPointer()] }, { roundTrip: null })).reasons).toContain('quote_unavailable');
    expect((await gate({ extensions: [metadataPointer()] }, { roundTrip: { buyPriceImpactPct: 0.4, sellPriceImpactPct: null } })).reasons).toContain('no_sell_route_found');
    expect((await gate({ extensions: [metadataPointer()] }, { roundTrip: { buyPriceImpactPct: 2, sellPriceImpactPct: 2 } })).reasons).toContain('excessive_round_trip_loss');
  });

  it('a non-owner error from getMint is NOT mistaken for Token-2022 (classified as before, no Token-2022 fallback read)', async () => {
    getMintMock.mockRejectedValue(Object.assign(new Error('nf'), { name: 'TokenAccountNotFoundError' }));
    const connection = connectionFor({ account: { owner: T22, data: buildMint({}) } });
    const src = new DirectSafetyDataSource(connection);
    const out = await src.getMintSummary(MINT);
    expect(out.value).toBeNull();
    expect(out.failure).toEqual({ kind: 'token', reason: 'account_not_found' });
    expect((connection as unknown as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo).not.toHaveBeenCalled();
    expect(classifyFetchError(wrongOwner())).toEqual({ kind: 'token', reason: 'unsupported_token_program' });
  });

  it('a classic-program account handed to the Token-2022 path is rejected, not decoded', async () => {
    getMintMock.mockRejectedValue(wrongOwner());
    const src = new DirectSafetyDataSource(connectionFor({ account: { owner: CLASSIC, data: buildMint({}) } }));
    const out = await src.getMintSummary(MINT);
    expect(out.value).toBeNull();
    expect(out.failure?.reason).toBe('unsupported_token_program');
  });
});
