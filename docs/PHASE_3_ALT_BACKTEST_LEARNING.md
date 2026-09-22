# Phase 3-alt — Deep Backtest + Scheduled Self-Learning

Builds on Phase 1 / 1.1 / 1.1.1 / 2 (see the other `docs/PHASE_*` files).
This phase adds a real historical replay/backtesting engine and a scheduled
self-learning loop. It activates neither live trading nor any AI/LLM:

- `DRY_RUN=true` remains the only mode the running engine operates in.
  **No `LiveExecutor` exists.** No real transaction is ever broadcast.
- **AI = NONE.** Nothing in this phase calls OpenAI, Claude, Gemini,
  TokenRouter, or any other AI provider. Pattern discovery is local
  statistics only (Phase 2's `analytics/patterns.py`, unchanged).
- The finalized V1 trading strategy (position size, filters, TP/SL,
  re-entry limits, daily loss limit) is **unchanged**. The backtester
  replays it; it does not redesign it.

## 1. Why the historical data is the live engine's own evaluation log

This project does not operate a separate historical tick-data collection
pipeline. Instead, `token_evaluations` — already populated by the live/
DRY_RUN orchestrator on every ~2s evaluation tick for every watched token
(Phase 1) — **is** a genuine, per-token, multi-point historical time series.
Phase 3-alt repurposes it rather than inventing a new source or fabricating
data.

Two fields the live engine already computed in memory but never persisted
were added via an **additive, backward-compatible migration**
(`engine/src/ledger/migrations/002_backtest_fields.ts`, applied idempotently
by `applyAdditiveColumns()` in `engine/src/ledger/db.ts`):

| Column | Why it was missing before | Added because |
|---|---|---|
| `price_sol` | Only used transiently during a live evaluation tick | Backtesting cannot simulate a fill without an observed price at each historical instant |
| `tx_count_1m` | Same | Feeds `txVelocityPerSec` in the entry scorer, exactly as the live engine already computes it |

`engine/src/orchestrator/loop.ts` was updated to pass these two values into
every `token_evaluations` row it writes (all three call sites: baseline
filter failure, safety gate failure, full success).

### The historical data contract (`engine/src/backtest/types.ts`)

`HistoricalMarketSnapshot` is documented field-by-field as one of:

- **OBSERVED DIRECTLY** at `observedAtMs`: `discoveredAtMs`,
  `discoverySource`, `priceSol`, `liquiditySol`, `volume1mSol`,
  `buySellRatio`, `txCount1m`, `estimatedPriceImpactPct`,
  `safetyPassedAtObservationTime`, `safetyReasonsAtObservationTime`.
- **DERIVED LOCALLY** from a rolling window of prior observations for the
  same mint, at the time: `priceVelocity5sPct`, `volumeAccelerationX`.
- **NEVER AVAILABLE, never fabricated**: a separate buy/sell volume split
  (only their ratio was ever computed), raw transaction count (only a
  1-minute rate), swap count, slot, block time, or a slippage estimate
  independent of price impact.

Nothing in the replay engine invents a value for a field that was `null` in
the source row — see §7 for exactly how each `null` is handled.

## 2. Replay engine (`engine/src/backtest/replayEngine.ts`)

**Design decision: written in TypeScript, not Python, specifically so it
can call the exact same production functions the live orchestrator calls —
never a parallel reimplementation** (spec requirement, repeated across
sections 14/16 of the phase spec):

| Concern | Reused function | Source |
|---|---|---|
| Age window | `isWithinAgeWindow` | `discovery/tokenRegistry.ts` |
| Baseline filters | `collectBaselineFilterFailures` (now exported) | `orchestrator/loop.ts` |
| Entry scoring | `computeEntryScore` | `scoring/entryScorer.ts` |
| Expected net edge | `computeExpectedNetEdge` | `scoring/expectedNetEdge.ts` |
| Entry risk (exposure, re-entry, daily loss) | `evaluateEntryRisk` | `risk/riskEngine.ts` |
| Daily loss circuit breaker | `shouldLatchCircuitBreaker` | `risk/dailyLossCircuitBreaker.ts` |
| Exit priority ordering | `evaluateExit` | `exit/exitEngine.ts` (unchanged priority: circuit_breaker → dynamic_sl → momentum_tp → quick_tp → trailing_stop → reversal → liquidity_deterioration → max_hold_timeout) |
| Momentum / volatility signals | `computeRecentMomentumPct`, `computeRecentVolatilityPct` | `orchestrator/positionSignals.ts` |
| Fee/slippage/price-impact fill math | `simulateFill`, `computeTradeFees` | `execution/fillSimulation.ts` — **also used by the live `DryRunExecutor`**, so there is exactly one fee formula in the whole codebase, not two |
| Hard risk parameters | `HARD_RISK_PARAMETERS` (never overridable) | `config/hardRisk.ts` |

The only genuinely new code is bookkeeping a multi-mint replay needs that
the live engine gets from `TradeLedger`/`PositionMonitor` instead (I/O-bound,
not reusable for an in-memory replay): per-mint open-position state,
per-UTC-day daily-risk state, and per-mint trade-history counters.

`engine/eslint.config.js`'s hard-risk-isolation rule (which blocks
`config/hardRisk.js` imports from anything except `config/`, `risk/`, and
`orchestrator/`) was extended to also allow `src/backtest/**`, with a
comment explaining why: the replay engine is deterministic, non-AI code
that must faithfully reuse hard parameters, unlike a hypothetical AI/learning
module the rule exists to block.

### No look-ahead bias (structural, not just by convention)

1. All snapshots across all mints are merged into one global list, sorted
   by `observedAtMs` (mint name as a tie-breaker for determinism), by
   `mergeGlobally()`.
2. The engine processes this list strictly in order. For each event, the
   snapshot is appended to a per-mint "seen so far" array **before** any
   decision logic runs for that tick — nothing downstream of that line ever
   reads index `i+1` while deciding what happens at index `i`.
3. Momentum/volatility for an open position are computed the same way the
   live engine computes them: from the position's own accumulated
   `priceHistory`, which by construction only contains points at-or-before
   the current tick.
4. **Regression test, not just a design claim**
   (`engine/test/backtest/replayEngine.test.ts`, "no look-ahead bias"
   describe block): the same input is replayed twice, once in full and once
   truncated (a mint's own future ticks removed, or another mint's later
   data removed entirely), and every field decided at-or-before the
   truncation point is asserted byte-identical between the two runs. This
   is a general proof by example, not an exhaustive one, but it directly
   targets the two ways look-ahead could leak in: a mint seeing its own
   future, or a mint being affected by another mint's future.

### No averaging down / re-entry replay

While a mint has an open position, the replay loop `continue`s immediately
after exit-condition processing for that tick — entry conditions are never
even evaluated for a mint with an open position. A closed position's mint
becomes eligible for a fresh, **independent** entry evaluation (age window,
baseline filters, score, edge, and risk all re-checked from scratch) on its
very next snapshot; `MAX_REENTRY=5`, the cooldown window, and the
consecutive-loss cutoff are enforced by `canReenter()` exactly as they are
live, keyed off `reentryIndex = totalTrades so far for that mint`.

### Risk-limit replay

The daily loss circuit breaker, exposure/concurrency caps, and re-entry
tracker are the same production functions, fed replay-local state instead
of `TradeLedger` state. The circuit breaker is keyed by UTC calendar date
(via `utcDateString`) and is global across every mint for that date — a
loss on one mint can (and, per the finalized 10% daily loss limit, will)
block a completely different mint's otherwise-perfectly-eligible entry for
the rest of that day. See the "risk-limit replay" describe block in
`replayEngine.test.ts`.

## 3. Fee / slippage / price-impact / latency simulation

- **Fees** (`computeTradeFees`): `dexFeeBps + swapFeeBps` applied to the
  gross SOL amount, plus the fixed `networkFeeSol + priorityFeeSol` — the
  exact same formula and the exact same config fields (`config/schema.ts`'s
  `edge` group) the live `DryRunExecutor` uses.
- **Price impact**: a snapshot's own `estimatedPriceImpactPct` (observed
  live, at that historical instant) is used when present; `null` falls back
  to `SimulationAssumptions.fallbackPriceImpactPct`
  (`config.execution.fallbackPriceImpactPct`). **Task D is enforced at
  entry time**: `collectBaselineFilterFailures` rejects any snapshot whose
  `estimatedPriceImpactPct` exceeds `filters.maxPriceImpactPct` before a
  position is ever opened.
- **Slippage / latency**: this project's historical snapshots are spaced at
  the live polling interval (~2s) — far coarser than real execution latency
  (milliseconds). There is no sub-poll-interval price series to look up a
  literal "price 200ms later." Latency is therefore modeled as an
  **additional assumed cost** (`SimulationAssumptions.latencySlippageBufferPct`,
  the same config value and mechanism `DryRunExecutor` already uses for live
  DRY_RUN fills), not a price lookup. This limitation is deliberate and
  documented here, not hidden.
- **Net, never gross**: every reported `pnlSol`/`pnlPct` is net of the above.
  `replayEngine.test.ts` includes a direct regression for this: a trade
  that holds at a perfectly flat price to `max_hold_timeout` (0% "gross"
  move) still reports a negative `pnlSol`, from fees and the latency buffer
  alone.

## 4. Candidate comparison (`engine/src/backtest/compareStrategies.ts`)

`compareStrategies(snapshots, assumptions, parent, candidates)` runs the
parent and every candidate through the identical `runReplay()` call —
**the same snapshot map and the same `SimulationAssumptions` object**, never
a per-candidate copy that could silently drift. Candidate fairness is
structural, not just a convention: a candidate's `config` type
(`Pick<AppConfig, 'discovery'|'filters'|'scoring'|'exits'|'reentry'|'risk'>`)
cannot even express a hard-parameter override — there is no field for
position size, daily loss limit, max re-entries, exposure, or the emergency
stop in that type. `diffFields()` reports exactly which of the six tunable
groups differ from the parent, for audit logging.

## 5. Train / validation / out-of-sample split

`engine/src/backtest/temporalSplit.ts` (TypeScript) and
`python/learning/validation.py` (Python) implement the **same algorithm**
independently in each language — a deliberate, documented exception to "one
implementation" for this one utility, because it operates on a sequence
that exists separately in each language (the TS replay engine's own
`BacktestTrade[]`, and Python's ledger-sourced trade dicts). It is **not**
an exception for the risk/exit/fee logic itself, which stays single-sourced
in TypeScript.

Both implementations:

- Split **strictly by chronological order** (ascending `entryTimeMs` /
  `entry_time_ms`), never shuffled — shuffling would let a "validation"
  trade occur before a "training" trade, which is look-ahead bias by
  another name.
- Record `trainingPeriod` / `validationPeriod` / `oosPeriod` (start/end ms)
  explicitly on every split result, per spec task I, rather than leaving a
  caller to recompute them.
- Provide `assertNoTemporalLeakage` / `assert_no_temporal_leakage` as a
  standalone, callable check — used automatically inside the split
  functions, and also exposed for a caller building a split by hand.

**The out-of-sample slice is never used to choose a candidate's
parameters.** `python/learning/candidate_pipeline.py`'s `out_of_sample`
validation stage only ever *reports* a verdict on that slice after the
candidate's parameters were already fixed by pattern discovery — nothing
feeds an OOS result back into candidate generation.

## 6. The TS↔Python bridge

Python owns scheduling, candidate generation, and the promotion gate.
TypeScript owns the one real replay engine. `engine/src/backtest/cli.ts`
(built to `engine/dist/backtest/cli.js`, `npm run build --workspace=engine`)
is the seam between them:

```
python/learning/backtest_bridge.py
      |  subprocess.run(["node", ".../cli.js", "--db", ..., "--label", ..., "--config", overrides.json])
      v
engine/src/backtest/cli.ts
      |  reads token_evaluations via TradeLedger.getEvaluationsForReplay()
      |  builds a StrategyConfig from getDefaultConfig() + validated overrides
      v
engine/src/backtest/replayEngine.ts  ->  JSON BacktestResult on stdout
```

`cli.ts`'s `--config` override file may **only** set the six tunable groups
(`discovery`, `filters`, `scoring`, `exits`, `reentry`, `risk`) — any other
top-level key (including `edge`, `execution`, `rpc`, or anything shaped
like a hard-risk-parameter name) is rejected before a replay ever runs.
This means a Python-generated candidate structurally cannot smuggle a
hard-parameter change through the bridge, independent of
`learning/candidates.py`'s own `HardParameterViolationError` check on the
Python side — two independent layers, not one.

`python/learning/backtest_bridge.py::run_ts_backtest()` invokes the CLI,
parses its JSON stdout into a `BridgeBacktestResult`, and raises
`BacktestBridgeError` (never a fabricated result) if: the built CLI is
missing, the process times out, it exits non-zero, or its stdout isn't
valid JSON with every expected field. A real end-to-end run of this bridge
against a real built CLI was verified manually during this phase (seed two
`token_evaluations` rows forming a winning round trip → the bridge returns
a `completed` result with one `quick_tp` trade, matching the TS unit test's
hand-derived numbers exactly).

## 7. Data quality (`engine/src/backtest/dataQuality.ts`)

`detectDataQualityIssues()` scans a mint's snapshot sequence for: a missing
or non-finite timestamp, a duplicate `observedAtMs`, non-chronological
order, an impossible (≤0 or non-finite) price, negative liquidity or
volume, an impossible token age (observed before its own discovery time),
and a mint mismatch. Issues are **reported in the `BacktestResult`, never
silently discarded** — the replay still processes every valid record; a bad
record is not dropped from the input, only flagged in the output.

## 8. Scheduled + manual learning (Python)

### Scheduler (`python/learning/scheduler.py`, task J)

`run_scheduler_loop()` is a dependency-free sleep loop (no cron/APScheduler
needed for something this simple) that calls `run_learning_cycle(...,
trigger="scheduled", incremental=True)` every `DEFAULT_INTERVAL_SEC = 3600`
(one hour, matching the spec's stated default) by default. `AI = NONE`:
nothing in this module calls an LLM or any external service.

### Manual trigger (`python/scripts/learn.py`, task L)

```
python scripts/learn.py [path/to/ledger.sqlite] [--strategy-version V1] [--incremental]
```

Defaults to a **full** (non-incremental) run — a human explicitly asking
for a learning run generally wants it to actually run, unlike the
scheduler's lighter-weight default.

### Duplicate-run protection (task L)

`learning/db.has_running_learning_run(conn, now_ms, stale_after_ms=600_000)`
checks for any `learning_runs` row with `status='running'` started less
than 10 minutes ago. `run_learning_cycle()` checks this **before** writing a
new run row, and refuses with `status="already_running"` (no new row
written) rather than starting a duplicate. A `running` row older than the
staleness cutoff is treated as an orphan from a crashed process, not as
still blocking — otherwise one crash would permanently wedge every future
run. This makes both the scheduler and the manual `learn` command safe to
invoke concurrently or repeatedly.

### Incremental learning (task 24)

`run_learning_cycle(..., incremental=True)` compares the newest closed
trade's `entry_time_ms` against
`learning/db.get_last_processed_watermark_ms()` (the `MAX(data_range_end_ms)`
among this strategy version's **completed** runs). If there is no trade
past that watermark, it records nothing new and returns
`status="no_new_data"`. When there **is** new data, the cycle still
recomputes patterns/statistics over the **entire** historical sample, never
a partial one — partial recomputation would bias bucket statistics (e.g. a
liquidity bucket's win rate would silently drop older data). `incremental`
therefore only ever changes whether a redundant cycle runs, never what a
cycle computes; `incremental=False` (the default, matching Phase 2 exactly)
always runs a full cycle regardless of the watermark.

### Learning-run persistence (task K)

`learning_runs` gained six columns via an idempotent additive migration
(`learning/db.py::_apply_additive_columns`, mirroring
`engine/src/ledger/db.ts`'s pattern): `data_range_start_ms`,
`data_range_end_ms`, `candidates_tested`, `candidates_passed`,
`candidates_rejected`, `error` — alongside the Phase 2 columns
(`id`, `started_at_ms`, `completed_at_ms`, `trigger`, `sample_size`,
`strategy_version`, `summary_json`, `status`). `candidates_tested/passed/
rejected` are populated by whatever separately calls
`candidate_pipeline.run_and_persist_candidate_backtest` for a given
candidate — pattern discovery alone (`run_learning_cycle`) only ever
*generates* candidates (as `'pending'`), so a cycle that only generated
candidates truthfully reports zero tested.

## 9. Candidate lifecycle and the promotion gate (task 20)

```
Candidate (learning/candidates.py, status='pending')
      |
      v
Backtest stage  ---\
      |              }-- learning/candidate_pipeline.py, backed by the real
OOS stage       ---/     TS replay engine via backtest_bridge.py
      |
Shadow stage  (learning/shadow.py -- requires real hypothetical trades from
      |         an actual paper-trading loop; NOT produced automatically by
      |         candidate_pipeline.py, since this project doesn't operate
      |         one yet. Until a caller records one, this stage stays
      |         PENDING.)
      v
Promotion Gate (learning/promotion.py::evaluate_promotion)
      |
      v
'pass' -> candidate_strategies.status = 'promoted'   (DATABASE LABEL ONLY)
'rejected' -> status = 'rejected', rejection_reason = failed stage(s)
otherwise -> stays 'pending'
```

Each stage's `passed` verdict is looked up from the **latest**
`validation_results` row for that `(candidate_id, stage)` — a missing stage
counts as `PENDING`, never as passed. Promotion therefore only ever happens
when **every** required stage (`backtest`, `out_of_sample`, `shadow`) has
explicitly, independently passed; it can never happen by omission.

**"Promoted" is a database label, not a live switch.** Nothing in this
codebase reads a `candidate_strategies.status = 'promoted'` row and applies
it to the TypeScript engine's active `strategyVersion` or config. Adopting a
promoted candidate into production remains a separate, explicit,
human-initiated action outside this pipeline — consistent with "a candidate
MUST NOT become production automatically."

## 10. Strategy performance reporting language (task M)

Per the spec's OBSERVED / CALCULATED / ASSUMED / INFERRED distinction, and
enforced by test coverage carried over from Phase 2
(`analytics/patterns.py`'s `PatternObservation.description` always reads
"Historical sample shows..." never "X causes Y"):

- **OBSERVED**: raw values read directly from `token_evaluations` /
  `trades` (e.g. a recorded `price_sol`).
- **CALCULATED**: statistics derived from observed values by this codebase
  (e.g. `win_rate`, `avg_pnl_sol`, a bucket's average PnL).
- **ASSUMED**: `SimulationAssumptions` — fees, the fallback price-impact
  percentage, the latency-slippage buffer. Every `BacktestResult.notes`
  field states plainly that a positive result describes "simulation under
  configured assumptions," never a claim that the strategy would have
  produced a given SOL amount live.
- **INFERRED / correlation-only**: `learning/patterns.py`'s pattern
  descriptions. The backtester and the learning engine never claim
  causation anywhere in this codebase.

## 11. Testing

TypeScript (`engine/test/backtest/`, 47 new tests across 6 files):
`dataQuality.test.ts`, `temporalSplit.test.ts`, `snapshotAdapter.test.ts`,
`replayEngine.test.ts` (basic entry/exit replay, no-averaging-down/re-entry
replay, risk-limit replay, no-look-ahead-bias, determinism and data
quality), `compareStrategies.test.ts`, `cli.test.ts` (pure-helper unit
tests plus a real end-to-end run against a real temp SQLite ledger file, no
subprocess mocking).

Python (`python/tests/`, 36 new tests across 6 files): `test_db_learning.py`
additions (additive columns, granular fields, `has_running_learning_run`,
watermark tracking, `update_candidate_status`), `test_learner.py` additions
(data-range recording, duplicate-run refusal, incremental skip/re-run),
`test_validation.py` additions (period-bounds recording), `test_promotion.py`
(promotion-gate pass/reject/pending/re-test/isolation-per-candidate),
`test_backtest_bridge.py` (subprocess mocked: success, missing CLI,
non-zero exit, malformed JSON, missing field, timeout, override-file
plumbing), `test_candidate_pipeline.py` (bridge mocked: insufficient data,
below-minimum-sample, winning/losing sufficient samples, still-open
exclusion, end-to-end persist-and-decide), `test_scheduler.py` (default
interval, incremental default, deterministic loop iteration via injected
sleep/tick callbacks).

**Result at the end of this phase**: 263 TypeScript tests passing (216
Phase 1/2 baseline + 47 new), 135 Python tests passing (99 Phase 2 baseline
+ 36 new). `npx tsc -p tsconfig.json` (build), `npx tsc -p
tsconfig.test.json` (typecheck), and `npx eslint src test` (lint) all clean.

## 12. Known limitations (stated plainly, not hidden)

- **Not a full historical order-book replay.** The "historical data" is
  this project's own ~2s-interval evaluation log, not tick-by-tick
  order-book/liquidity data. Slippage/latency are therefore modeled as
  assumed costs, not looked up from a real sub-second price series.
- **Safety-gate outcomes are replayed, not re-verified.** A snapshot's
  `safetyPassedAtObservationTime` is whatever the live engine actually
  decided at that historical instant — the replay engine cannot re-query
  on-chain state for a past slot, and does not try to.
- **The shadow stage requires a real paper-trading loop this project does
  not operate yet.** `candidate_pipeline.py` never fabricates a shadow
  result; the promotion gate correctly withholds `'pass'` until a caller
  records one.
- **`temporalSplit.ts` / `validation.py` are intentionally duplicated**
  (§5) — everything else (fees, risk, exits, scoring) is single-sourced in
  TypeScript and reused, never reimplemented.
- **A positive backtest result is not a profitability claim.** Every
  `BacktestResult` states it describes "simulation under configured
  assumptions." The goal of this phase is a realistic, auditable,
  deterministic backtesting and self-learning foundation — not a proof
  that the strategy is profitable.
