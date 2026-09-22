import { describe, expect, it } from 'vitest';
import {
  classifyQuote,
  decodeParsedTransactionTrades,
  decodePumpfunNotification,
  decodeTradeEventBody,
  NATIVE_SOL_QUOTE_MINT,
  PUMPFUN_PROGRAM_ID,
} from '../../src/volume/pumpfunTradeEventDecoder.js';
import { tradeIdentity } from '../../src/volume/types.js';
import { LAG_MS, REAL, REAL_DUAL_CHANNEL, TRADE_DISC, logsWithEvents, mintId, nextSig, programDataBuffers, quoteMintOffset, realTradePayload } from './helpers.js';

const decode = (n: (typeof REAL)['sol_buy'][number], extra: Partial<Parameters<typeof decodePumpfunNotification>[0]> = {}) =>
  decodePumpfunNotification({ signature: n.signature, slot: n.slot, err: n.err, logs: n.logs, receivedAtMs: 1_790_000_000_000, ...extra });

describe('Pump.fun TradeEvent decoder (real mainnet notifications)', () => {
  it('A: decodes a real SOL BUY with every required field', () => {
    for (const n of REAL.sol_buy) {
      const d = decode(n);
      expect(d.status).toBe('ok');
      expect(d.trades).toHaveLength(1);
      const t = d.trades[0]!;
      expect(t.isBuy).toBe(true);
      expect(t.quoteMint).toBe(NATIVE_SOL_QUOTE_MINT);
      expect(t.quoteClass).toBe('native_sol');
      expect(t.solAmountLamports).toBeGreaterThan(0);
      expect(BigInt(t.tokenAmount)).toBeGreaterThan(0n);
      expect(t.mint.length).toBeGreaterThan(30);
      expect(t.trader.length).toBeGreaterThan(30);
      expect(t.eventTimestampSec).toBeGreaterThan(1_780_000_000);
      expect(t.signature).toBe(n.signature);
      expect(t.slot).toBe(n.slot);
      expect(t.program).toBe(PUMPFUN_PROGRAM_ID);
      expect(t.eventOrdinal).toBe(0);
      expect(t.source).toBe('onlogs_program_data');
    }
  });

  it('B: decodes a real SOL SELL and reads direction from is_buy, not from anything else', () => {
    for (const n of REAL.sol_sell) {
      const d = decode(n);
      expect(d.trades).toHaveLength(1);
      expect(d.trades[0]!.isBuy).toBe(false);
      expect(d.trades[0]!.quoteClass).toBe('native_sol');
    }
  });

  it('C: real non-SOL quote events are classified other (never SOL) and carry their quote mint', () => {
    for (const n of REAL.non_sol) {
      const nonSol = decode(n).trades.filter((t) => t.quoteClass === 'other');
      expect(nonSol.length).toBeGreaterThan(0);
      for (const t of nonSol) {
        expect(t.quoteMint).not.toBe(NATIVE_SOL_QUOTE_MINT);
        expect(t.quoteMint).not.toBeNull();
      }
    }
  });

  it('D: a failed transaction produces no events, even when a valid TradeEvent is in its logs', () => {
    for (const n of REAL.failed) {
      const d = decode(n);
      expect(d.status).toBe('failed_tx');
      expect(d.trades).toEqual([]);
    }
    // A real, valid TradeEvent inside a transaction that FAILED (rolled back) must not count.
    const rolledBack = decode(REAL.sol_buy[0]!, { err: { InstructionError: [0, 'Custom'] } });
    expect(rolledBack.status).toBe('failed_tx');
    expect(rolledBack.trades).toEqual([]);
  });

  it('D2: success that cannot be established (err undefined) is discarded, never treated as success', () => {
    const d = decode(REAL.sol_buy[0]!, { err: undefined });
    expect(d.status).toBe('unknown_status');
    expect(d.trades).toEqual([]);
  });

  it('E: the same trade seen through the log line AND the emit_cpi self-invocation is counted once', () => {
    expect(REAL_DUAL_CHANNEL.length).toBeGreaterThanOrEqual(2);
    for (const tx of REAL_DUAL_CHANNEL) {
      const r = decodeParsedTransactionTrades(tx, tx.signature, tx.blockTime * 1000 + LAG_MS);
      expect(r.cpiTradeCopies).toBe(1); // the second representation really is present in the real transaction...
      expect(r.trades).toHaveLength(1); // ...and yields exactly one counted trade
      expect(r.cpiMatched).toBe(1); // ...and it is field-for-field the same event
      expect(r.trades[0]!.eventTimestampSec).toBe(tx.blockTime); // event timestamp == blockTime (Phase 5.4A finding)
    }
  });

  it('F: multiple trades in one real transaction get distinct, ordered identities', () => {
    for (const n of REAL.multi) {
      const d = decode(n);
      expect(d.trades.length).toBeGreaterThanOrEqual(2);
      expect(d.trades.map((t) => t.eventOrdinal)).toEqual(d.trades.map((_, i) => i));
      const ids = d.trades.map(tradeIdentity);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(d.trades.map((t) => t.signature)).size).toBe(1); // same signature: signature alone would collide
    }
  });

  it('G: identity is (signature, program, ordinal)', () => {
    const t = decode(REAL.sol_buy[0]!).trades[0]!;
    expect(tradeIdentity(t)).toBe(`${t.signature}:${PUMPFUN_PROGRAM_ID}:0`);
  });

  it('decodes real Create, Complete (graduation) and PumpAMM migration lifecycle events', () => {
    const create = decode(REAL.create[0]!).lifecycle.find((l) => l.kind === 'create')!;
    expect(create.quoteMint).toBe(NATIVE_SOL_QUOTE_MINT);
    expect(create.mint.length).toBeGreaterThan(30);
    const graduate = REAL.complete.map((n) => decode(n).lifecycle.find((l) => l.kind === 'graduate'));
    expect(graduate.every((g) => g !== undefined)).toBe(true);
    const migrate = REAL.migrate.map((n) => decode(n).lifecycle.find((l) => l.kind === 'migrate'));
    expect(migrate.every((m) => m !== undefined)).toBe(true);
  });

  it('never attributes a wrapper program data line to Pump.fun', () => {
    const payload = realTradePayload('sol_buy');
    const d = decodePumpfunNotification({ signature: nextSig(), slot: 1, err: null, logs: logsWithEvents([payload], true), receivedAtMs: 1 });
    expect(d.trades).toHaveLength(1);
    expect(d.decodeErrors).toEqual([]);
  });

  it('an event that omits quote_mint (older layout) is UNPROVEN, not SOL', () => {
    // SYNTHETIC (labelled): a real payload cut right after ix_name, i.e. the layout that predates the quote fields.
    const real = realTradePayload('sol_buy');
    let o = 8 + 32 + 8 + 8 + 1 + 32 + 8 + 32 + 48 + 48 + 1 + 32;
    o += 4 + real.readUInt32LE(o);
    const old = real.subarray(0, o);
    const raw = decodeTradeEventBody(old.subarray(8));
    expect(raw.quoteMint).toBeNull();
    expect(classifyQuote(raw)).toBe('unproven');
    const d = decodePumpfunNotification({ signature: nextSig(), slot: 1, err: null, logs: logsWithEvents([old]), receivedAtMs: 1 });
    expect(d.trades[0]!.quoteClass).toBe('unproven');
  });

  it('a SOL-looking quote whose quote_amount disagrees with sol_amount is UNPROVEN', () => {
    const real = Buffer.from(realTradePayload('sol_buy'));
    real.writeBigUInt64LE(real.readBigUInt64LE(40) + 1n, quoteMintOffset(real) + 32);
    expect(classifyQuote(decodeTradeEventBody(real.subarray(8)))).toBe('unproven');
  });

  it('wrapped SOL is not accepted as the native quote (never observed as a Pump.fun quote)', () => {
    expect(classifyQuote({ quoteMint: 'So11111111111111111111111111111111111111112', quoteAmount: 5n, solAmountLamports: 5 })).toBe('other');
  });

  it('malformed core fields are reported as decode errors (a silent loss otherwise)', () => {
    const bad = Buffer.from(realTradePayload('sol_buy'));
    bad.writeUInt8(7, 56); // is_buy is not a boolean
    const d = decodePumpfunNotification({ signature: nextSig(), slot: 1, err: null, logs: logsWithEvents([bad]), receivedAtMs: 1 });
    expect(d.trades).toEqual([]);
    expect(d.decodeErrors).toHaveLength(1);
    const early = Buffer.from(realTradePayload('sol_buy'));
    early.writeBigInt64LE(5n, 89); // implausible timestamp
    const d2 = decodePumpfunNotification({ signature: nextSig(), slot: 1, err: null, logs: logsWithEvents([early]), receivedAtMs: 1 });
    expect(d2.decodeErrors).toHaveLength(1);
  });

  it('flags a truncated log stream', () => {
    const logs = [...logsWithEvents([realTradePayload('sol_buy')]), 'Log truncated'];
    const d = decodePumpfunNotification({ signature: nextSig(), slot: 1, err: null, logs, receivedAtMs: 1 });
    expect(d.truncated).toBe(true);
  });

  it('ignores unrelated events and other programs logs', () => {
    const d = decodePumpfunNotification({
      signature: nextSig(),
      slot: 1,
      err: null,
      logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Program data: AAAA', 'Program 11111111111111111111111111111111 success'],
      receivedAtMs: 1,
    });
    expect(d).toMatchObject({ status: 'ok', trades: [], lifecycle: [], decodeErrors: [] });
  });

  it('real fixture sanity: the trade discriminator is the one the IDL declares', () => {
    expect(programDataBuffers(REAL.sol_buy[0]!, TRADE_DISC)).toHaveLength(1);
    expect(mintId(1)).not.toBe(mintId(2));
  });
});
