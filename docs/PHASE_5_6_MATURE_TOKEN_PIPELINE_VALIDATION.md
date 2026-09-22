# Phase 5.6 — Mature-token trading pipeline validation

Legend used throughout: **[implementation]** = what the code does (verified by tests), **[measured]** = observed at runtime, **[limitation]**, **[observation]** = a strategy remark, not acted on.

## A. Objective

Prove that the deterministic pipeline
`discovery → market data → V1 filters → safety → expected net edge → entry → position → exit → PnL → ledger`
runs consistently in DRY_RUN / SHADOW on tokens that already have usable market data, and remove the one known dishonesty in it: the dry-run executor priced a **sell** with the **buy** impact. Nothing here optimizes for younger tokens or for the number of eligible tokens.

## B. Scope

Done: sell-side price impact (curve formula + Jupiter sell quote); fail-closed handling of every unavailable price/impact/amount; snapshot coherence and staleness checks; reproducible entry/exit context in the ledgers; no-look-ahead and security tests; a 55-minute read-only shadow/dry-run runtime run; one real bug found and fixed.
Not done (by instruction): ultra-young trading, native `CreateEvent` discovery, mayhem-mode support, new curve formulas for younger tokens, live trading, signing, Telegram, AI, parameter changes, commits.

## C. Market-data policy

- **[implementation]** Unchanged from 5.5: for a token discovered on Pump.fun and still on its curve the native snapshot is authoritative (single source, single watermark); DexScreener is used for graduated / non-Pump.fun tokens, and for a curve token only if `DEXSCREENER_FALLBACK_FOR_CURVE_TOKENS=true`. The native code is intact and read-only. No source "competes": when the native snapshot is VALID neither DexScreener nor Jupiter is called (asserted in tests: 0 base calls on entry and exit).
- **Why native stays primary for curve tokens even for "mature" ones:** DexScreener publishes no 1-minute volume, so on the DexScreener route V1 always fails `volume_1m_unavailable` (measured: all 4,347 DexScreener-route evaluations). Native events are the only 1m volume source available. This is a data-availability fact, not a preference for young tokens; the 30 s minimum age is untouched.

## D. Strategy parameters verified unchanged

**[implementation]** A test (`phase56.test.ts`, "strategy parameters and hard risk are unchanged") pins: min age 30 s, max age 15 min, liquidity ≥ 20, volume ≥ 5, buy/sell ≥ 1.5, velocity ≥ +1 %, acceleration ≥ 1.5, impact ≤ 1 %, quick TP 2–3 %, momentum TP 4–6 %, dynamic SL 2–3 %, hold timeout 30 s, slippage buffer 0.3 %, fee schedule (25 + 5 bps, 0.000005 + 0.0005 SOL, 50 bps margin), position 0.3 SOL, daily loss 10 %, 5 re-entries, 3 concurrent / 0.9 SOL exposure, 100 bps slippage/impact caps, `dryRun` true, live trading off. No threshold, exit rule, re-entry rule, risk parameter or emergency-stop logic was modified; the trailing / reversal / liquidity-deterioration exits are untouched code.

## E. Sell-side price impact

- **[implementation] Native curve** (`bondingCurveMath.ts`): `solOut = floor(t·vSol/(vTok+t))`, `sellImpact = 1 − (solOut/t)/(vSol/vTok) = t/(vTok+t)`, fees excluded, evaluated in exact bigint. It depends on the **token** reserve, whereas buy impact depends on the **SOL** reserve, so they differ: deterministic fixture, 0.3 SOL entry on the thinnest curve: buy 0.98765 %, sell of exactly those tokens 0.97800 %; on a 50 SOL curve 0.5926 % vs 0.5891 %. Returns `null` (fail closed) for nothing to sell, empty reserves, or a sale the curve cannot pay (proceeds > real SOL). Verified against **real on-chain sells**: `solOut` from the pre-trade state equals the event's `sol_amount` exactly.
- **[implementation] Jupiter market** (`MarketPriceSource.getSellPriceImpactPct`): a real token→SOL quote for the actual raw token amount (`getSellQuote` already existed; it is now used for exits).
- **[implementation] Plumbing:** `PriceSource` gained `getBuyExecutionQuote` (impact + raw tokens received) and `getSellPriceImpactPct`; `getEstimatedPriceImpactPct` is documented buy-only. The buy fill returns `tokenAmountRaw`; the position stores it (`entryTokenAmountRaw`); `SellParams.tokenAmountRaw` carries it to the sell. `NativeFirstPriceSource` prices a held amount with the exact curve sell formula on a valid curve and with Jupiter only for graduated/unobserved tokens.
- **[implementation] Fail closed:** dry-run buy with no impact → no fill (`buy_price_impact_unavailable`; the old `fallbackPriceImpactPct` default is no longer applied to buys or sells). Sell with unknown token amount → non-retryable failure; with no price or no sell impact → **retryable** failure (nothing executed). `PositionMonitor` keeps the position and retries for up to 60 s (data-quality bound, not a strategy parameter), then falls through to the existing `execution_safety_failure` + emergency stop. Shadow: a triggered exit without a sell impact is **deferred** (position stays open, counted `exit_deferred_sell_impact_unavailable`). Backtest replay: same deferral (`exitsDeferredSellImpactUnavailable`); it never fills with the buy figure.
- **[implementation] Shadow/backtest input:** each evaluation records `estimated_sell_price_impact_pct` — the sell impact of the entry-sized position at that instant (sell quote of exactly the tokens the entry would receive, or the curve formula). Exits in shadow/backtest use the figure recorded **at the exit tick**. **[limitation]** it is entry-sized, not the exact held amount (which differs by the few-percent price drift over a ≤ 30 s hold); the dry-run executor uses the actual held amount.
- **[limitation]** Historical evaluation rows written before Phase 5.6 have no sell impact; replaying them defers every exit.

## F. Expected-net-edge verification

- **[implementation]** `computeExpectedNetEdge` is unchanged and remains mandatory: tests assert it subtracts dex/swap fee, network + priority fee as % of size, slippage, price impact and safety margin (breakdown keys pinned), that an entry passing every baseline filter but with an unfavorable edge (impact 0.95 %) is **not** opened, and (structurally) that it is evaluated before `executor.buy`, `ledger.recordEntry` and `openPositions.set` in the production loop, shadow runner and replay.
- **[observation]** The formula counts one leg's costs (+ 0.5 % safety margin) while the simulator charges fees, slippage and impact on **both** legs. Example, impact 0.3 %: edge formula costs 1.58 % (favorable at a 2 % target: +0.42 %), simulated round-trip cost ≈ 2.17 %. Per instruction this was not changed; it is the first thing worth revisiting before any live decision.

## G. Shadow / pipeline architecture

- **[implementation]** Loop → one authoritative market snapshot → filters (fail closed on unavailable volume/ratio/impact) → snapshot coherence check (`snapshotCoherence.ts`: market data must be stamped within 10 s of the tick, quote within 10 s of market data; ≤ 10 s old at decision time) → safety gate → score → edge → risk → dry-run buy → ledger → `PositionMonitor` → sell with sell impact → ledger. The shadow runner consumes the same tick (never issuing its own requests) and re-runs filters/edge/risk on it.
- **[implementation] Reproducibility:** migration 006 (additive) stores, per trade (`trades` and `shadow_trades`): `entry_token_amount_raw`, `entry_context_json` (mint, discovery time, market source, market as-of / volume-window-end / state-event seconds, price, liquidity, volume, buy volume, sell volume, buy/sell ratio, velocity, acceleration, buy impact, sell impact, safety verdict, score, expected net edge + breakdown, decision, strategy version) and `exit_context_json` (reason, entry/exit price, sell impact, slippage, entry/exit fees, gross PnL = price move on the deployed size, net PnL). Evaluations also record sell impact and buy/sell volume.
- **[implementation] No look-ahead:** the shadow runner decides only from the current tick and its own past ticks; the replay engine appends one snapshot at a time before any decision. Tests: a great *future* tick changes nothing about an earlier decision (entry is recorded at the good tick, never retroactively); replaying a prefix yields byte-identical trades to replaying the full series; scrambling data after the decision leaves it unchanged.
- **Bug found and fixed (pre-existing):** the production loop recorded the entry trade **before** the evaluation row it references (`trades.entry_safety_check_id` → `token_evaluations.id`, foreign keys ON), so every real dry-run entry would have thrown `FOREIGN KEY constraint failed` after the simulated buy and never created a position. No earlier run ever entered a trade, so it was invisible. Found by the new production-loop lifecycle test; fixed by writing the evaluation first, then the trade, then `linkEvaluationToTrade`.

## H. Test results

- **[measured]** TypeScript: **533 tests pass across 65 files** (498 → 533: +35, of which 34 in `phase56.test.ts` and 1 production-loop lifecycle). Python: **242 pass**. Build, typecheck (`tsconfig.test.json`), lint clean; `git diff --check` clean.
- Existing tests were updated only where the behavior was intentionally changed by this phase, never weakened: the executor test that asserted "falls back to the configured impact" now asserts fail-closed; test stubs gained the two new `PriceSource` methods; the shadow/backtest fixtures now carry an independent sell impact and coherent timestamps (without them the exits/entries are — correctly — deferred/rejected); one lossless-adapter test lists the new `null` field.
- New coverage (11 requested areas): sell impact (fixtures, identity, real on-chain sells, null cases), buy vs sell direction (executor spies: a buy never asks for a sell figure; buy 0.1 % vs sell 0.9 % gives the lower fill), fee handling, expected net edge, timestamp coherence, stale data, missing data, fail-closed matrix (executor, monitor deferral and timeout, shadow, replay, baseline filters), complete shadow lifecycle with full context, no look-ahead, security isolation (shadow/backtest/volume code import no signer/keypair/secret provider/live executor and contain no sign/send calls; nothing in `src/` imports an LLM client), and the production-loop lifecycle.
- **Important scope note on the lifecycle test:** it uses the real loop, native curve market data (real-layout events), filters, edge, risk, dry-run executor, position monitor, ledgers and shadow runner, with **only the safety gate stubbed** (it needs live RPC + Jupiter). Its prices and PnL are synthetic and prove mechanics, not profitability.

## I. Live / shadow runtime results

**[measured]** One real run: `DRY_RUN=true`, shadow on, native + DexScreener/Jupiter (lite-api) + public mainnet RPC, ~55 min (13:13–14:08 local), Pump.fun creation discovery only (the Raydium detector was left out to leave RPC budget). Nothing was signed or sent.

**Where execution stopped:** at the **safety gate**. 18 tokens passed **all six** V1 baseline filters at least once (60 evaluations); every one of them was then rejected fail-closed by the gate because its checks could not obtain data from the public endpoints (`mint_account_unavailable` 126, `holder_data_unavailable` 93, `quote_unavailable` 65, `excessive_round_trip_loss` 22, `no_sell_route_found` 3) — i.e. 0 passed safety, hence 0 expected-edge evaluations, 0 entries, 0 positions, 0 exits in the live run. The complete lifecycle is therefore demonstrated only by tests, not by a live token.

## J. Filter statistics (thresholds unchanged; 166,631 evaluations, 697 tokens, before shutdown)

- Discovered tokens 697; tokens with usable market data (price + liquidity) **395** (56.7 %); evaluations with market data 92,298. Source: native 161,920 evaluations, DexScreener 4,347 (graduated tokens), none 364.
- Discovery → first evaluation: p50 31.5 s, p95 33.1 s, max 33.8 s (the 30 s age gate + 2 s poll).

| Filter (evaluations with data: 92,298) | pass | fail | unavailable | tokens that ever passed |
|---|---|---|---|---|
| liquidity ≥ 20 SOL (real) | 4,725 | 87,572 | 1 | 44 |
| volume1m ≥ 5 SOL | 6,085 | 81,866 | 4,347 | 177 |
| buy/sell ≥ 1.5 | 10,011 | 18,373 | 63,914 | 318 |
| velocity5s ≥ +1 % | 2,112 | 90,186 | 0 | 135 |
| acceleration ≥ 1.5x | 12,371 | 22,306 | 57,621 | 378 |
| price impact ≤ 1 % | 88,046 | 310 | 3,942 | 382 |

- All six pass in the same evaluation: **60 evaluations / 18 tokens** (e.g. real snapshot: liquidity 74.4 SOL, volume 76.6 SOL, ratio 1.88, velocity +68 %, acceleration 48x, buy impact 0.284 %, sell impact 0.282 %).
- Not evaluable (fail closed, reason recorded): mayhem-mode 58,552 evaluations / 245 tokens; non-SOL quote 13,754; no curve state yet 1,663; DexScreener route `volume_1m_unavailable` 4,347 and `price_impact_unavailable` 3,942 (Jupiter had no quote — this used to fall back to a default 1 % and pass).
- Safety rejection reasons: listed in section I. Expected-net-edge rejections: **none observed live** (no token reached it).

## K. Simulated trade statistics

**[measured]** Live run: 0 simulated buys, 0 positions, 0 sells. **No live PnL, fee, slippage, hold-time or exit-reason statistics exist.** The only numbers for those stages come from the deterministic tests (synthetic curve): an entry with edge > 0, a `quick_tp` exit, sell impact ≠ buy impact, net PnL < gross PnL — mechanics only.

## L. Exit statistics

None live (no position was opened). Tested exit paths: `quick_tp` through the real monitor and shadow runner; deferral when the sell cannot be priced; 60 s bound → safety failure + emergency stop; non-retryable failure closes immediately.

## M. PnL statistics

None live. Gross/net definitions implemented: gross = price move on the deployed size; net = realized fill − entry size (after fees, both impacts, slippage).

## N. Data-quality statistics (live, before shutdown)

Shadow data-quality events: `aggregator_error` 74,333 (warning, the unavailable-source ticks), `degenerate_ratio` 10,728 (warning; +Infinity buy/sell), `missing_quote` 3,938, `out_of_order_event` 151 (block), `impossible_price_change` 61 (reject), `stale_market_data` 17 (warning). Missed signals: `missing_market_data` 138,247 (ticks without a price/liquidity, none turned into zero). Native price/liquidity vs volume-window skew: 1 s on all 161,920 native rows (limit 5 s). Native coverage: 1 start, no break during the live period. Latency: market-data fetch p50 0 ms (native, in-process) / p95 1 ms / max 6.2 s (DexScreener path); Jupiter quote p50 1.1 s, p95 2.6 s; per-tick processing p50 3 ms, p95 7 ms; discovery latency p50 14.2 s (RPC creation detector, rate limited). 90,815 native trade events recorded.

**[limitation]** At shutdown the harness's `stop()` hung for > 4 minutes (the Pump.fun log unsubscription never resolved on the rate-limited endpoint) while evaluation timers kept running; those ticks correctly returned `native_stream_silent` (fail closed) and are excluded from the statistics above. The process had to be terminated. The same `source.stop()` path is used by the engine's normal shutdown.

## O. Security verification

**[implementation]** Architecture tests: shadow, backtest, volume, decision-context, coherence and source-policy code import no signer / keypair / secret provider / live executor / wallet module and contain no sign/send/simulate/`Keypair` calls; the shadow runner has no executor, signer, connection or fetch; no module under `src/` imports an LLM client, so no AI is on the BUY/SELL path; the dry-run executor builds no transaction. The runtime harness refuses to start unless `DRY_RUN=true` and live trading is off. No wallet, key or configuration was touched.

## P. Known limitations

- Live validation stopped at the safety gate (public RPC 429s and Jupiter rate limits); the downstream stages were not exercised on a live token.
- About 35 % of the new tokens (245 of 697 in the run) are mayhem-mode and unsupported; most young curves fail the 20 SOL real-liquidity filter — strategy outcomes.
- Shadow/backtest sell impact is entry-sized, not the held amount; pre-5.6 evaluation rows lack it.
- Jupiter sell quotes are only fetched when a position is open or the token passed the baseline filters (rate-limit economy), so recorded sell impact for DexScreener-route tokens is sparse.
- Public-endpoint dependence (RPC, Jupiter lite-api 429s); shutdown hang described above.
- `+Infinity` buy/sell and acceleration conventions from earlier phases are unchanged.

## Q. Remaining blockers before live execution

1. A dedicated RPC and quote provider so the safety gate can actually complete; then a live-token run that reaches entry, position and exit.
2. Reconcile the expected-net-edge formula (one leg) with the two-leg simulated cost (observation in F) — a strategy decision for the owner.
3. Exact held-amount sell impact in shadow/backtest, or a documented decision to keep the entry-sized reference.
4. Support (or an explicit exclusion policy) for mayhem-mode curves.
5. Fix the log-unsubscription shutdown hang; native `CreateEvent` discovery to remove the RPC bottleneck (explicitly out of scope here).
6. Everything a live executor needs (signing, broadcasting, slippage enforcement on-chain) does not exist and was not started.

## R. Exact files changed

New: `engine/src/orchestrator/{decisionContext,snapshotCoherence}.ts`, `engine/src/ledger/migrations/006_pipeline_validation.ts`, `engine/test/pipeline/{phase56,lifecycleLoop}.test.ts`, this document.
Source changed: `engine/src/volume/{bondingCurveMath,types,pumpfunVolumeEngine,boundedStructures,pumpfunVolumeService,recordedVolumeReplay}.ts`, `engine/src/execution/{types,marketPriceSource,dryRunExecutor}.ts`, `engine/src/orchestrator/{loop,positionMonitor,nativeFirst}.ts`, `engine/src/shadow/{types,shadowRunner,shadowLedger}.ts`, `engine/src/backtest/{types,snapshotAdapter,replayEngine}.ts`, `engine/src/ledger/{db,tradeLedger}.ts`, `engine/src/types/trade.ts`.
Tests changed (behavior-driven, none weakened): `test/execution/dryRunExecutor.test.ts`, `test/orchestrator/{shadowLoop,unitContractConsistency}.test.ts`, `test/volume/{integration,nativeMarket,nativeMarketLoop}.test.ts`, `test/shadow/fixtures.ts`, `test/backtest/{fixtures,cli.test,snapshotAdapter.test}.ts`.
Runtime harness and analysis scripts live outside the repository (session scratchpad).
