import { PublicKey, type Connection } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import type { HolderBalance, MintAccountSummary } from '../types/token.js';
import { ProviderError } from '../providers/providerGate.js';
import type { ProviderMetrics } from '../providers/providerMetrics.js';
import { SingleFlightCache } from '../providers/singleFlightCache.js';
import { TOKEN_2022_PROGRAM_ID_BASE58, parseToken2022Mint } from './token2022Mint.js';
import { deriveCurveAndVault, type CurveEvidence, type RawAccount } from './bondingCurveVault.js';

/**
 * Where the safety gate gets its on-chain data. The gate's SEMANTICS are unchanged: no data means the check fails
 * closed. What this layer adds is the missing distinction between
 *
 *   - a TOKEN fact: the account is not a mint / does not exist (`kind: 'token'`), and
 *   - a PROVIDER problem: rate limit, timeout, outage, unsupported method (`kind: 'provider'`),
 *
 * plus the as-of time of every value, so nothing older than the decision rules allow can be used.
 */

export interface DataFailure {
  kind: 'provider' | 'token';
  reason: string;
}

export interface FetchOutcome<T> {
  value: T | null;
  failure: DataFailure | null;
  /** Wall-clock time the data was obtained (a reused value keeps its original time). */
  asOfMs: number;
}

export interface SafetyDataSource {
  getMintSummary(mint: string): Promise<FetchOutcome<MintAccountSummary>>;
  getLargestHolders(mint: string): Promise<FetchOutcome<HolderBalance[]>>;
  /**
   * Phase 5.6E: the two accounts (Pump.fun curve, its vault) at the addresses derived from the mint, read in ONE call so they
   * share a slot. A missing account is a fact (`null`), a failed read is a failure (fail closed by the caller).
   */
  getBondingCurveAccounts(mint: string, summary: MintAccountSummary): Promise<FetchOutcome<CurveEvidence>>;
  /** Phase 5.6E, DIAGNOSTIC only: the owner wallet of each given token account (used to record the creator's share). */
  getTokenAccountOwners(mint: string, tokenAccounts: string[]): Promise<FetchOutcome<Record<string, string>>>;
}

const TOKEN_FACT_ERRORS = new Set(['TokenAccountNotFoundError', 'TokenInvalidAccountOwnerError', 'TokenInvalidMintError', 'TokenInvalidAccountSizeError']);

export function classifyFetchError(err: unknown): DataFailure {
  if (err instanceof ProviderError) return { kind: 'provider', reason: err.reason };
  const name = err instanceof Error ? err.name : '';
  if (TOKEN_FACT_ERRORS.has(name)) {
    // A Token-2022 mint fails getMint's owner check (measured in the Phase 5.6A run: the "not a valid mint" failures were
    // Token-2022 mints). The gate only understands classic SPL mints, so it stays fail-closed; only the label is precise.
    const reason = name === 'TokenAccountNotFoundError' ? 'account_not_found' : name === 'TokenInvalidAccountOwnerError' ? 'unsupported_token_program' : 'not_a_valid_mint';
    return { kind: 'token', reason };
  }
  const msg = err instanceof Error ? err.message : String(err);
  // A JSON-RPC error that says the parameter is not a token mint is a token fact.
  if (/not a token mint|invalid param/i.test(msg)) return { kind: 'token', reason: 'not_a_token_mint' };
  return { kind: 'provider', reason: 'error' };
}

/** Direct RPC reads (no cache). */
export class DirectSafetyDataSource implements SafetyDataSource {
  constructor(private readonly connection: Connection) {}

  async getMintSummary(mint: string): Promise<FetchOutcome<MintAccountSummary>> {
    try {
      const info = await getMint(this.connection, new PublicKey(mint));
      return {
        value: {
          mint,
          mintAuthority: info.mintAuthority ? info.mintAuthority.toBase58() : null,
          freezeAuthority: info.freezeAuthority ? info.freezeAuthority.toBase58() : null,
          supply: info.supply,
          decimals: info.decimals,
        },
        failure: null,
        asOfMs: Date.now(),
      };
    } catch (err) {
      // getMint only reads classic SPL mints and reports any other owner as TokenInvalidAccountOwnerError. That is either a
      // Token-2022 mint (decoded below) or some other program (unsupported => fail closed).
      if (err instanceof Error && err.name === 'TokenInvalidAccountOwnerError') return this.getToken2022Summary(mint);
      return { value: null, failure: classifyFetchError(err), asOfMs: Date.now() };
    }
  }

  async getBondingCurveAccounts(mint: string, summary: MintAccountSummary): Promise<FetchOutcome<CurveEvidence>> {
    try {
      const { curvePda, vaultAta } = deriveCurveAndVault(mint, summary.tokenProgram === 'token-2022' ? 'token-2022' : 'spl-token');
      const infos = await this.connection.getMultipleAccountsInfo([curvePda, vaultAta]);
      const raw = (a: { owner: PublicKey; data: Buffer | Uint8Array; lamports: number } | null | undefined): RawAccount | null => (a ? { owner: a.owner.toBase58(), data: a.data, lamports: a.lamports } : null);
      return { value: { curveAddress: curvePda.toBase58(), vaultAddress: vaultAta.toBase58(), curve: raw(infos[0]), vault: raw(infos[1]) }, failure: null, asOfMs: Date.now() };
    } catch (err) {
      return { value: null, failure: classifyFetchError(err), asOfMs: Date.now() };
    }
  }

  async getTokenAccountOwners(_mint: string, tokenAccounts: string[]): Promise<FetchOutcome<Record<string, string>>> {
    try {
      const infos = await this.connection.getMultipleAccountsInfo(tokenAccounts.map((a) => new PublicKey(a)));
      const owners: Record<string, string> = {};
      infos.forEach((info, i) => {
        if (info && info.data.length >= 64) owners[tokenAccounts[i] as string] = new PublicKey(info.data.subarray(32, 64)).toBase58();
      });
      return { value: owners, failure: null, asOfMs: Date.now() };
    } catch (err) {
      return { value: null, failure: classifyFetchError(err), asOfMs: Date.now() };
    }
  }

  /**
   * Token-2022 mint read: one getAccountInfo, owner must be exactly the Token-2022 program, then a strict decode. Any
   * decode problem is a TOKEN fact (`token2022_extension_data_malformed`), never a partial summary. The extensions are
   * evaluated by checks/token2022ExtensionCheck.ts; this function only reports what the chain says.
   */
  private async getToken2022Summary(mint: string): Promise<FetchOutcome<MintAccountSummary>> {
    try {
      const info = await this.connection.getAccountInfo(new PublicKey(mint));
      const asOfMs = Date.now();
      if (!info) return { value: null, failure: { kind: 'token', reason: 'account_not_found' }, asOfMs };
      if (info.owner.toBase58() !== TOKEN_2022_PROGRAM_ID_BASE58) return { value: null, failure: { kind: 'token', reason: 'unsupported_token_program' }, asOfMs };
      const parsed = parseToken2022Mint(info.data);
      if (!parsed.ok) return { value: null, failure: { kind: 'token', reason: 'token2022_extension_data_malformed' }, asOfMs };
      const m = parsed.mint;
      return {
        value: {
          mint,
          mintAuthority: m.mintAuthority,
          freezeAuthority: m.freezeAuthority,
          supply: m.supply,
          decimals: m.decimals,
          tokenProgram: 'token-2022',
          token2022: { extensions: m.extensions.map((e) => ({ id: e.id, name: e.name, data: e.data })) },
        },
        failure: null,
        asOfMs,
      };
    } catch (err) {
      return { value: null, failure: classifyFetchError(err), asOfMs: Date.now() };
    }
  }

  async getLargestHolders(mint: string): Promise<FetchOutcome<HolderBalance[]>> {
    try {
      const resp = await this.connection.getTokenLargestAccounts(new PublicKey(mint));
      return { value: resp.value.map((v) => ({ address: v.address.toBase58(), amount: BigInt(v.amount) })), failure: null, asOfMs: Date.now() };
    } catch (err) {
      return { value: null, failure: classifyFetchError(err), asOfMs: Date.now() };
    }
  }
}

/**
 * Short-lived reuse + in-flight deduplication of the two RPC reads the gate makes for every candidate. The gate runs
 * on every 2 s evaluation tick of a candidate token; without this it repeats identical mint and holder reads every
 * tick. `ttlMs` is capped at 10 s (the decision staleness bound); failures are never cached.
 */
export class CachedSafetyDataSource implements SafetyDataSource {
  private readonly mints: SingleFlightCache<FetchOutcome<MintAccountSummary>>;
  private readonly holders: SingleFlightCache<FetchOutcome<HolderBalance[]>>;
  private readonly curves: SingleFlightCache<FetchOutcome<CurveEvidence>>;
  private readonly owners: SingleFlightCache<FetchOutcome<Record<string, string>>>;

  constructor(
    private readonly inner: SafetyDataSource,
    opts: { ttlMs: number; now?: () => number; metrics?: ProviderMetrics },
  ) {
    const ttlMs = Math.min(opts.ttlMs, 10_000);
    const c = { ttlMs, maxAgeMs: 10_000, ...(opts.now ? { now: opts.now } : {}), ...(opts.metrics ? { metrics: opts.metrics, kind: 'rpc' as const } : {}) };
    this.mints = new SingleFlightCache(c);
    this.holders = new SingleFlightCache(c);
    this.curves = new SingleFlightCache(c);
    this.owners = new SingleFlightCache(c);
  }

  async getMintSummary(mint: string): Promise<FetchOutcome<MintAccountSummary>> {
    const timed = await this.mints.get(mint, () => this.inner.getMintSummary(mint), (o) => o.value !== null);
    if (!timed) return { value: null, failure: { kind: 'provider', reason: 'no_result' }, asOfMs: Date.now() };
    return timed.value.value !== null ? { ...timed.value, asOfMs: timed.fetchedAtMs } : timed.value;
  }

  async getLargestHolders(mint: string): Promise<FetchOutcome<HolderBalance[]>> {
    const timed = await this.holders.get(mint, () => this.inner.getLargestHolders(mint), (o) => o.value !== null);
    if (!timed) return { value: null, failure: { kind: 'provider', reason: 'no_result' }, asOfMs: Date.now() };
    return timed.value.value !== null ? { ...timed.value, asOfMs: timed.fetchedAtMs } : timed.value;
  }

  async getBondingCurveAccounts(mint: string, summary: MintAccountSummary): Promise<FetchOutcome<CurveEvidence>> {
    const timed = await this.curves.get(mint, () => this.inner.getBondingCurveAccounts(mint, summary), (o) => o.value !== null);
    if (!timed) return { value: null, failure: { kind: 'provider', reason: 'no_result' }, asOfMs: Date.now() };
    return timed.value.value !== null ? { ...timed.value, asOfMs: timed.fetchedAtMs } : timed.value;
  }

  async getTokenAccountOwners(mint: string, tokenAccounts: string[]): Promise<FetchOutcome<Record<string, string>>> {
    const timed = await this.owners.get(mint, () => this.inner.getTokenAccountOwners(mint, tokenAccounts), (o) => o.value !== null);
    if (!timed) return { value: null, failure: { kind: 'provider', reason: 'no_result' }, asOfMs: Date.now() };
    return timed.value.value !== null ? { ...timed.value, asOfMs: timed.fetchedAtMs } : timed.value;
  }
}
