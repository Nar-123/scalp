import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PumpfunVolumeEngine, type PumpfunVolumeEngineOptions } from '../../src/volume/pumpfunVolumeEngine.js';
import { NATIVE_SOL_QUOTE_MINT, PUMPFUN_PROGRAM_ID, type LogNotificationInput } from '../../src/volume/pumpfunTradeEventDecoder.js';
import { getOwnProgramDataPayloads } from '../../src/discovery/programLogs.js';

export interface FixtureNotification {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
}

export type FixtureLabel = 'sol_buy' | 'sol_sell' | 'non_sol' | 'failed' | 'complete' | 'migrate' | 'multi' | 'create';

/** REAL mainnet notifications captured live during Phase 5.4B (public data; trimmed to signature/slot/err/logs). */
export const REAL: Record<FixtureLabel, FixtureNotification[]> = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'pumpfun', 'notifications.json'), 'utf8'),
);

/** REAL parsed transactions carrying BOTH representations of the same trade (log line + emit_cpi self-invocation). */
export const REAL_DUAL_CHANNEL: Array<{
  label: string;
  signature: string;
  slot: number;
  blockTime: number;
  meta: { err: unknown; logMessages: string[]; innerInstructions: Array<{ index: number; instructions: Array<{ programId: string; data: string | null }> }> };
  transaction: { message: { instructions: Array<{ programId: string; data: string | null }> } };
}> = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'pumpfun', 'dual_channel_transactions.json'), 'utf8'));

export const TRADE_DISC = 'bddb7fd34ee661ee';

export function programDataBuffers(n: FixtureNotification, disc?: string): Buffer[] {
  return getOwnProgramDataPayloads(n.logs, PUMPFUN_PROGRAM_ID)
    .map((p) => Buffer.from(p.base64, 'base64'))
    .filter((b) => (disc ? b.subarray(0, 8).toString('hex') === disc : true));
}

export function realTradePayload(label: FixtureLabel, index = 0): Buffer {
  return programDataBuffers(REAL[label][index] as FixtureNotification, TRADE_DISC)[0] as Buffer;
}

/** Byte offset of quote_mint inside a full TradeEvent payload (discriminator included), found by walking the real layout. */
export function quoteMintOffset(payload: Buffer): number {
  let o = 8 + 32 + 8 + 8 + 1 + 32 + 8; // disc, mint, sol, token, is_buy, user, timestamp
  o += 32 + 48 + 48; // reserves, fee block, creator block
  o += 1 + 8 * 4; // track_volume + 4 x u64
  o += 4 + payload.readUInt32LE(o); // ix_name
  o += 1 + 8 * 4; // mayhem + cashback/buyback
  const shareholders = payload.readUInt32LE(o);
  o += 4 + shareholders * 34;
  return o;
}

/** Byte offset of the mayhem_mode flag inside a full TradeEvent payload (discriminator included). */
export function mayhemOffset(payload: Buffer): number {
  let o = 8 + 32 + 8 + 8 + 1 + 32 + 8 + 32 + 48 + 48 + 1 + 32;
  o += 4 + payload.readUInt32LE(o);
  return o;
}

export interface CurvePatch {
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
  feeBps?: number;
  creatorFeeBps?: number;
  mayhem?: boolean;
}

export interface TradePatch {
  mint?: string;
  solLamports?: number;
  tokenAmount?: bigint;
  timestampSec?: number;
  isBuy?: boolean;
  quoteMint?: string;
  curve?: CurvePatch;
}

/**
 * Takes a REAL TradeEvent payload and rewrites selected fields in place, keeping every other byte (and therefore
 * the real layout) intact. quote_amount is kept equal to sol_amount so the self-consistency proof still holds.
 */
export function patchTrade(base: Buffer, p: TradePatch): Buffer {
  const b = Buffer.from(base);
  if (p.mint !== undefined) Buffer.from(bs58.decode(p.mint)).copy(b, 8);
  if (p.solLamports !== undefined) {
    b.writeBigUInt64LE(BigInt(p.solLamports), 40);
    b.writeBigUInt64LE(BigInt(p.solLamports), quoteMintOffset(b) + 32);
  }
  if (p.tokenAmount !== undefined) b.writeBigUInt64LE(p.tokenAmount, 48);
  if (p.curve) {
    b.writeBigUInt64LE(p.curve.virtualSol, 97);
    b.writeBigUInt64LE(p.curve.virtualToken, 105);
    b.writeBigUInt64LE(p.curve.realSol, 113);
    b.writeBigUInt64LE(p.curve.realToken, 121);
    if (p.curve.feeBps !== undefined) b.writeBigUInt64LE(BigInt(p.curve.feeBps), 161);
    if (p.curve.creatorFeeBps !== undefined) b.writeBigUInt64LE(BigInt(p.curve.creatorFeeBps), 209);
    if (p.curve.mayhem !== undefined) b.writeUInt8(p.curve.mayhem ? 1 : 0, mayhemOffset(b));
  }
  if (p.isBuy !== undefined) b.writeUInt8(p.isBuy ? 1 : 0, 56);
  if (p.timestampSec !== undefined) b.writeBigInt64LE(BigInt(p.timestampSec), 89);
  if (p.quoteMint !== undefined) Buffer.from(bs58.decode(p.quoteMint)).copy(b, quoteMintOffset(b));
  return b;
}

export function mintId(n: number): string {
  return bs58.encode(Buffer.alloc(32, n % 250 + 1).fill((n >> 8) & 0xff, 1, 2).fill(n & 0xff, 0, 1));
}

let sigCounter = 0;
export function nextSig(prefix = 'sig'): string {
  sigCounter += 1;
  return `${prefix}${String(sigCounter).padStart(10, '0')}`;
}

/** Log lines of a transaction in which the Pump.fun program emitted the given event payloads (real stack shape). */
export function logsWithEvents(payloads: Buffer[], wrapper = false): string[] {
  const lines: string[] = [];
  if (wrapper) lines.push('Program WRAPPERwrapperWRAPPERwrapperWRAPPER111111111 invoke [1]');
  lines.push(`Program ${PUMPFUN_PROGRAM_ID} invoke [${wrapper ? 2 : 1}]`, 'Program log: Instruction: Buy');
  for (const p of payloads) lines.push(`Program data: ${p.toString('base64')}`);
  lines.push(`Program ${PUMPFUN_PROGRAM_ID} success`);
  if (wrapper) {
    lines.push('Program data: AAAAAAAAAAAAAAAA'); // a WRAPPER's own data line must never be attributed to Pump.fun
    lines.push('Program WRAPPERwrapperWRAPPERwrapperWRAPPER111111111 success');
  }
  return lines;
}

export function notification(payloads: Buffer[], opts: { signature?: string; slot?: number; err?: unknown; receivedAtMs: number; wrapper?: boolean }): LogNotificationInput {
  return {
    signature: opts.signature ?? nextSig(),
    slot: opts.slot ?? 1,
    err: opts.err === undefined ? null : opts.err,
    logs: logsWithEvents(payloads, opts.wrapper),
    receivedAtMs: opts.receivedAtMs,
  };
}

/** Simulated ~1.1 s receipt lag (the median measured live in Phase 5.4A/5.4B). */
export const LAG_MS = 1100;

export const BASE_TS = 1_790_000_000;

/** A standard Pump.fun curve (Global initial reserves read on-chain: 30 SOL virtual, 1.073e15 virtual tokens, 793.1e12 real tokens). */
export class CurveSim {
  vs = 30_000_000_000n;
  vt = 1_073_000_000_000_000n;
  rs = 0n;
  rt = 793_100_000_000_000n;

  /** Buy: `net` lamports reach the curve. Returns the trade fields with the POST state. */
  buy(net: bigint): { solLamports: number; tokenAmount: bigint; isBuy: true; curve: CurvePatch } {
    const tokens = (net * this.vt) / (this.vs + net);
    this.vs += net;
    this.vt -= tokens;
    this.rs += net;
    this.rt -= tokens;
    return { solLamports: Number(net), tokenAmount: tokens, isBuy: true, curve: this.post() };
  }

  /** Sell: `tokens` base units are returned to the curve. */
  sell(tokens: bigint): { solLamports: number; tokenAmount: bigint; isBuy: false; curve: CurvePatch } {
    const sol = (tokens * this.vs) / (this.vt + tokens);
    this.vs -= sol;
    this.vt += tokens;
    this.rs -= sol;
    this.rt += tokens;
    return { solLamports: Number(sol), tokenAmount: tokens, isBuy: false, curve: this.post() };
  }

  post(): CurvePatch {
    return { virtualSol: this.vs, virtualToken: this.vt, realSol: this.rs, realToken: this.rt, feeBps: 95, creatorFeeBps: 30, mayhem: false };
  }
}

export class Feed {
  readonly engine: PumpfunVolumeEngine;
  private slot = 1000;
  private clockMs = 0; // receipt clock: monotonic, like a real socket

  constructor(options: PumpfunVolumeEngineOptions = {}, startedAtMs = (BASE_TS - 500) * 1000) {
    this.engine = new PumpfunVolumeEngine(options);
    this.engine.markStreamStarted(startedAtMs);
  }

  /** One trade at event second `ts` (real payload layout, patched fields). Returns the signature used. */
  trade(p: { mint: string; sol: number; ts: number; buy?: boolean; quoteMint?: string; signature?: string; ordinal?: number }): string {
    const signature = p.signature ?? nextSig();
    const base = realTradePayload(p.buy === false ? 'sol_sell' : 'sol_buy');
    const payload = patchTrade(base, { mint: p.mint, solLamports: Math.round(p.sol * 1e9), timestampSec: p.ts, isBuy: p.buy !== false, quoteMint: p.quoteMint });
    this.engine.onNotification(notification([payload], { signature, slot: (this.slot += 1), receivedAtMs: this.receipt(p.ts) }));
    return signature;
  }

  private receipt(ts: number): number {
    this.clockMs = Math.max(this.clockMs, ts * 1000 + LAG_MS);
    return this.clockMs;
  }

  /** A trade whose curve fields come from a CurveSim step (a valid constant-product chain). */
  curveTrade(mint: string, step: { solLamports: number; tokenAmount: bigint; isBuy: boolean; curve: CurvePatch }, ts: number, patch: TradePatch = {}, slot?: number): string {
    const signature = nextSig();
    const base = realTradePayload(step.isBuy ? 'sol_buy' : 'sol_sell');
    const payload = patchTrade(base, { mint, solLamports: step.solLamports, tokenAmount: step.tokenAmount, isBuy: step.isBuy, timestampSec: ts, curve: step.curve, ...patch });
    this.engine.onNotification(notification([payload], { signature, slot: slot ?? (this.slot += 1), receivedAtMs: this.receipt(ts) }));
    return signature;
  }

  /** Advances the stream watermark with an unrelated mint's tiny trade, one per second in [fromTs, toTs]. */
  pace(fromTs: number, toTs: number, pacerMint = mintId(9999)): void {
    for (let t = fromTs; t <= toTs; t += 1) this.trade({ mint: pacerMint, sol: 0.001, ts: t });
  }

  /** A Create event for `mint` at `ts` (SOL quote), built from the REAL create fixture. */
  create(mint: string, ts: number, quoteMint: string = NATIVE_SOL_QUOTE_MINT): void {
    this.engine.onNotification(notification([createPayload(mint, ts, quoteMint)], { slot: (this.slot += 1), receivedAtMs: this.receipt(ts) }));
  }

  /** A CompleteEvent (bonding curve graduated) for `mint` at `ts`, built from a REAL captured CompleteEvent. */
  graduate(mint: string, ts: number): void {
    this.engine.onNotification(notification([graduatePayload(mint, ts)], { slot: (this.slot += 1), receivedAtMs: this.receipt(ts) }));
  }
}

/** A REAL captured CreateEvent with the mint, timestamp and quote mint rewritten. */
export function createPayload(mint: string, ts: number, quoteMint: string = NATIVE_SOL_QUOTE_MINT): Buffer {
  const real = programDataBuffers(REAL.create[0] as FixtureNotification, '1b72a94ddeeb6376')[0] as Buffer;
  const b = Buffer.from(real);
  // name/symbol/uri are variable length; walk to the mint (after 3 strings) and patch mint, timestamp and quote mint.
  let o = 8;
  for (let i = 0; i < 3; i += 1) o += 4 + b.readUInt32LE(o);
  Buffer.from(bs58.decode(mint)).copy(b, o);
  const tsOffset = o + 32 * 4;
  b.writeBigInt64LE(BigInt(ts), tsOffset);
  const quoteOffset = tsOffset + 8 + 8 * 4 + 32 + 1 + 1;
  Buffer.from(bs58.decode(quoteMint)).copy(b, quoteOffset);
  return b;
}

/** A REAL captured CompleteEvent with the mint and timestamp rewritten. */
export function graduatePayload(mint: string, ts: number): Buffer {
  const real = programDataBuffers(REAL.complete[0] as FixtureNotification, '5f72619cd42e9808')[0] as Buffer;
  const b = Buffer.from(real);
  Buffer.from(bs58.decode(mint)).copy(b, 8 + 32); // user(32) then mint
  b.writeBigInt64LE(BigInt(ts), 8 + 32 + 32 + 32);
  return b;
}

/** A wall-clock instant comfortably after event second `ts` (used as the query time). */
export const at = (ts: number): number => (ts + 2) * 1000;
