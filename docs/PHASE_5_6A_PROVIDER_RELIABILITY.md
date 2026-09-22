# Phase 5.6A — Dedicated RPC / Quote Provider Reliability

Labels: **[implementation]** what the code does · **[measured]** a number from a real run or command · **[limitation]** a known gap · **[observation]** an interpretation.
No claim below says a provider is "reliable" because unit tests pass; unit tests use scripted fake providers.

**Headline [measured]:** no dedicated provider credentials exist in this environment, and the public keyless Solana RPC does not serve `getTokenLargestAccounts` at all. The safety gate therefore still cannot pass any token here. That is the STOP condition "selected provider cannot support the required RPC method": it is reported, not worked around. Everything else (request discipline, quote path, coherence, fail-closed classification, bounded shutdown) is implemented and was run on mainnet in DRY_RUN.

## A. Objective
Make the existing safety gate reliably obtain the data it already requires, without changing any strategy threshold, safety semantics, or the DRY_RUN/no-signing posture. No AI, no live trading, no ultra-young-token, no CreateEvent discovery, no mayhem support.

## B. Existing provider architecture (audit, before rewriting)
- **[implementation, pre-5.6A]** RPC: one web3.js `Connection` built in `index.ts`, shared by discovery (`onLogs`, `getParsedTransaction`), the safety gate (`getMint`, `getTokenLargestAccounts`) and volume hooks. Jupiter: `JupiterQuoteClient` with a bare `fetch`, one timeout, **no retry, no rate limit, no backoff, no caching**.
- Safety-gate data dependencies: mint account (authorities, supply, decimals), largest holders, liquidity (aggregator), round-trip quote (buy + sell impact).
- **Findings:**
  1. Every 2 s evaluation tick of a candidate repeated identical mint + holder RPC reads and a fresh quote pair (duplicate requests, no dedup/cache).
  2. Provider failure and real token facts were indistinguishable: RPC errors were swallowed to `null`, and a failed sell-leg quote was reported as `no_sell_route_found` (a rate limit looked like an unsellable token).
  3. Discovery and safety shared one public RPC budget; web3.js additionally retries 429s on its own (uncoordinated).
  4. Public endpoints: `api.mainnet-beta.solana.com` (RPC) and `quote-api.jup.ag/v6` (quotes).
  5. Timeouts were per-request only; no overall budget; nothing was abortable on shutdown.

## C. Root cause of the public-provider failures
- **[measured]** `quote-api.jup.ag` **does not resolve in DNS** (`curl: (6) Could not resolve host`, this phase; already noted in Phase 5 docs). In the first Phase 5.6A run against that default: 368 quote attempts, 0 successes, 367 network errors. This was the dominant cause of `quote_unavailable` / `no_sell_route_found` in Phase 5.6. `lite-api.jup.ag/swap/v1` answers keyless.
- **[measured]** `getTokenLargestAccounts` on `api.mainnet-beta.solana.com` is answered with HTTP 429 and `x-ratelimit-method-limit: 0` (limit 0 = never served); publicnode blocks it. Holder data is structurally unavailable on keyless public RPC, independent of request rate.
- **[measured]** Many "mint unavailable" results are **Token-2022 mints** (owner `TokenzQd…`, verified by direct `getAccountInfo`). The existing `getMint` call only accepts classic SPL mints. This is fail-closed and correct; only its label was misleading (now `unsupported_token_program`).
- **[measured]** Public RPC timeouts: 62–65 of ~250 attempts (~25%) hit the 4 s bound.

## D. Provider configuration
- **[implementation]** Env only, nothing hard-coded: `SOLANA_RPC_URL`, `SOLANA_RPC_WS_URL`, `SOLANA_RPC_API_KEY`, `SOLANA_RPC_FALLBACK_URLS`, `SOLANA_RPC_TIMEOUT_MS|MAX_RPS|MAX_CONCURRENT|MAX_RETRIES`; `JUPITER_BASE_URL`, `JUPITER_API_KEY`, `JUPITER_FALLBACK_URLS`, `JUPITER_TIMEOUT_MS|MAX_RPS|MAX_CONCURRENT|MAX_RETRIES|QUOTE_CACHE_TTL_MS`. Older `RPC_HTTP_URL`/`RPC_WS_URL`/`JUPITER_QUOTE_BASE_URL` still work. Tuning lives in `providers.*` in `config/schema.ts` (defaults: RPC 8 rps / 4 concurrent / 4 s timeout / 2 retries / 8 s total; quote 4 rps).
- **[implementation]** API keys are sent as an `x-api-key` header, never appended to the URL. Fallbacks exist only if listed; with none configured there is no fallback.
- **[implementation]** The default Jupiter base URL changed from `quote-api.jup.ag/v6` to `lite-api.jup.ag/swap/v1` (a resolvable keyless endpoint). This is endpoint configuration, not a strategy value.
- `TTL` settings are schema-capped at 10 s.

## E. RPC implementation
- **[implementation]** `providers/providerGate.ts` wraps all RPC HTTP through a custom `fetch` handed to `Connection` (`providers/providerStack.ts`, `disableRetryOnRateLimit: true` so web3's own 429 retry cannot multiply load). `safety/dataSource.ts` adds `DirectSafetyDataSource` (`getMint`, `getTokenLargestAccounts`) and `CachedSafetyDataSource`; each result is `FetchOutcome{value, failure{kind: provider|token, reason}, asOfMs}`.
- Methods covered through the same gate: account/mint info, largest accounts, parsed transactions, slot, log subscription bookkeeping (WebSocket subscriptions themselves are not HTTP).
- **[limitation]** The websocket is not routed through the gate.

## F. Quote-provider implementation
- **[implementation]** `JupiterQuoteClient` on the quote gate. BUY = SOL→token for the requested SOL amount (raw tokens out, price impact %, route, fees via existing edge model). SELL = token→SOL for the **actual held raw amount**. Round trip: sell leg uses the raw amount returned by the buy leg; sell impact is the sell quote's own value — never the buy impact, never a default 1%, never amount/liquidity.
- `getQuoteDetailed` distinguishes `ok`, `no_route` (provider answered: token fact → `sellPriceImpactPct: null`) and `unavailable` (provider could not answer → whole round trip `null` → `quote_unavailable`). A rate limit is no longer reported as `no_sell_route_found`.
- Every quote carries `fetchedAtMs`, `provider` (host), `cached`.

## G. Rate limiting
- **[implementation]** Per-endpoint request spacing (rps), concurrency bound, per-attempt timeout, overall time budget, per-endpoint circuit breaker (opens after N consecutive failures, cooldown, half-open retry), structural "method unsupported" memory (429 with method limit 0, or 403) that is neither retried nor allowed to trip the circuit for other methods.

## H. Retry behavior
- **[implementation]** ≤ `maxRetries` retries, exponential backoff with jitter; `Retry-After` honored (a wait beyond the remaining budget is not taken); 5xx and network errors retry; other 4xx are treated as an answer. Each endpoint is tried at most once per logical request when falling back. No retry starts after shutdown.

## I. Caching / deduplication
- **[implementation]** `SingleFlightCache`: identical in-flight requests share one call; successes reused ≤ TTL (≤ 10 s, quotes default 2 s, mint/holders default 10 s cap); **failures never cached**; "no route" answers are not reused; the original as-of time travels with the value (caching never refreshes a timestamp). Mint/holder data is cached at most 10 s and never past the decision bound.
- **[measured, run 2]** RPC: 9 cache hits / 47 misses; quote: 278 hits, 94 in-flight dedups vs 782 logical requests.

## J. Timestamp / coherence handling
- **[implementation]** Existing rules unchanged (`MAX_SNAPSHOT_SKEW_MS`, `MAX_MARKET_DATA_AGE_AT_DECISION_MS` = 10 s). New: stale quotes (older than 10 s) are treated as unavailable in `MarketPriceSource`; the safety result carries `dataAsOfMs` (oldest of mint, holders, round-trip quote); the loop adds the fail-closed reason `stale_safety_data_at_decision` if it is older than 10 s at decision time. Existing reason strings are unchanged; this only adds a reason.
- Fallback answers are timestamped with the answering host; nothing silently mixes providers beyond the 10 s rule.

## K. Shutdown fix
- **[implementation]** Root cause (Phase 5.6): `removeOnLogsListener` on a rate-limited websocket never resolved and `stop()` awaited it forever. Now: `lifecycle/shutdown.ts` (`runBounded`, `runShutdown`) bounds each step; both log subscribers race the unsubscribe against `stopTimeoutMs` (3 s) and ignore logs after `stop()`; `stopOrchestrator` first stops evaluation timers and the position monitor, refuses new evaluations, then stops sources with a bound; `index.ts` runs orchestrator stop → abort provider requests → stop volume service → flush provider metrics → close ledger, each bounded.
- **[measured]** Two 15-minute mainnet runs shut down in **252 ms** and **195 ms**, every step `ok`. **[limitation]** The exact Phase 5.6 hang (a stalled unsubscribe on the live websocket) did not recur, so the live run does not itself prove the fix; the regression tests reproduce it with a connection whose unsubscribe never resolves.

## L. Security
- **[implementation]** `providers/redact.ts`: only scheme+host is ever logged; registered secrets and credential patterns are scrubbed; the logger also redacts `apiKey`-named fields; metrics hold counters only.
- **[measured]** Greps of the new code found no signer/keypair/send/sign symbols and no LLM references. `DRY_RUN` default true; live trading remains disabled; architecture test green.

## M. Test results
- **[measured]** TypeScript: 71 files / **589 tests pass** (baseline before this phase 533 / 65). Python: **242 pass**. `tsc --noEmit`, `eslint .`, `npm run build` clean. `git diff --check` exit 0 (only LF→CRLF notices).
- New tests (`test/providers/*`, `test/pipeline/providerLoop.test.ts`): dedicated RPC and quote config, timeouts, RPC 429, quote 429, Retry-After, bounded retry, cache, dedup, stale-quote rejection, coherence/`stale_safety_data_at_decision`, fallback, provider failure → fail closed, no default impact, BUY/SELL quotes, held-amount sell, shutdown (plain / pending RPC / pending quote / pending concurrency waits / hung unsubscribe / orchestrator with hung source), secret leakage, safety-semantics via the real gate, production-loop integration. No existing test was weakened or deleted.
- The loop integration test uses the REAL safety gate with scripted data providers and a **synthetic** bonding curve; it proves wiring only, not a mainnet result.

## N. Mainnet DRY_RUN results
Two 15-minute runs, read-only, `DRY_RUN=true`, shadow on, only the Pump.fun creation subscriber (as in Phase 5.6), normal production loop, no wallet/signer/broadcast. Endpoints: public keyless (`api.mainnet-beta.solana.com`; run 1 `quote-api.jup.ag`, run 2 `lite-api.jup.ag`). **No dedicated credentials were available.**

| | Phase 5.6 (58.6 min) | 5.6A run 1 (14.5 min) | 5.6A run 2 (14.5 min) |
|---|---|---|---|
| tokens discovered | ~705 | 159 | 142 |
| tokens with usable market data | 395 | 59 | 69 |
| evaluations | 179,297 | 35,155 | 34,271 |
| tokens passing all 6 baseline filters | 18 | 4 | 4 |
| evaluations reaching safety | n/a | 45 | 41 |
| mint read succeeded | — | 0 | 15 |
| holder data | unavailable | unavailable | unavailable (15 provider:unsupported, rest gated by mint) |
| buy/sell round-trip quote | mostly failing | 0 of 1002 requests succeeded (DNS) | 319 of 529 attempts ok |
| `excessive_round_trip_loss` (real quote result) | 22 | 0 | 26 |
| `quote_unavailable` | many | 45 | 8 |
| `no_sell_route_found` | 3 | 0 | 0 |
| safety passes | 0 | 0 | 0 |
| simulated entries / exits / PnL | 0 | 0 | 0 |

**Where it stopped [measured]:** Discovery → market data → V1 filters worked. 4 tokens per run passed all baseline filters; 41–45 evaluations reached the safety gate; safety failed on holder data (structurally unavailable on the keyless RPC), mint data (Token-2022 or RPC timeout), and, once quotes worked, on the real `excessive_round_trip_loss` result. No token reached Edge → Simulated BUY → Position → SELL → PnL in the real runtime. The end-to-end path after safety is exercised only by the synthetic test and the Phase 5.6 lifecycle test; **no real end-to-end trade is claimed.** No filter was relaxed, safety was not stubbed, no token was hand-picked.

## O. Provider metrics (run 2, final snapshot) [measured]
- RPC (`api.mainnet-beta.solana.com`): 243 logical / 245 attempts, 181 ok, 64 failed (62 timeouts, 2×429), 32 retries, 1 method-unsupported, circuit opened 7×; latency mean 395 ms, p50 67 ms, p95 2,064 ms, max 4,276 ms; fallback used 0.
- Quote (`lite-api.jup.ag`): 782 logical (463 failed), 529 attempts, 319 ok, **210×429**, 0 timeouts, 140 retries, circuit opened 16×; latency mean 597 ms, p50 99 ms, p95 2,109 ms; cache hits 278, dedup 94; fallback 0.
- Safety-unavailable reasons: `mint:token:unsupported_token_program` 26, `holders:provider:unsupported` 15, `quote:provider_or_route:quote_unavailable` 8. Stale-data rejections: 0. Coherence rejections: none observed. Snapshots are persisted in `provider_metrics_snapshots` (migration 007) and logged each minute.

## P. Comparison with Phase 5.6
- **[measured]** The dominant, fixable cause of quote failure was a dead default host; with the resolvable endpoint, ~60% of quote attempts succeed keyless, and real sell-impact results replaced "unavailable" ones. Requests are deduplicated/cached, rate-limited and bounded; 429s are honored; failures are classified provider vs token; shutdown is bounded.
- **[observation]** Runs are shorter than Phase 5.6 (14.5 vs 58.6 min) and market conditions differ, so funnel counts are not comparable one-to-one. Per-minute discovery (≈10 tokens/min) is in the same range as Phase 5.6 (≈12/min). Do not read 0 safety passes as evidence about the strategy.
- **[measured]** No improvement in holder data: unchanged, because it is a provider capability limit, not a rate-limit problem.

## Q. Remaining limitations
1. **Blocker:** a provider that serves `getTokenLargestAccounts` (a dedicated/credentialed RPC) must be supplied through `SOLANA_RPC_URL`/`SOLANA_RPC_API_KEY`. Until then the gate fails closed on every token. Code and tests for the dedicated path are covered only with scripted fakes; **it has not been exercised against a real dedicated provider.**
2. Keyless `lite-api.jup.ag` returns 429 for ~40% of attempts at 4 rps; a keyed plan or lower rate is needed for steady use.
3. Public RPC times out ~25% of requests at 4 s.
4. Token-2022 mints are not supported by the existing mint read (fail closed; not changed: mayhem/Token-2022 support is out of scope).
5. The websocket is outside the gate; multi-provider fallback was verified only in unit tests.
6. Live proof of the shutdown fix rests on the regression tests (see K).

## R. Exact files changed
Modified: `engine/.env.example`, `engine/src/config/loader.ts`, `engine/src/config/schema.ts`, `engine/src/discovery/pumpFunLogSubscriber.ts`, `engine/src/discovery/raydiumLogSubscriber.ts`, `engine/src/execution/jupiterQuoteClient.ts`, `engine/src/execution/marketPriceSource.ts`, `engine/src/index.ts`, `engine/src/ledger/db.ts`, `engine/src/orchestrator/loop.ts`, `engine/src/safety/safetyGate.ts`, `engine/src/safety/types.ts`, `engine/src/types/market.ts`.
Created: `engine/src/providers/{providerGate,providerMetrics,providerStack,singleFlightCache,metricsRecorder,redact}.ts`, `engine/src/lifecycle/shutdown.ts`, `engine/src/safety/dataSource.ts`, `engine/src/ledger/migrations/007_provider_metrics.ts`, `engine/test/providers/{helpers,providerGate,cache,quoteClient,shutdown,configAndSecrets}(.test).ts`, `engine/test/pipeline/providerLoop.test.ts`, this document.
No V1 threshold, hard-risk value, safety reason string or signer file was modified. Nothing was committed.
