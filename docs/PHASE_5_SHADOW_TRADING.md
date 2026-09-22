# Phase 5 — Controlled Realtime Shadow Trading

Builds on Phases 1–4. Adds a realtime **shadow** trading system: it consumes
REAL mainnet market data as the live engine already fetches it and simulates
trading decisions, with **zero** signing, broadcasting, SOL spent, wallet
access, or production-config change.

- `DRY_RUN` remains `true`. **No `LiveExecutor`. No live flag. No signer wiring.**
- AI is untouched and **outside** the shadow path (AI calls = 0). If the AI
  layer is unavailable, shadow trading is unaffected — nothing in
  `engine/src/shadow/` imports or depends on it.
- Hard risk parameters are used exactly as production uses them
  (`HARD_RISK_PARAMETERS`); shadow cannot override them.

## 1. Architecture and data flow

```
Real Solana data  ->  existing discovery / aggregator / price source / safety gate
                          |   (orchestrator/loop.ts, unchanged fetch logic)
                          v
        signals ALREADY computed this tick (price, liquidity, volume, ratio,
        velocity, acceleration, impact, safety verdict)
              |                                   |
              v                                   v
   production path (unchanged):          ShadowRunner.onMarketTick(tick)   [optional dep]
   entry -> risk -> DryRunExecutor         |  per configured shadow strategy version:
   -> trades / token_evaluations           |    data-quality check -> exit OR entry evaluation
                                           |    (same production functions) -> simulateFill
                                           v
                                    ShadowLedger (shadow_* tables only)
                                           v
                          shadow status CLI / Python comparison / Promotion Gate
```

**No duplicate RPC (task 4).** `ShadowRunner` performs no network I/O. The
one integration point is `orchestrator/loop.ts`: an *optional*
`shadowRunner` dependency receives the tick the loop had already built,
exactly once per evaluation, via `notifyShadow(...)`. Omitting the
dependency changes nothing; an exception inside shadow is caught and
logged and cannot affect a real evaluation tick.

**No duplicated strategy logic (task 2).** `shadowRunner.ts` calls the same
primitives as production and the backtester: `isWithinAgeWindow`,
`collectBaselineFilterFailures` (moved to `orchestrator/baselineFilters.ts`
to avoid a `loop.ts` ↔ `shadow` import cycle), `computeEntryScore`,
`computeExpectedNetEdge`, `evaluateEntryRisk` (exposure, concurrency,
cooldown, re-entry, consecutive-loss, daily circuit breaker),
`evaluateExit` (the finalized exit priority order), `shouldLatchCircuitBreaker`,
`computeRecentMomentumPct/VolatilityPct`, and `simulateFill`.

## 2. Execution simulation (tasks 5–7, 15)

Entries and exits use `simulateFill` (the same fee/impact/latency-buffer
formula `DryRunExecutor` and the backtester use) on the tick's
already-observed price. A `ShadowTradeRecord` stores the **observed market
price** (`entryPriceSol`/`exitPriceSol`) separately from the **simulated
fill** (`entryFilledAmountSol`, fees). `executionMode` is always `'shadow'`;
nothing here is ever represented as a real transaction (`txSignature` does
not exist on shadow records). A caller may supply a read-only
`QuoteObservation` (route, quoted price, expected output, impact, slippage)
on the tick; it is preferred for impact/slippage and persisted on the entry.
*Phase 5.1: wired.* When shadow is enabled, `MarketPriceSource` remembers the
outcome of the read-only quote request the loop already makes for price
impact, and the loop forwards it (see "Phase 5.1" below). No second request.

## 3. Risk, re-entry, exposure (tasks 8–10)

State lives in SQLite (`shadow_trades`, `shadow_daily_risk_state`), scoped by
`strategy_version`, so **the daily loss latch survives a restart** (tested by
building a fresh `ShadowRunner` over the same ledger). Position size 0.3 SOL,
MAX_REENTRY=5, cooldown, consecutive-loss protection, no averaging down,
max concurrent positions/exposure and the 10% daily loss limit all come
from the shared functions, not shadow-specific copies. Limitation carried
over from production: per-position price history (for momentum/trailing) is
in memory and re-seeds from the entry point after a restart.

## 4. Shadow ledger (task 11)

Migration `003_shadow_tables.ts` (idempotent `CREATE TABLE IF NOT EXISTS`):
`shadow_trades` (with `execution_mode='shadow'`, `strategy_version`,
`simulator_version`, entry/exit/fees/PnL/hold/MFE/MAE/quote JSON),
`shadow_daily_risk_state`, `shadow_missed_signals`,
`shadow_data_quality_events`, `shadow_latency_samples`. Shadow **never**
writes `trades`, `token_evaluations` or `daily_risk_state` (test-enforced).

## 5. Missed signals (task 12)

A signal that passes filters, score and expected edge but is blocked is
recorded with the risk engine's own reason string verbatim
(`max_concurrent_positions_reached`, `max_total_exposure_reached`,
`reentry_cooldown_active`, `consecutive_loss_limit_reached`,
`max_reentries_per_token_reached`, `daily_loss_circuit_breaker_triggered`).
Shadow adds `missing_market_data` when required fields are null. Ordinary
filter rejections are outcomes, not missed signals. `stale_quote`,
`rpc_failure`, `aggregator_failure` and `insufficient_market_data` exist as
reason names but are currently surfaced through data-quality events.

## 6. Data quality (task 13)

`checkTickDataQuality` (realtime counterpart of `backtest/dataQuality.ts`)
records `duplicate_event`, `out_of_order_event`, `stale_market_data`,
`impossible_price_change` (>5x in one tick), `invalid_liquidity`,
`malformed_market_data`, `degenerate_ratio`, `rpc_error`, `aggregator_error`,
`missing_quote`. Every event is persisted with a **severity** (Phase 5.1):
`block` (duplicate, out-of-order), `reject` (impossible price, invalid
liquidity, malformed data) and `warning` (stale, fetch errors, missing quote,
degenerate ratio). `block` and `reject` ticks drive no entry or exit for any
strategy (`skipped_data_quality`); warnings are recorded and the tick is
still used. `missing_event` is intentionally never emitted (see Phase 5.1).

## 7. Latency (task 14)

`computeLatencySample` derives discovery, market-data, quote, signal and
processing latency (plus the runner's own measured processing time) from
timestamps captured in-process. These are **OBSERVED SYSTEM
LATENCY**. They never feed the fill model; `latencySlippageBufferPct` is the
separate **ASSUMED EXECUTION LATENCY** cost, since shadow never touches the
chain and cannot measure real confirmation latency.

## 8. Production and candidate isolation (tasks 3, 17)

`ShadowRunner` takes a list of `ShadowStrategyConfig`. Every ledger query is
scoped by `strategy_version`, so V1-shadow and V2-shadow receive identical
ticks but have independent positions, daily risk, token history, and trades
(tested, including that a loss in one never touches the other). A shadow
config's type (`Pick<AppConfig, discovery|filters|scoring|exits|reentry|risk>`)
cannot express hard parameters, and shadow has no write path to production
config or tables.

## 9. Security (tasks 1, 25, 28)

- ESLint rule: `src/shadow/**` may not import `**/execution/signer/**`
  (verified by linting a probe file that imports `KeypairSigner`).
- `ShadowRunner` has no constructor option, member or code path that accepts
  a signer/secret provider.
- `noWalletAccess.test.ts`: with a real, available `KeypairSigner`
  (spied `signTransaction`, `getPublicKey`, secret provider), a full shadow
  entry/exit cycle makes **zero** calls to any of them; the shadow sources
  contain no reference to the signer subsystem or to send/sign/simulate
  transaction calls.

## 10. Monitoring (tasks 23–24)

`npm run shadow-status -- --db <ledger> --strategy-version V1 [--strategy-version V2]`
prints read-only JSON: open positions, trades, win rate, net PnL, drawdown,
missed-signal counts by reason, daily simulated loss and circuit-breaker
state, data-quality counts, latency averages, and RPC/quote health (null
until something actually records outcomes — never a guessed 100%).
`HealthCounters` is fed by the live loop and persisted (Phase 5.1). No
Telegram code was written; this JSON is what a future read-only adapter
would forward.

## 11. Comparison and promotion (tasks 16, 18–20)

Python (`analytics/reader.py`, `learning/shadow.py`), read-only over shadow tables:

- `compare_backtest_vs_shadow` — trades, win rate, net PnL, avg PnL, hold
  time, TP/SL/timeout rates, drawdown, fees, each section labelled
  `SIMULATED` / `CALCULATED`; explanations are `HYPOTHESIS`. It does not
  expect equality and never says a strategy "is profitable".
- `evaluate_shadow_stage` — `passed=None` (INSUFFICIENT_DATA) until both
  `SHADOW_MIN_DURATION_HOURS` and `SHADOW_MIN_TRADES` (env, configurable) are
  met; wording is "produced X simulated net PnL under the observed shadow
  market conditions".
- `persist_shadow_stage` writes the existing `validation_results` `shadow`
  stage; `learning/promotion.py` is unchanged. A shadow pass alone leaves the
  candidate `pending`. Promotion stays a database label that activates nothing.

## 12. Validation methodology

Run V1 in shadow first to check the live implementation against expected
behavior; compare against a backtest of the same window; only candidates that
passed backtest + OOS enter shadow; the gate needs all stages. Thresholds are
operator-set, not evidence of profitability.

## 13. Limitations

- See "Phase 5.1 — known limitations" below for the current, evidence-based
  list. (The Phase 5 caveats about un-wired quotes, health counters and the
  entrypoint no longer apply.)
- Shadow ticks come from `loop.ts`'s ~2s watch loop, so exits are checked at
  ~2s granularity (adequate for the 30s max hold) and only while a mint is
  watched (age window).
- Safety verdict is reused from the production tick; when production's own
  baseline filters reject a tick, no safety check runs, so a looser shadow
  candidate gets `safetyPassed=null` and rejects on safety for that tick.
  Extra RPC calls for those ticks were deliberately avoided.

---

# Phase 5.1 — Live read-only activation and validation

**SHADOW ≠ LIVE TRADING. NO TRANSACTION IS SIGNED OR BROADCAST.** Shadow
observes public market data and simulates decisions in a separate ledger.
There is no wallet, signer, executor, swap, bundle or `sendTransaction` in
the shadow path, and `DRY_RUN` stays `true`.

## Activation procedure

```bash
cd engine && npm run build
DRY_RUN=true SHADOW_TRADING_ENABLED=true \
  LEDGER_DB_PATH=../data/live/shadow-live.sqlite \
  JUPITER_QUOTE_BASE_URL=https://lite-api.jup.ag/swap/v1 \
  node dist/index.js
```

(PowerShell: set `$env:SHADOW_TRADING_ENABLED='true'` etc. first, then `node dist/index.js`.)

Environment variables (none is a secret; no wallet variable is read by shadow):

| Variable | Default | Meaning |
|---|---|---|
| `SHADOW_TRADING_ENABLED` | `false` | `true` builds one V1 `ShadowRunner` and injects it into the orchestrator. |
| `DRY_RUN` | `true` | Unchanged; the engine refuses to start if `false`. |
| `LEDGER_DB_PATH` | `./data/ledger.sqlite` | Shared SQLite ledger (shadow tables live beside, never inside, production tables). |
| `JUPITER_QUOTE_BASE_URL` | `https://quote-api.jup.ag/v6` | Read-only quote endpoint. On 2026-09-20 that host did not resolve in DNS; `https://lite-api.jup.ag/swap/v1` served quotes. |
| `RPC_HTTP_URL` / `RPC_WS_URL` | public mainnet-beta | A private RPC is strongly advised (the public one returned HTTP 429 to discovery). |
| `LOG_LEVEL` | `info` | |

**Activation flow.** `index.ts` calls `createShadowActivation(cfg, db, logger)`
(`src/shadow/activation.ts`). Disabled → returns `null`, nothing shadow-related
exists, and `MarketPriceSource` retains no quote data. Enabled → builds a
`ShadowLedger`, persisted `HealthCounters`, and a `ShadowRunner` for the
configured strategy version only (**V1 only; no candidate is enabled**), then
passes `shadowRunner` in `OrchestratorDeps`. Startup logs exactly
`SHADOW_ENABLED=… SHADOW_STRATEGY_VERSION=… SHADOW_MODE=READ_ONLY` — no config
dump, URLs or keys.

## Stop, status, compare

- **Stop:** Ctrl+C / SIGTERM (graceful), or kill the process. State is in
  SQLite, so an abrupt kill loses nothing already written (verified live).
- **Status:** `npm run shadow-status -- --db ../data/live/shadow-live.sqlite --strategy-version baseline-v1`
  (read-only JSON: health counters, latency averages, data quality by severity,
  missed signals, daily simulated loss).
- **Compare with a backtest of the same window:**
  `python scripts/compare_shadow_backtest.py ../data/live/shadow-live.sqlite`
  (needs `npm run build`). The window is first..last shadow tick; the backtest
  replays the production loop's `token_evaluations` for the same ticks with the
  same V1 parameters, risk rules and fee assumptions; both sides are restricted
  to the window. Sections are labelled OBSERVED / CALCULATED / ASSUMED / HYPOTHESIS.

## What is observed / simulated / not executed

- **OBSERVED:** discovery events (on-chain creation time + our detection time),
  DexScreener price/liquidity/volume, Jupiter *read-only* quotes (HTTP GET only),
  RPC reads used by the safety gate, and system latency between our own stages.
- **SIMULATED:** entries, exits, fills, fees, PnL and risk state (`simulateFill`,
  the production risk/exit functions, `shadow_*` tables only).
- **ASSUMED:** fee schedule, the fallback price impact (used when a quote
  fails) and the latency-slippage buffer applied to fills. This is **not**
  measured execution latency; nothing here measures blockchain confirmation.
- **NOT EXECUTED:** any transaction. A `QuoteObservation` is data about an
  indicative quote; nothing turns it into an order.

## Quote flow

The loop already requests one read-only buy quote per tick for price impact.
With shadow enabled, `MarketPriceSource.takeLastQuoteFetch(mint)` returns that
request's outcome (ok, route, raw out amount, impact, request latency). The
loop turns it into a `QuoteObservation` plus health counters
(`quote_success` / `quote_error`). **One request serves production and shadow.**
Fields that cannot be derived are `null`, never guessed: the implied price and
SOL output need the mint's decimals, and a quote returns a slippage
*tolerance*, not an estimated slippage (the runner then uses the ASSUMED
buffer). A failed quote is a `missing_quote` warning and the fill falls back to
the assumed impact.

## Health counters and latency

Counters (persisted in `shadow_health_counters`, read by the status CLI):
`rpc_success/error` (safety-gate mint read), `aggregator_success/error`,
`market_data_success/error`, `quote_success/error`, `shadow_ticks_received`,
`shadow_ticks_rejected_data_quality`, `missing_market_data`. They are
observations only and never influence a decision.

Latency (all OBSERVED): *discovery* = our detection time − on-chain block time
(1 s resolution; the event now carries `detectedAtMs`), *market data*, *quote*
(request round trip), *signal* (data acquired → handed to shadow, includes the
safety-gate wait), *processing* (tick start → handed to shadow) and *shadow
processing* (time inside `onMarketTick`, `performance.now()`).

## Data-quality policy (as implemented)

| Severity | Kinds | Effect |
|---|---|---|
| block | duplicate, out-of-order | tick drives nothing |
| reject | impossible price (>5x/tick), invalid liquidity, malformed (NaN, ≤0 price, negatives, −∞) | tick drives nothing and is never a signal |
| warning | stale (>10 s gap), rpc/aggregator error, missing quote, `degenerate_ratio` | recorded, tick still used |

Every event stores timestamp, token, kind, severity and reason. A rejected tick
does not become the baseline for the next comparison; after 3 consecutive ticks
rejected only for an impossible jump the baseline moves (a genuine re-pricing
must not block a mint forever).

**Evidence-driven change.** The first live run rejected 100 % of the ticks of
tokens whose aggregator data had `buySellRatio = +Infinity` /
`volumeAccelerationX = +Infinity` (buys with no sells yet; no prior volume).
That is division by zero in the aggregator/history code, and the production
strategy already defines its handling (filters pass it; scoring treats a
non-finite input as worst case). Treating it as "malformed" made shadow diverge
from production, so `+Infinity` ratios are now a `degenerate_ratio` **warning**;
NaN and −∞ remain malformed.

**`missing_event` is deliberately unused.** The only "expected event" here is
the ~2 s evaluation timer, and a gap in it is already reported as
`stale_market_data`. A second event for the same gap would manufacture data.

Known consequence of the reject rule: an open shadow position that sees a >5x
one-tick collapse (e.g. a rug) does not exit on that tick; it exits on the next
accepted tick, at the max-hold timeout, or after re-baselining. Shadow is
therefore slightly *optimistic* about sudden crashes.

## Security guarantees (tested)

- ESLint forbids `src/shadow/**` importing `**/execution/signer/**` (unchanged);
  a test scans every shadow file for signer imports/classes and for
  send/sign/simulate-transaction calls, swap endpoints and non-GET quote requests.
- With a real `KeypairSigner` alive and spied in the test process, a full shadow
  cycle makes zero signer / secret-provider calls.
- No realtime AI/LLM reference exists anywhere in `engine/src` (test-enforced).
- Shadow writes only `shadow_*` tables; a test and the live run confirm `trades`
  and `daily_risk_state` stayed at 0 rows (production's own `token_evaluations`
  rows are written by the unchanged production loop).

## Restart recovery

Verified two ways. (1) A test over a real ledger file: open position, daily-loss
latch and counters survive a fresh process; a blocked entry stays blocked; the
open position exits exactly once; replaying the same tick is a no-op; V2 sees
none of V1's state. (2) Live: the process was killed abruptly and restarted
against the same ledger; counters and rows continued (105 → 123 ticks) with no loss.

## Flaky DPAPI test — root cause and fix

Not a DPAPI, parallelism or contention bug. Measured on this machine: a
`cmd.exe` spawn costs 0.1 s, a no-op `powershell -NoProfile -Command 1` costs
**≈8 s**, and the real DPAPI protect/unprotect adds < 1 s. The round-trip test
does two PowerShell process starts (≈16–21 s), right at its 20 s timeout, so it
failed whenever the full suite loaded the machine (and passed alone). It was not
skipped or marked flaky: the timeout is now 90 s with the measurement documented
in the test, which still runs real DPAPI (it took 20.8 s in the last full run —
it would have failed under the old limit). The slow PowerShell start itself
(possibly certificate/CRL checks or security scanning) is a machine-level issue
outside this repository.

## Known limitations (Phase 5.1)

- **The live window was minutes, not hours** (see the phase report for exact
  numbers). It validates the pipeline; it is not a performance sample and
  supports no profitability conclusion.
- **DexScreener does not index most brand-new pump.fun tokens for minutes**, so
  most ticks have no price (`missing_market_data`). An entry needs a token that
  has a pair *and* passes every V1 filter.
- **The public RPC is rate-limited** (HTTP 429): many creation events were dropped
  before discovery. Use a private RPC for a real window.
- **[RESOLVED in Phase 5.2 — see below] Data-mapping bug found by live validation:** `DexscreenerBirdeyeAggregator` uses `pair.liquidity.base` (a *token*
  amount, e.g. 52,014,403) as `liquiditySol`; the SOL amount is `liquidity.quote`
  (320.99 for the same pair). It also treats `volume.m5` (USD) as SOL. So the
  "≥20 SOL liquidity" and "≥5 SOL volume" filters are not measuring SOL, and
  production, shadow and backtest all inherit that. It was left untouched because
  fixing it changes production dry-run behaviour and needs review; it should be
  resolved before Phase 6 relies on V1's filters.
- The default Jupiter quote host (`quote-api.jup.ag/v6`) did not resolve; the
  default was not changed (override with `JUPITER_QUOTE_BASE_URL`). The same host
  backs the safety gate's sellability check, which therefore fails closed by default.
- Quote-derived price / SOL output are `null` (decimals unknown); quoted slippage
  is a tolerance, so fills use the assumed latency-slippage buffer.
- RPC health only counts the safety gate's mint-account read.

---

# Phase 5.2 — Aggregator unit correction

A **data-correctness fix, not a strategy change.** V1 thresholds, entry/exit
logic, risk parameters, position size and safety gates are untouched. Only the
measurement units that feed those rules were corrected.

## Root cause

`DexscreenerBirdeyeAggregator` read `pair.liquidity.base` (an amount of the
*token*) as `liquiditySol`, and `pair.volume.m5` (USD) divided by 5 as
`volume1mSol`. It also chose "the best pair" by USD liquidity across *all*
pairs, and returned `priceNative` regardless of the pair's quote asset (for a
TOKEN/USDC pair that is a USDC price). Nothing checked which asset a number was
denominated in.

## Unit contract (verified against live responses)

| Field | Source | Old interpretation | Correct unit | Now |
|---|---|---|---|---|
| `liquidity.base` | DexScreener | labelled SOL | **token amount** | never used as liquidity |
| `liquidity.quote` | DexScreener | ignored | quote asset units (**SOL only if `quoteToken` is wrapped SOL**) | `liquiditySol`, only for a proven TOKEN/SOL pair |
| `liquidity.usd` | DexScreener | used to pick the best pair | USD | no longer used |
| `volume.m5` | DexScreener | `/5` labelled SOL "1m" | **USD**, trailing 5 minutes | converted to SOL as `volume5mSol` (informational) |
| 1-minute volume | — | fabricated from m5 | SOL, 1-minute window | **`volume1mSol = null`** (no real source) |
| `priceNative` | DexScreener | labelled SOL price | base price in **quote** units | `priceSol` only for TOKEN/SOL, else `null` |
| `priceUsd / priceNative` | DexScreener | unused | USD per SOL (TOKEN/SOL pair, same response) | conversion reference (sanity-bounded 1..10,000) |
| `txns.m5` buys/sells | DexScreener | count ratio | counts, same window | `buySellRatio` unchanged |
| trailing tx rate | DexScreener | `(buys+sells)/5` "1m" | mean per minute | `txCount1m` unchanged, documented as a mean rate |
| volume acceleration | history | current/prior `volume1mSol` | same quantity, same unit | unchanged; `null` when either side is `null` |
| market cap / fdv | DexScreener | unused | USD | still unused |

Downstream consumers of `liquiditySol` / `volume1mSol` / ratios: the baseline
filters (`orchestrator/baselineFilters.ts`), the safety gate's liquidity check,
entry scoring and expected edge, the persisted `token_evaluations` /
`trades` rows, the shadow tick, the backtest snapshot, and the Python analytics
buckets. They all read the same aggregator output.

## Rules implemented (`src/discovery/dexscreenerUnits.ts`)

- **UNKNOWN UNIT ≠ SOL.** A pair is used only if `baseToken.address == mint`
  **and** `quoteToken.address == wrapped SOL`. Anything else (USDC, USDG, RAY,
  a reversed SOL/TOKEN pair, a pair that does not identify its assets) is not
  a candidate; if no eligible pair exists, liquidity and price are unavailable.
- The best pair is chosen by SOL-side `liquidity.quote` among eligible pairs
  only.
- USD → SOL conversion uses `priceUsd / priceNative` **from the same pair in the
  same response** (DexScreener publishes no per-field timestamps; a single
  response is the tightest timestamp compatibility available). Missing,
  non-numeric, zero or absurd references make the converted value `null`.
- **`volume1mSol` is always `null`.** DexScreener publishes m5/h1/h6/h24 only.
  A 5-minute total, or its per-minute mean, is not a 1-minute observation, so
  nothing populates `volume1mSol` from it.
- Unavailable is handled fail-closed by the existing filter path: the baseline
  filters report `volume_1m_unavailable` / `volume_acceleration_unavailable`.
  Unavailable is never "enough" volume, and it is a different verdict from
  `volume_below_minimum`. Thresholds (20 SOL, 5 SOL, 1.5, +1 %, 1.5x, 1 %) are
  unchanged and pinned by a test.
- The Phase 5.1 policy is unchanged: `+Infinity` ratio → `degenerate_ratio`
  warning; NaN and −Infinity → `malformed_market_data` reject.

## Exact code changes

- **New** `src/discovery/dexscreenerUnits.ts` (pure interpretation, pair
  eligibility, SOL/USD reference), fixtures `test/fixtures/dexscreener_token_sol_pumpswap.json`
  and `dexscreener_token_usdc_and_sol.json` (real captured responses).
- `src/discovery/aggregatorFallbackClient.ts`: `getLiquidityAndVolume` and
  `getPrice` use the pure interpreter.
- `src/types/market.ts`: `volume1mSol` / `volumeAccelerationX` may be `null`;
  `volume5mSol`, `pairAddress` added; units documented on the types.
- `src/orchestrator/baselineFilters.ts`, `marketHistory.ts`, `loop.ts`: null-aware
  (unavailable ⇒ filter failure / null acceleration; no defaults invented).
- `src/backtest/replayEngine.ts`, `src/shadow/shadowRunner.ts`: pass the raw
  nullable values to the same filter function (previously sentinels), and shadow
  no longer counts an unavailable 1-minute volume as "missing market data".
- Python: unit-contract documentation and `MARKET_DATA_UNIT_CONTRACT_VERSION`
  in `analytics/schema_contract.py`, plus tests. No analytics logic changed.

## Production / shadow / backtest consistency

One aggregator output feeds all three. `unitContractConsistency.test.ts` runs
the **real** aggregator over the real fixture through the live loop and shows
`liquiditySol = 0.3054` in the shadow tick, in production's persisted evaluation
and in the backtest snapshot built from it (never 991,688,175), the same
baseline verdict from production and shadow, and `volume1mSol = null` in all
three.

## Consequence you must decide on

With DexScreener as the only market-data source, **V1's 1-minute volume and
volume-acceleration filters cannot be evaluated**, so V1 cannot pass its
baseline filters on live data (it reports `volume_1m_unavailable`). This is the
honest result of not fabricating a value; the threshold was deliberately not
lowered. Restoring evaluability needs a real 1-minute volume source (for example
trade-level data), or an explicit, separately reviewed decision to define a proxy
(such as the 5-minute mean per minute). That decision is not made here.

## Ledgers written before this fix

Rows recorded before Phase 5.2 (including `data/live/shadow-live.sqlite` from
Phase 5.1) contain token amounts as `liquidity_sol` and USD-derived numbers as
`volume_1m_sol`. Do not pool them with post-fix rows, and do not use them to
validate the corrected pipeline.

## Remaining limitations

- No real 1-minute volume source (above).
- Brand-new pump.fun tokens usually have no DexScreener pair for minutes, so the
  discovery stream itself produced no unit-checkable rows in the short live run;
  the live unit validation used real, currently listed pairs instead.
- The SOL/USD reference is derived per pair from one response (sanity-bounded);
  it is not an independent price oracle.
- `txCount1m` and `buySellRatio` come from the m5 window (h1 fallback) and are
  rates/ratios over that window, not 1-minute observations.
- Market cap/fdv are not used anywhere.
