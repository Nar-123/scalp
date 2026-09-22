# Phase 2 — Secure Wallet Signing + Python Analytics Foundation

Builds on Phase 1 / 1.1 / 1.1.1 (see the other `docs/PHASE_*` files and
`docs/ARCHITECTURE.md`). This phase adds two things, kept strictly
separate, and activates neither:

**A. Wallet signing infrastructure** (`engine/src/execution/signer/*`,
`engine/src/execution/transactionSafety.ts`) — real, tested code, but not
wired into the orchestrator. `DRY_RUN=true` remains the only mode the
running engine ever operates in.

**B. Python local-analytics + self-learning foundation** (`python/`) —
reads the shared SQLite ledger and can discover correlations and propose
candidate parameter changes, but never writes production config and never
calls an LLM.

## Status of each discovery path (do not overstate any of these)

| Path | Status |
|---|---|
| pump.fun | **LIVE VALIDATED** (Phase 1.1) — a real mainnet `CreateV2` creation was observed and correctly accepted end-to-end. |
| Raydium AMM V4 | **IMPLEMENTED / HARDENED** (Phase 1.1.1) — full instruction-discriminator + account-layout validation, dual-signal fail-closed design. **LIVE VALIDATION PENDING** — no genuine `initialize2` transaction has ever been captured or accepted live; only synthetic + real-negative fixtures exist. |
| Raydium CPMM | **NOT SUPPORTED** — different program ID, not decoded. |
| Raydium CLMM | **NOT SUPPORTED** — different program ID, not decoded. |
| Raydium StableSwap | **NOT SUPPORTED** — different program ID, not decoded. |

Nothing in Phase 2 changes any of the above.

## A. Wallet signer architecture

```
Trading Engine (orchestrator)
      |  (not wired up in this phase)
      v
Execution Engine  --------------------->  transactionSafety.validateTransactionSafety()
      |                                    (pre-trade checks; infrastructure only)
      v
DryRunGuardedSigner   (defense-in-depth: refuses to sign unless
      |                DRY_RUN=false AND liveTradingExplicitlyEnabled=true,
      v                regardless of what's below)
KeypairSigner        (holds an in-memory Keypair behind real `#private`
      |               fields -- see "no secret leakage" below)
      v
SecretProvider (interface)
      |
      v
WindowsDpapiSecretProvider   (the concrete "OS keychain / external secret
                              manager" -- Windows DPAPI via PowerShell,
                              chosen specifically to avoid a native Node
                              addon build step; see rationale below)
      |
      v
Private key bytes (exist only for the instant Keypair.fromSecretKey needs them)
```

`engine/src/execution/signer/types.ts` defines `Signer` (`getPublicKey`,
`signTransaction`, `isAvailable`) and `SecretProvider` (`isAvailable`,
`getSecretBase58`). The trading engine only ever holds a `Signer` reference
— it has no code path to a raw key, `SecretProvider`, or `KeypairSigner`'s
internals.

**Why DPAPI via PowerShell, not a native Credential Manager binding**:
Phase 1 already established that this machine has no Visual Studio Build
Tools, which is why the ledger uses `node:sqlite` instead of
`better-sqlite3`. A `keytar`-style native addon for the real Windows
Credential Manager vault would hit the identical native-compilation wall.
Windows DPAPI (`ConvertTo-SecureString` / `ConvertFrom-SecureString`,
scoped to the current user account) is a real, secure, native Windows
mechanism reachable by shelling out to `powershell.exe` — no native Node
module required. `WindowsDpapiSecretProvider.protectAndStore()` is a
one-time, manual, operator-run setup step; the trading engine never calls
it.

### A real bug two of these tests caught before it could touch a live key

1. `bs58.decode()` returns a Node `Buffer` (a `Uint8Array` subclass) whose
   `.slice()` is overridden to return a **view**, not a copy, unlike plain
   `Uint8Array.slice()`. `KeypairSigner`'s original "securely wipe the
   decoded secret bytes after constructing the Keypair" step
   (`secretBytes.fill(0)`) therefore silently **corrupted the live keypair**
   when the input came straight from `bs58.decode()` — verified directly:
   the derived public key became the all-zero `PublicKey` after the wipe.
   Fixed by forcing an independent `new Uint8Array(...)` copy before
   constructing the `Keypair`. Regression-tested in
   `test/execution/signer/keypairSigner.test.ts`.
2. `@solana/web3.js`'s `Keypair` class serializes its raw `secretKey` bytes
   under `JSON.stringify` (verified: `JSON.stringify(Keypair.generate())`
   includes the full 64-byte array). `KeypairSigner` therefore holds its
   `Keypair` in a real ECMAScript `#private` field (not TypeScript's
   compile-time-only `private`), which is invisible to `JSON.stringify`,
   `Object.keys`, and `util.inspect` by language design — closing off an
   entire class of accidental-logging leak.

## DRY_RUN protection (defense in depth)

Three independent layers, any one of which alone would prevent a live
signature:

1. **`src/index.ts` (unchanged from Phase 1)** refuses to even start if
   `DRY_RUN=false` — `LiveExecutorStub` and `NullSigner` are the only
   executor/signer the orchestrator can construct, and `NullSigner` always
   throws.
2. **`DryRunGuardedSigner`** wraps any real `Signer` and independently
   refuses `signTransaction()` unless BOTH `dryRun===false` AND a second,
   separate config flag `execution.liveTradingExplicitlyEnabled===true`
   are set — live mode is never inferred from `DRY_RUN=false` alone, and
   never from a wallet credential merely existing.
   `getPublicKey()`/`isAvailable()` are not gated (read-only, not a
   signing/broadcast action).
3. **`transactionSafety.validateTransactionSafety()`** independently checks
   `dryRun`/`liveTradingExplicitlyEnabled` as two of its many pre-trade
   conditions (alongside program ID, instruction type, mint, amount vs. the
   hard position size, slippage/price-impact vs. hard maximums, exposure,
   daily circuit breaker, emergency stop) — so even a hypothetical future
   executor that bypassed `DryRunGuardedSigner` would still be blocked here.

`execution.liveTradingExplicitlyEnabled` defaults to `false`
(`LIVE_TRADING_EXPLICITLY_ENABLED` env var). No code path in this phase can
ever set it to `true` automatically.

## Transaction safety validation infrastructure

`engine/src/execution/transactionSafety.ts` implements every check spec
section 9 / task 9 names, as pure, exhaustively tested functions (20 tests)
— NOT wired into any executor. `hardLimitsFrom()` (in `src/risk/hardLimits.ts`,
not `execution/`, to keep the hard-risk-isolation ESLint boundary intact —
see below) derives every numeric limit directly from
`HARD_RISK_PARAMETERS`, so there is exactly one source of truth for "how
much SOL / how much slippage / how much exposure is allowed," never a
second hardcoded copy.

## Hard-risk isolation boundary (unchanged, now covers execution/ too)

The existing ESLint rule (`engine/eslint.config.js`) restricting
`config/hardRisk.ts` imports to `config/`, `risk/`, and `orchestrator/`
caught a real violation during this phase: `execution/transactionSafety.ts`
initially imported `HardRiskParameters` directly. Fixed by moving the
`HardLimits` translation into `risk/hardLimits.ts` and having
`execution/` import the already-isolated `risk/` module instead — the rule
did its job without needing to be loosened.

## B. Python analytics + learning foundation

```
python/
  analytics/            # read-only over the shared ledger
    schema_contract.py   # documented column lists for every shared table
    reader.py             # read-only SQLite access (trading-truth tables)
    constants.py          # MIN_TRADES_FOR_PATTERN / _PARAMETER_PROPOSAL / _STRATEGY_VALIDATION
    features.py           # deterministic bucketing (token age, liquidity, velocity, ...)
    statistics.py         # win rate, PnL, drawdown, profit factor, re-entry performance, ...
    patterns.py           # OBSERVED_CORRELATION pattern discovery, gated by MIN_TRADES_FOR_PATTERN
    reports.py            # compact JSON summaries (future AI token-efficiency seam)
  learning/
    db.py                 # owns + creates the "learning" tables (read-write, own file section)
    candidates.py          # candidate format + hard-parameter rejection
    validation.py          # sample-size gating + chronological train/validation/OOS split
    backtest.py            # foundation -- refuses to fabricate a result below the sample minimum
    shadow.py              # foundation -- pure computation, no execution capability at all
    learner.py             # orchestrates ledger -> analytics -> patterns -> candidates
  scripts/inspect_ledger.py
  tests/                  # 99 tests
```

### Shared SQLite contract (task 11)

One database file, ownership split by table — never two competing
databases:

- **Trading-truth tables** (`trades`, `token_evaluations`,
  `daily_risk_state`) — created and written ONLY by the TypeScript engine
  (`engine/src/ledger/migrations/001_init.ts`). Python opens these
  **read-only** (`analytics/reader.py`, `mode=ro` URI connection) and never
  writes to them. `test_schema_compatibility.py` parses the real TS
  migration source and asserts its column names match
  `schema_contract.py`'s constants exactly — a genuine cross-language check,
  not just a documented convention.
- **Learning tables** (`strategy_versions`, `feature_snapshots`,
  `learning_runs`, `candidate_strategies`, `validation_results`) — created
  (idempotently) and written ONLY by `learning/db.py`, in the SAME file.
  The TypeScript engine does not read or write these in this phase.

Both sides use WAL mode, and `test_db_learning.py` verifies a read-only
connection to the trading-truth tables and a read-write connection to the
learning tables can be open against the same file simultaneously without
corruption or blocking.

### Learning engine (task 16)

`learning/learner.run_learning_cycle()`: reads closed trades for a
strategy version (read-only) → local statistics
(`analytics.statistics.compute_core_statistics`) → pattern discovery
(`analytics.patterns.discover_patterns`, gated at `MIN_TRADES_FOR_PATTERN`
= 50) → candidate generation
(`learning.candidates.generate_candidates_from_patterns`, gated at
`MIN_TRADES_FOR_PARAMETER_PROPOSAL` = 100) → records a `learning_runs` row
and any `candidate_strategies` rows (always `status='pending'`). It never
touches the trades table, never modifies the TypeScript engine's config,
and contains no AI/LLM call.

### Hard parameter protection (task 18)

`learning/candidates.validate_candidate_changes()` rejects any candidate
`changes` key that normalizes (lowercased, `_`/`-` stripped) to a known
hard-risk-parameter alias — position size, daily loss limit, max
re-entries, max exposure, max concurrent positions, max slippage, max price
impact, emergency stop, critical safety gates — covering common alternate
spellings (`position_size`, `positionSizeSol`, `POSITION-SIZE`, ...).
`build_candidate()` validates BEFORE constructing anything, so a rejected
candidate is never partially created. `generate_candidates_from_patterns()`
only ever maps a pattern to one of five explicitly whitelisted TUNABLE
parameters — it has no code path that could produce a hard-parameter change
even from a maliciously-labeled pattern.

### Strategy versioning (task 24)

`learning/db.py`'s `strategy_versions` table stores version, parent
version, parameters (JSON), created_at, reason, evidence, and separate
backtest/OOS/shadow result columns plus a `validation_status` field
(`proposed → backtested → oos_tested → shadow_tested → validated →
rejected`). Nothing in this phase ever transitions a version past
`proposed`, and nothing overwrites an existing version's row (`record_strategy_version`
uses `INSERT ... ON CONFLICT DO NOTHING`) — V1 is never silently modified.

### Preventing look-ahead bias (task 20)

`learning/validation.split_train_validation_oos()` splits a chronologically
-ordered trade list strictly by time (train = earliest slice, OOS = latest)
and calls `assert_no_temporal_leakage()`, which raises `TemporalLeakageError`
if any trade in a later split precedes the latest trade in an earlier one.
This is enforced code, not a comment — `test_validation.py` includes a case
that deliberately constructs a leaking split and confirms it's rejected.
`assert_single_strategy_version()` separately guards against mixing
different `strategy_version` values into one backtest/validation sample.

### AI token efficiency seam, not AI (task 23)

`analytics/reports.build_compact_summary()` produces exactly the small,
fixed-shape JSON object the original spec's AI-token-optimization example
shows (trade counts, win rate, avg PnL, median hold time, avg
slippage/impact, re-entry stats, max drawdown) — nothing else exists to
call an LLM with it. No OpenAI/Claude/Gemini/other provider code, API key
handling, or network call for AI purposes exists anywhere in this project.

## Files created

TypeScript: `execution/signer/{types,nullSigner}.ts` (modified),
`execution/signer/{keypairSigner,dryRunGuardedSigner,windowsDpapiSecretProvider}.ts`
(new), `execution/transactionSafety.ts` (new), `risk/hardLimits.ts` (new),
plus 5 new test files (41 new tests) and `test/risk/hardLimits.test.ts` (1 test).

Python: `python/` (renamed from `analytics/`), `analytics/{constants,features,statistics,patterns,reports}.py`
(new), `analytics/reader.py` (extended), `analytics/schema_contract.py`
(extended with learning-table + full trading-table column lists),
`learning/` (entirely new package: `db,candidates,validation,backtest,shadow,learner.py`),
plus 9 new test files (99 tests total, up from 4).

## What Phase 2 explicitly does NOT do

No live transaction was signed or broadcast. No LLM/AI API call exists
anywhere in this codebase. The trading strategy, all hard risk parameters,
the risk/exit/safety engines, and the ledger schema for trading-truth
tables are byte-for-byte unchanged from Phase 1.1.1. `LiveExecutorStub`
remains unimplemented and unreachable. No candidate strategy has ever been
promoted to production (nothing in this codebase can do that yet).
