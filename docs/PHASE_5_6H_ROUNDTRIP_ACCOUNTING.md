# Phase 5.6H — Correct Round-Trip Fee Accounting + Shadow Price-Path Instrumentation

Accounting/instrumentation only. DRY_RUN throughout; no live executor, signer or transaction exists anywhere in this
change. The 2.5% round-trip rule, TP/SL, position size (0.3 SOL), entry filters, daily loss limit, re-entry rules,
holder policy, Token-2022 policy and Jupiter rate limits are unchanged — see §6/§8 for the exact proof. Nothing was
committed.

## 1. The bug this phase fixes

Phase 5.6G (`docs/PHASE_5_6G_ROUNDTRIP_COST_INVESTIGATION.md`) found that neither the simulator nor the
expected-net-edge formula contained the Pump.fun curve's own fee (measured: protocol 95 bps + creator 30 bps = 125
bps per leg, 97% of tokens), and that the edge formula only counted **one** leg while the simulator counted a generic
**25+5 bps** for **both**. Across the 5 previously recorded trades this overstated PnL by 1.28–1.37 points per trade
(simulator +0.045 SOL vs. exact +0.025 SOL for the same trades).

## 2. Files changed

**New shared accounting core**
- [engine/src/execution/fillSimulation.ts](../engine/src/execution/fillSimulation.ts) — rewritten. `simulateBuyFill` /
  `simulateSellFill` (per-leg, venue-fee-aware) and `estimateRoundTrip` (complete round trip: buy, then sell the
  tokens actually held) are the one place either fee model is priced. `simulateFill` / `computeTradeFees` are kept
  as the legacy flat-model helpers a few call sites still use directly.
- [engine/src/scoring/expectedNetEdge.ts](../engine/src/scoring/expectedNetEdge.ts) — rewritten to call
  `estimateRoundTrip` instead of its own one-leg formula; fails closed (`netEdgePct: -Infinity`) when the sell impact
  or position size is unavailable instead of guessing.
- [engine/src/types/signals.ts](../engine/src/types/signals.ts) — `EdgeInputs` gained `sellPriceImpactPct`,
  `venueFeeBps`; `EdgeResult` gained `feeModel`, `feeBpsPerLeg`, `roundTripCostPct`, `unavailableReason`.

**Venue fee plumbing (so both legs use the token's real fee when it is known)**
- [engine/src/execution/types.ts](../engine/src/execution/types.ts) — `PriceSource.getVenueFeeBps?`,
  `ExecutionQuote.venueFeeBps?`, `FillResult.venueFeeBps` / `feeModel`.
- [engine/src/orchestrator/nativeFirst.ts](../engine/src/orchestrator/nativeFirst.ts) — `nativeVenueFeeBps()` reads
  `protocol + creator` bps straight from the curve state already carried by the native snapshot;
  `NativeFirstPriceSource.getVenueFeeBps` / `getBuyExecutionQuote` expose it.
- [engine/src/execution/dryRunExecutor.ts](../engine/src/execution/dryRunExecutor.ts) — buy/sell now call
  `simulateBuyFill` / `simulateSellFill` with the quote's / `getVenueFeeBps`'s value.
- [engine/src/shadow/shadowRunner.ts](../engine/src/shadow/shadowRunner.ts),
  [engine/src/backtest/replayEngine.ts](../engine/src/backtest/replayEngine.ts) — same migration for the shadow and
  replay fills; the SELL leg falls back to the fee the ENTRY was priced with when a later tick/snapshot carries no
  venue fee of its own, so one trade's two legs are never priced on two different fee assumptions.
- [engine/src/orchestrator/loop.ts](../engine/src/orchestrator/loop.ts) — the edge call now passes
  `sellPriceImpactPct` (fetched once, only for a candidate that already passed the entry score) and `venueFeeBps`;
  the shadow tick gains the same fields.
- [engine/src/shadow/types.ts](../engine/src/shadow/types.ts), [engine/src/backtest/types.ts](../engine/src/backtest/types.ts) —
  additive `venueFeeBps?` on `ShadowMarketTick` / `HistoricalMarketSnapshot`.
- [engine/src/orchestrator/decisionContext.ts](../engine/src/orchestrator/decisionContext.ts) — `buildEntryContext` /
  `buildExitContext` gained an additive fee-accounting block (`feeModel`, `feeBps`, per-leg venue fee / fixed cost /
  impact / slippage in SOL) so a trade's stored context shows exactly what it was priced with; existing fields
  untouched.
- Simulator version labels bumped so old and new results are distinguishable:
  `shadow-realtime-v1` → `v2` ([activation.ts](../engine/src/shadow/activation.ts)),
  `backtest-replay-v1` → `v2` ([backtest/types.ts](../engine/src/backtest/types.ts)).

**Shadow price-path instrumentation (read-only, additive)**
- [engine/src/ledger/migrations/008_price_paths.ts](../engine/src/ledger/migrations/008_price_paths.ts) — two new
  tables, `trade_price_paths` (one row per scheduled offset + one exit row) and `trade_path_metrics` (one row per
  trade); wired into [engine/src/ledger/db.ts](../engine/src/ledger/db.ts). No existing table is touched.
- [engine/src/shadow/pricePath.ts](../engine/src/shadow/pricePath.ts) — `PricePathRecorder`: after a shadow entry,
  schedules observations at +1/2/3/5/10/15/30 s (`DEFAULT_PATH_OFFSETS_MS`) read from the native in-memory cache only
  (`NativePathObserver`, no RPC/HTTP, no extra trading transaction); computes MFE, MAE, max gross move, max exact-net
  move and their times, holding time, and the exact net PnL of each observation via `simulateSellFill` (the same
  primitive the simulator uses) using the entry's **actual held token amount**. A missing observation is stored with
  a status and reason and null values — never interpolated, never counted as a favorable move. Every entry point
  (`startTrade`, `recordExit`, `stop`, the timer callback) is wrapped so a failure here can never throw into trading
  code; timers are injectable (`PricePathScheduler`) and unref'd/cancelled on shutdown.
- [engine/src/shadow/activation.ts](../engine/src/shadow/activation.ts) — builds the recorder only when a native
  market cache is supplied, wires it to the shadow runner through a new, best-effort `ShadowLifecycleListener`
  (`onEntry` / `onExit`) whose exceptions are swallowed and whose return value is never read.
- [engine/src/shadow/shadowRunner.ts](../engine/src/shadow/shadowRunner.ts) — calls the (optional) lifecycle listener
  **after** a trade is already recorded, from values the decision already used; the listener cannot alter the
  outcome (proven in `test/shadow/pricePath.test.ts`, "instrumentation cannot influence trading decisions").
- [engine/src/index.ts](../engine/src/index.ts) — wires `NativePathObserver` into `createShadowActivation` when
  native market data is enabled, and stops the recorder as its own bounded shutdown step.

## 3. The fee model (source, unchanged from 5.6G, now actually used by both legs)

| | |
|---|---|
| Fee per leg when the venue fee is known | curve's own `feeBasisPoints + creatorFeeBasisPoints`, carried on every recorded `TradeEvent` (95+30=125 bps measured for 97% of tokens) — read from the native snapshot's `curve` field, never invented |
| BUY | fee charged **on top** of the spend: `venueFeeSol = spend·rate/(1+rate)` |
| SELL | fee **deducted from proceeds**: `venueFeeSol = proceeds·rate` (proceeds = gross value after sell-direction price impact) |
| No venue fee known (non-curve / off-curve token, replay snapshot without curve data) | `configured_flat`: the existing `dexFeeBps + swapFeeBps` on the leg's gross value, i.e. exactly the pre-5.6H generic model — nothing new is invented, the two models simply never mix on one trade |
| Fee tiers | not hard-coded: `resolveFeeModel()` takes whatever `venueFeeBps` the caller passes (95, 125, 395, …); tested at all three |

`estimateRoundTrip` composes the two legs: `netPnlSol = grossMoveSol − buyCostSol − sellCostSol`, asserted as an
identity in tests over a grid of fee tiers, price ratios, impacts and slippage.

## 4. Before / after accounting behaviour

| | before 5.6H | after 5.6H |
|---|---|---|
| Simulator fee | generic 30 bps/leg, no venue fee | curve's own 125 bps/leg when known, else the same generic model |
| Edge formula | **one** leg's costs | **complete round trip** (both legs), via the same `estimateRoundTrip` the simulator uses |
| Simulator vs. edge | independent formulas, provably diverging (5.6G) | edge = simulator's `netPnlPct` − `safetyMarginBps/100`, asserted equal in tests to 1e-9 |
| SELL leg's fee base | n/a (fee didn't exist) | charged on **post-impact proceeds**, never the pre-impact value (tested; a mutation of this line breaks a test) |
| Quick-TP (2%) favorability at the default cost schedule | favorable (old one-leg formula: `2 − 0.25 − 0.05 − 0.34 − 0.3 − 0.5 = +0.56%`) | **unfavorable** (`test/execution/roundTripAccounting.test.ts`, "the corrected edge no longer overstates profitability") |

## 5. Tests added (all in the areas the task specified)

`engine/test/execution/roundTripAccounting.test.ts` (25 tests): 125 bps BUY fee charged on top; 125 bps SELL fee
deducted from proceeds *after* impact (mutation-tested — flipping the base to pre-impact proceeds fails a test);
both fees in one round trip (2.47% floor); network+priority exactly once per leg; fee tiers 95/125/395 bps and their
strict ordering; venue fee `0` treated as a real fee vs. `null`/`NaN`/negative/`Infinity` falling back to the
generic model; no mixed assumptions (raising the generic bps while a venue fee is set changes nothing); the flat
model reproduces the legacy `simulateFill` exactly; the round-trip identity over a fee×move×impact×slippage grid;
edge = simulator round trip at every gross-move level tested; `DryRunExecutor` buy+sell agree with the edge formula
end-to-end; SELL uses the **actual held token amount** (asserted via the exact string passed to
`getSellPriceImpactPct`); a source with no venue fee prices both legs with the generic model; fail-closed on missing
sell impact / position size; the 2.5% gate's own source line and its two components are unchanged; TP/SL/hold-time/
cost-schedule config values are unchanged; **regression fixtures for the 5 previously recorded trades**
(`test/execution/fixtures/recordedTrades.ts`, extracted read-only from the Phase 5.6G run ledgers, on-chain reserves
+ fee bps at entry and exit) — each trade's new simulated PnL matches the exact on-chain curve accounting to within
0.00015 SOL, and the discrepancy the old simulator had (0.0035–0.0044 SOL, i.e. the same 1.28–1.37 points from 5.6G)
is asserted directly against the old recorded value, so it cannot silently return.

`engine/test/shadow/pricePath.test.ts` (19 tests): `computePathMetrics` (MFE/MAE/max-move and their times from
observed points only; a path that never rose has MFE 0 and no time-to-MFE; missing/after-exit/interrupted points
contribute nothing; net-positive is true/false/null correctly); the recorder's schedule (exact 7 offsets, entry
snapshot stored, completion); a missing observation stored with reason and nulls, never interpolated; an observer
that throws yields `observer_error`, never a crash or a value; exact net PnL uses the simulator's sell leg with the
actual held tokens; net PnL is null with a reason when the sell impact is unavailable while gross move is still
recorded; SELL fee falls back to the entry's fee model when a tick carries none; early exit (offsets after the exit
marked `after_exit`, timers cancelled, metrics finalized); exit after a complete path; shutdown (timers cancelled,
remaining offsets `interrupted`, no further observation ever happens); `NativePathObserver` against a real curve
fixture (price, liquidity, fee, exact sell impact of the held amount) and its unavailable/missing-amount cases;
**instrumentation cannot influence trading decisions** (a throwing listener and a working listener both produce
byte-identical outcomes/trades to a runner with no listener at all); an end-to-end shadow entry → scheduled
observations → shadow exit → finalized `trade_path_metrics` row.

Existing tests updated (all intentional, all documented at the change site):
- `test/scoring/expectedNetEdge.test.ts` — inputs now include `sellPriceImpactPct` (the edge needs the complete
  round trip).
- `test/pipeline/phase56.test.ts` — the "subtracts every configured cost" test now asserts BOTH legs' costs and
  the edge/`estimateRoundTrip` equality, with the corrected breakdown key set.
- `test/shadow/fixtures.ts`, `test/backtest/fixtures.ts` — the shared lifecycle fixtures now use a **cost-free**
  `edge` block, with a comment explaining why: the complete-round-trip edge means a 2% quick-TP move is genuinely
  unfavorable at the production cost schedule (correct — proven in §4), so the fixtures that test entry/exit/risk
  *mechanics* (not the cost schedule itself) needed the cost schedule zeroed out to keep opening positions; the cost
  schedule itself is exercised for real in `roundTripAccounting.test.ts` and the tests below.
- `test/backtest/replayEngine.test.ts`, `test/backtest/cli.test.ts` — two tests needed the real cost schedule (fee
  regression / non-zero fees on a flat-price hold); their strategy's expected move was raised so the entry gate still
  opens under the real schedule (never the round-trip policy itself, which stayed untouched).
- `test/pipeline/{lifecycleLoop,providerLoop,entryRace}.test.ts` — raised the strategy's TP levels for the same
  reason (these tests use the real `getDefaultConfig()` cost schedule, unlike the shared shadow/backtest fixtures).

## 6. Full validation

- `npx tsc --noEmit -p .` — clean.
- `npm run typecheck` (`tsc -p tsconfig.test.json`) — clean.
- `npm run build` (`tsc -p tsconfig.json`) — clean.
- `npx eslint .` — clean (no new rule exceptions; the shadow-isolation / hard-risk-isolation rules still pass, since
  `pricePath.ts` imports nothing from `execution/signer/**`).
- `npx vitest run` (full engine suite): **743 tests, 743 passing**. One run under heavy concurrent load (this
  session's own DRY_RUN validation script running at the same time) flagged 2 unrelated, pre-existing
  timing-sensitive tests (`entryRace.test.ts`'s concurrency assertions and the real-Windows-DPAPI round-trip test,
  neither touched by this phase) — both pass cleanly in isolation (confirmed twice) and are CPU/timing-budget
  sensitive by design, not a regression from this change.
- `python -m pytest` (full python suite): **242 tests, 242 passing**, unchanged (the schema contract only asserts
  the `expected_net_edge_breakdown` column exists, not its keys, so no python change was needed).
- `git diff --check` — clean.

**2.5% rule / other policy values, verified unchanged:**
- `src/safety/safetyGate.ts` still computes the bound as `cfg.edge.safetyMarginBps / 100 + cfg.filters.maxPriceImpactPct * 2`
  (source line asserted verbatim in `roundTripAccounting.test.ts`) = `0.5 + 2×1.0 = 2.5%`.
- `cfg.exits`: quickTp 2–3%, momentumTp 4–6%, maxHoldTimeSec 30 — unchanged.
- `cfg.edge`: dexFeeBps 25, swapFeeBps 5, networkFeeSol 0.000005, priorityFeeSol 0.0005, safetyMarginBps 50 — unchanged
  (these are the *inputs* the corrected formula now uses **correctly**, not new values).
- `HARD_RISK_PARAMETERS.positionSizeSol` = 0.3 SOL, daily loss limit, re-entry, max concurrent positions — untouched
  (not imported by anything this phase changed).
- Holder policy, Token-2022 policy, Jupiter rate-limit config: not imported or referenced by any file this phase
  changed.
- No file under `execution/signer/**`, `execution/liveExecutorStub.ts` or `LiveExecutor` was touched; `DRY_RUN`
  default and the `dryRun`/`liveTradingExplicitlyEnabled` guards are unchanged.

## 7. DRY_RUN/shadow validation run

Real mainnet market data, `DRY_RUN=true`, `SHADOW_TRADING_ENABLED=true`, a scratch ledger (not
`data/ledger.sqlite`), `engine/.env` read but not modified, `SOLANA_RPC_WS_URL` overridden empty (public WS, per the
Phase 5.6 findings), `JUPITER_MAX_RPS=0.5`/`JUPITER_MAX_RETRIES=0`. 15 minutes + a 144 ms clean shutdown (every step
reported `ok`, including the new `stop_price_paths` step).

**A/B — fee accounting and simulator/edge consistency.** No live candidate reached the edge computation in this
particular window (§C), so these are reported from the deterministic regression suite instead, which is the exact
and reproducible source of truth the live run cannot improve on:
- BUY fee (125 bps tier, 0.3 SOL): 0.003704 SOL (`0.3 × 0.0125/1.0125`).
- SELL fee (125 bps tier, same size, 0% net move): 0.003656 SOL.
- Total round-trip fee: 0.007360 SOL (2.469% of position) — the 2.47% fee floor from 5.6G.
- Network+priority, both legs: 0.001010 SOL (0.337%).
- Exact round-trip cost at a 0% move: 2.806% — matches the 5.6G "pure round trip" figure to 3 decimal places.
- Simulator vs. edge: identical by construction (`edge.netEdgePct == roundTrip.netPnlPct − safetyMarginBps/100` to
  1e-9, `roundTripAccounting.test.ts`); no divergence exists to report a "difference" for.

**C — shadow price paths.** **Zero** shadow entries in this window ⇒ zero `trade_price_paths` / `trade_path_metrics`
rows. Reported honestly rather than fabricated: of 35,621 evaluations (169 distinct tokens), **0 passed the safety
gate** (`safety_passed=1` count: 0), so nothing reached entry scoring or the edge computation at all. The provider
metrics recorded for this window explain why: Helius RPC 90/340 requests timed out (26%), Jupiter quotes 74/247
timed out (30%), the client-side circuit breaker opened 17 times on the quote endpoint (`circuitSkipped: 483`) —
this environment's network conditions this window, not the accounting change (nothing in this phase touches
discovery, safety, or provider request logic). The price-path recorder itself, its scheduling, its data-quality
handling and its non-interference with decisions are fully covered by the 19 deterministic tests in
`pricePath.test.ts` instead (fake timers, no live dependency).

**D — existing policy behaviour.** 0 evaluations reached the round-trip rule in this window (consistent with C: none
passed safety, so risk/edge were never reached) — **0 rejected, 0 passing**, and this is exactly what "the 2.5% rule
was not touched" predicts when nothing gets far enough to be evaluated by it. Confirmed unchanged directly at the
source (§6) rather than inferred from live rejection counts.

**E — safety.** `DRY_RUN=true` throughout (asserted at harness startup, refuses to run otherwise);
`SHADOW_MODE=READ_ONLY` logged; no `LiveExecutor`/broadcast/signer path exists or was added; shutdown completed
every step `ok`; the one log line after shutdown (`token evaluation tick failed unexpectedly: database is not open`)
is an in-flight tick racing the deliberately-fast harness shutdown in this scratch script, not a live-trading
concern — it wrote nothing (DB already closed) and no position was ever open.

## 8. Data-quality limitations

- The live validation window happened to have 0 evaluations reach the safety gate (network-condition dependent, see
  §7C); it therefore adds no NEW live evidence to A/B/C/D beyond what the regression suite already proves
  deterministically. A longer or later run, under better network conditions, would be needed to populate live MFE/MAE
  distributions — nothing in this phase prevents that; the instrumentation is ready and fully tested.
- The regression fixtures (§5) reconstruct 5 trades' entry/exit curve state from previously recorded `TradeEvent`
  rows, matched to within 0.00015 SOL of the exact on-chain math (the residual is the entry-leg fixed-cost
  convention noted in 5.6G, not a bug).
- Price-path observations depend entirely on the native in-memory cache; a token that graduates, goes mayhem, or is
  never observed after entry is recorded as `missing`/`after_exit`/`interrupted` with a reason — never a guess.

## 9. Confirmation

No strategy threshold was changed: 2.5% round-trip rule, TP/SL, position size, entry filters, daily loss limit,
re-entry rules, holder policy, Token-2022 policy and Jupiter rate limits are byte-identical to before this phase
(§6). No live trading was implemented or enabled; DRY_RUN stayed on for every test and the validation run. Nothing
was committed.
