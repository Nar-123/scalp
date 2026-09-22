import bs58 from 'bs58';
import { getOwnProgramDataPayloads, logsWereTruncated } from '../discovery/programLogs.js';
import type { CurveState, LifecycleEvent, NormalizedTradeEvent, QuoteClass } from './types.js';

/**
 * Pump.fun (bonding curve program) event decoder. PURE: bytes/strings in,
 * plain objects out. No RPC, no I/O, no clock.
 *
 * Layouts were read from pump.fun's own on-chain Anchor IDL (Phase 5.4A) and
 * checked against real mainnet transactions: `TradeEvent.sol_amount` equalled
 * the bonding-curve account's lamport change exactly (fees excluded) in every
 * transaction inspected, and `timestamp` equalled the transaction blockTime.
 *
 * CANONICAL CHANNEL. Every trade is emitted twice: as a `Program data:` log
 * line AND as an Anchor `emit_cpi` self-invocation (inner instruction whose
 * data starts with EVENT_CPI_TAG). This module counts ONLY the log-line
 * representation: it arrives in the `onLogs` push we already receive, so no
 * per-trade RPC is needed. The CPI copy is decoded solely by
 * `decodeParsedTransactionTrades` to prove the two representations agree; it
 * never produces a trade.
 */

export const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * Quote-mint representation Pump.fun uses for NATIVE SOL curves: the default
 * pubkey (system program id, all-ones base58). Observed on every SOL-quoted
 * trade in Phase 5.4A. Wrapped SOL (So111...112) is NOT accepted: it was never
 * observed as a Pump.fun curve quote, so treating it as SOL would be an
 * unverified assumption. Any other value (USDC and other tokens were seen
 * live, 9.2 % of events) means `sol_amount` is denominated in that asset.
 */
export const NATIVE_SOL_QUOTE_MINT = '11111111111111111111111111111111';

const hex = (bytes: number[]): string => Buffer.from(bytes).toString('hex');
const TRADE_EVENT_DISC = hex([189, 219, 127, 211, 78, 230, 97, 238]);
const CREATE_EVENT_DISC = hex([27, 114, 169, 77, 222, 235, 99, 118]);
const COMPLETE_EVENT_DISC = hex([95, 114, 97, 156, 212, 46, 152, 8]);
const COMPLETE_MIGRATION_EVENT_DISC = hex([189, 233, 93, 185, 92, 148, 234, 148]);
/** Anchor's `emit_cpi!` instruction tag (sha256("anchor:event")[..8]). */
export const EVENT_CPI_TAG = 'e445a52e51cb9a1d';

const MIN_PLAUSIBLE_TS = 1_500_000_000;
const MAX_PLAUSIBLE_TS = 4_000_000_000;

class Cursor {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  private need(n: number): void {
    if (this.offset + n > this.buf.length) throw new RangeError('event payload shorter than layout');
  }
  skip(n: number): void {
    this.need(n);
    this.offset += n;
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  pubkey(): string {
    this.need(32);
    const v = bs58.encode(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  string(): string {
    const len = this.u32();
    this.need(len);
    const v = this.buf.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return v;
  }
}

export interface RawTradeEvent {
  mint: string;
  solAmountLamports: number;
  tokenAmount: string;
  isBuy: boolean;
  trader: string;
  timestampSec: number;
  /** null when the payload predates / omits the quote fields: denomination cannot be proven. */
  quoteMint: string | null;
  quoteAmount: bigint | null;
  /** Post-trade curve state; null if the reserve/fee block could not be read. */
  curve: CurveState | null;
}

function toSafeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < 0n) throw new RangeError(`${what} out of safe integer range`);
  return Number(v);
}

function toTimestampSec(v: bigint): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_PLAUSIBLE_TS || n > MAX_PLAUSIBLE_TS) throw new RangeError('timestamp not plausible');
  return n;
}

/** Decodes a `TradeEvent` body (payload AFTER the 8-byte discriminator). Throws RangeError on a malformed core. */
export function decodeTradeEventBody(body: Buffer): RawTradeEvent {
  const c = new Cursor(body);
  const mint = c.pubkey();
  const solAmountLamports = toSafeNumber(c.u64(), 'sol_amount');
  const tokenAmount = c.u64().toString();
  const isBuyByte = c.u8();
  if (isBuyByte > 1) throw new RangeError('is_buy is not a boolean');
  const trader = c.pubkey();
  const timestampSec = toTimestampSec(c.i64());

  // Everything after the timestamp is read defensively: a shortfall leaves the later fields unproven
  // (never assumed). Reserves/fees come first (present in every layout), then the fields appended by newer versions.
  let curve: CurveState | null = null;
  let quoteMint: string | null = null;
  let quoteAmount: bigint | null = null;
  try {
    const virtualSol = c.u64();
    const virtualToken = c.u64();
    const realSol = c.u64();
    const realToken = c.u64();
    c.skip(32); // fee_recipient
    const feeBps = c.u64();
    c.skip(8); // fee
    c.skip(32); // creator
    const creatorFeeBps = c.u64();
    c.skip(8); // creator_fee
    curve = {
      virtualSolReserves: virtualSol,
      virtualTokenReserves: virtualToken,
      realSolReserves: realSol,
      realTokenReserves: realToken,
      feeBasisPoints: Number(feeBps),
      creatorFeeBasisPoints: Number(creatorFeeBps),
      mayhemMode: null,
    };
    c.skip(1 + 8 + 8 + 8 + 8); // track_volume, unclaimed, claimed, current_sol_volume, last_update_timestamp
    c.string(); // ix_name
    const mayhem = c.u8();
    curve.mayhemMode = mayhem === 1 ? true : mayhem === 0 ? false : null;
    c.skip(8 * 4); // cashback bps/amount, buyback bps/fee
    const shareholders = c.u32();
    if (shareholders > 10_000) throw new RangeError('implausible shareholder count');
    c.skip(shareholders * 34); // address (32) + share_bps (u16)
    quoteMint = c.pubkey();
    quoteAmount = c.u64();
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    // keep whatever was read before the shortfall; quote fields stay null (unproven)
    quoteMint = null;
    quoteAmount = null;
  }

  return { mint, solAmountLamports, tokenAmount, isBuy: isBuyByte === 1, trader, timestampSec, quoteMint, quoteAmount, curve };
}

export function classifyQuote(raw: Pick<RawTradeEvent, 'quoteMint' | 'quoteAmount' | 'solAmountLamports'>): QuoteClass {
  if (raw.quoteMint === null) return 'unproven';
  if (raw.quoteMint !== NATIVE_SOL_QUOTE_MINT) return 'other';
  // Self-consistency proof of denomination: on every SOL-quoted event observed, quote_amount == sol_amount.
  if (raw.quoteAmount !== null && raw.quoteAmount !== BigInt(raw.solAmountLamports)) return 'unproven';
  return 'native_sol';
}

interface RawLifecycle {
  kind: 'create' | 'graduate' | 'migrate';
  mint: string;
  timestampSec: number;
  quoteMint: string | null;
}

function decodeCreateBody(body: Buffer): RawLifecycle {
  const c = new Cursor(body);
  c.string(); // name
  c.string(); // symbol
  c.string(); // uri
  const mint = c.pubkey();
  c.skip(32 * 3); // bonding_curve, user, creator
  const timestampSec = toTimestampSec(c.i64());
  let quoteMint: string | null = null;
  try {
    c.skip(8 * 4); // virtual_token, virtual_sol, real_token, token_total_supply
    c.skip(32 + 1 + 1); // token_program, is_mayhem_mode, is_cashback_enabled
    quoteMint = c.pubkey();
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
  }
  return { kind: 'create', mint, timestampSec, quoteMint };
}

function decodeCompleteBody(body: Buffer): RawLifecycle {
  const c = new Cursor(body);
  c.skip(32); // user
  const mint = c.pubkey();
  c.skip(32); // bonding_curve
  const timestampSec = toTimestampSec(c.i64());
  return { kind: 'graduate', mint, timestampSec, quoteMint: null };
}

function decodeMigrationBody(body: Buffer): RawLifecycle {
  const c = new Cursor(body);
  c.skip(32); // user
  const mint = c.pubkey();
  c.skip(8 * 3 + 32); // mint_amount, sol_amount, pool_migration_fee, bonding_curve
  const timestampSec = toTimestampSec(c.i64());
  return { kind: 'migrate', mint, timestampSec, quoteMint: null };
}

export interface LogNotificationInput {
  signature: string;
  slot: number;
  /** Transaction error from the notification. `null` = the transaction succeeded; `undefined` = status unknown. */
  err: unknown;
  logs: string[];
  receivedAtMs: number;
  programId?: string;
}

export interface DecodedNotification {
  /** ok = success proven; failed_tx = the transaction failed; unknown_status = success could not be established. */
  status: 'ok' | 'failed_tx' | 'unknown_status';
  /** The runtime cut the log output: events after the cut are invisible, so completeness cannot be claimed. */
  truncated: boolean;
  /** Recognized-but-malformed events (a silent loss if ignored, so the caller must treat these as a coverage break). */
  decodeErrors: string[];
  trades: NormalizedTradeEvent[];
  lifecycle: LifecycleEvent[];
}

function eventDisc(payload: Buffer): string {
  return payload.subarray(0, 8).toString('hex');
}

/**
 * Decodes one `onLogs` notification. Failed transactions produce NO events
 * (their logs may still contain a TradeEvent that was rolled back), and a
 * transaction whose success cannot be established is discarded too.
 */
export function decodePumpfunNotification(input: LogNotificationInput): DecodedNotification {
  const program = input.programId ?? PUMPFUN_PROGRAM_ID;
  const empty = (status: DecodedNotification['status']): DecodedNotification => ({
    status,
    truncated: false,
    decodeErrors: [],
    trades: [],
    lifecycle: [],
  });

  if (input.err === undefined) return empty('unknown_status');
  if (input.err !== null) return empty('failed_tx');

  const result: DecodedNotification = { status: 'ok', truncated: logsWereTruncated(input.logs), decodeErrors: [], trades: [], lifecycle: [] };
  let tradeOrdinal = 0;
  let lifecycleOrdinal = 0;

  for (const payload of getOwnProgramDataPayloads(input.logs, program)) {
    let buf: Buffer;
    try {
      buf = Buffer.from(payload.base64, 'base64');
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = eventDisc(buf);
    const body = buf.subarray(8);
    try {
      if (disc === TRADE_EVENT_DISC) {
        const raw = decodeTradeEventBody(body);
        result.trades.push({
          signature: input.signature,
          program,
          eventOrdinal: tradeOrdinal++,
          mint: raw.mint,
          solAmountLamports: raw.solAmountLamports,
          tokenAmount: raw.tokenAmount,
          isBuy: raw.isBuy,
          trader: raw.trader,
          eventTimestampSec: raw.timestampSec,
          slot: input.slot,
          quoteMint: raw.quoteMint,
          quoteClass: classifyQuote(raw),
          curve: raw.curve,
          receivedAtMs: input.receivedAtMs,
          source: 'onlogs_program_data',
        });
      } else if (disc === CREATE_EVENT_DISC || disc === COMPLETE_EVENT_DISC || disc === COMPLETE_MIGRATION_EVENT_DISC) {
        const raw = disc === CREATE_EVENT_DISC ? decodeCreateBody(body) : disc === COMPLETE_EVENT_DISC ? decodeCompleteBody(body) : decodeMigrationBody(body);
        result.lifecycle.push({
          signature: input.signature,
          program,
          eventOrdinal: lifecycleOrdinal++,
          kind: raw.kind,
          mint: raw.mint,
          eventTimestampSec: raw.timestampSec,
          slot: input.slot,
          quoteMint: raw.quoteMint,
          receivedAtMs: input.receivedAtMs,
        });
      }
    } catch (err) {
      result.decodeErrors.push(`${disc}:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// CPI channel: used ONLY to prove the two representations agree (regression
// fixture); it never contributes trades.
// ---------------------------------------------------------------------------

export interface ParsedInstructionLike {
  programId: string;
  data?: string | null;
}

export interface ParsedTransactionLike {
  signature?: string;
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    innerInstructions?: Array<{ index: number; instructions: ParsedInstructionLike[] }> | null;
  } | null;
  transaction: { message: { instructions: ParsedInstructionLike[] } };
}

/** Event payloads (discriminator + body) carried by `emit_cpi` self-invocations of `programId`. */
export function extractCpiEventPayloads(tx: ParsedTransactionLike, programId: string = PUMPFUN_PROGRAM_ID): Buffer[] {
  const all: ParsedInstructionLike[] = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
  const payloads: Buffer[] = [];
  for (const ix of all) {
    if (ix.programId !== programId || !ix.data) continue;
    let data: Uint8Array;
    try {
      data = bs58.decode(ix.data);
    } catch {
      continue;
    }
    const buf = Buffer.from(data);
    if (buf.length > 16 && buf.subarray(0, 8).toString('hex') === EVENT_CPI_TAG) payloads.push(buf.subarray(8));
  }
  return payloads;
}

export interface DualChannelResult {
  /** Trades counted: ONLY those read from the log channel. */
  trades: NormalizedTradeEvent[];
  /** Number of CPI-channel TradeEvents seen for this transaction (ignored for counting). */
  cpiTradeCopies: number;
  /** CPI copies that matched a log-channel trade field for field. */
  cpiMatched: number;
}

/** Decodes a full transaction: counts log-channel trades once and reports how many CPI copies agree. */
export function decodeParsedTransactionTrades(tx: ParsedTransactionLike, signature: string, receivedAtMs: number, programId: string = PUMPFUN_PROGRAM_ID): DualChannelResult {
  const decoded = decodePumpfunNotification({
    signature,
    slot: tx.slot,
    err: tx.meta ? tx.meta.err : undefined,
    logs: tx.meta?.logMessages ?? [],
    receivedAtMs,
    programId,
  });
  const cpiTrades: RawTradeEvent[] = [];
  for (const payload of extractCpiEventPayloads(tx, programId)) {
    if (eventDisc(payload) !== TRADE_EVENT_DISC) continue;
    try {
      cpiTrades.push(decodeTradeEventBody(payload.subarray(8)));
    } catch {
      // A malformed CPI copy is not counted either way.
    }
  }
  const used = new Set<number>();
  let cpiMatched = 0;
  for (const t of decoded.trades) {
    const idx = cpiTrades.findIndex(
      (c, i) =>
        !used.has(i) &&
        c.mint === t.mint &&
        c.solAmountLamports === t.solAmountLamports &&
        c.tokenAmount === t.tokenAmount &&
        c.isBuy === t.isBuy &&
        c.trader === t.trader &&
        c.timestampSec === t.eventTimestampSec,
    );
    if (idx >= 0) {
      used.add(idx);
      cpiMatched += 1;
    }
  }
  return { trades: decoded.trades, cpiTradeCopies: cpiTrades.length, cpiMatched };
}
