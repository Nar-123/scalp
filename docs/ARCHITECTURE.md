# Architecture — Phase 1: Foundational Core

See `docs/SPEC.md` for the full frozen specification. This document covers
what Phase 1 actually built, how it's structured, what's verified against
live mainnet data vs. still unverified, and the seams left for later passes.

## Module map (`engine/src/`)

```
config/       Typed config (zod) + HARD_RISK_PARAMETERS (frozen, isolated)
types/        Shared TS types (token, market, signals, trade)
discovery/    Token discovery: Raydium/pump.fun log subscriptions,
              DexScreener/Birdeye aggregator fallback, age-window filter,
              program-log scoping (programLogs.ts)
safety/       Deterministic safety gate: mint/freeze authority, holder
              concentration, liquidity, sellability heuristic
scoring/      Entry score + expected-net-edge calculators
risk/         Risk engine: daily loss circuit breaker, exposure manager,
              re-entry tracker, emergency stop, composed in riskEngine.ts
exit/         8 exit conditions + the priority-ordered exit engine
execution/    ExecutionEngine interface, DryRunExecutor (real quotes,
              simulated fills), LiveExecutorStub (throws -- deferred),
              Jupiter quote client, Signer interface + NullSigner
ledger/       node:sqlite-backed trade ledger (WAL mode), migration
orchestrator/ Wires discovery -> safety -> scoring -> risk -> execution ->
              ledger into one loop; PositionMonitor polls open positions
logging/      pino logger with secret redaction (never mutates frozen
              log payloads; narrowly scoped to real secret-shaped keys)
```

## The hard-risk isolation boundary

`config/hardRisk.ts` exports a frozen `HARD_RISK_PARAMETERS` object plus
`assertHardRiskUnmodified()`, called once at startup. An ESLint rule
(`engine/eslint.config.js`) fails the build if any file outside
`config/`, `risk/`, or `orchestrator/` imports it directly — this is the
concrete enforcement of spec section 10 ("the AI must NEVER directly
modify [hard risk parameters]"). When the Python analytics/learning pipeline
or an AI analyst module is added in a later pass, it must read the trade
ledger only — it has no code path to `hardRisk.ts` at all, and the lint
rule keeps it that way even under refactors.

## Verified live during this pass, and what that caught

The engine was run against real Solana mainnet (public RPC) during
development, which caught three real bugs before they could ever have
mattered in production:

1. **Versioned transactions**: `getParsedTransaction` needed
   `maxSupportedTransactionVersion: 1`, not `0` — real pump.fun/Raydium
   traffic includes v0 transactions.
2. **Log-attribution false positives**: a naive whole-transaction substring
   search for a creation-instruction marker (e.g. `"Instruction: Create"`)
   matched ordinary Buy/Sell swaps, because (a) it matched unrelated
   instruction names sharing a prefix (`CreateTokenAccountWithSeed`), and
   (b) it didn't distinguish "logged by our target program" from "logged by
   some other program elsewhere in the same transaction" (an aggregator
   router CPI-ing into pump.fun, or the SPL Associated Token Account
   program creating the buyer's ATA). Fixed in `discovery/programLogs.ts`,
   which walks the program invoke/success stack so only log lines truly
   emitted by the target program's own frame are considered. A real
   captured false-positive transaction is a regression fixture in
   `test/discovery/programLogs.test.ts`.
3. **Logger crash on frozen payloads**: the original secret-redaction
   regex matched bare `"token"` (case-insensitive) as a substring, which
   matches ubiquitous Solana domain terms like `maxReentriesPerToken` and
   `tokenAgeSec` — and the redactor mutated log objects in place, so
   logging `HARD_RISK_PARAMETERS` (frozen) crashed at startup. Fixed by
   narrowing the regex to real secret shapes (`apiKey`, `privateKey`,
   `authToken`, etc., never bare `token`) and making redaction build a new
   object instead of mutating the input.

**Update (Phase 1.1, see `docs/PHASE_1_1_DISCOVERY_VALIDATION.md`)**: the
log-marker approach described above was superseded. pump.fun creation
detection is now instruction-level (exact Anchor discriminator, read from
pump.fun's own on-chain IDL, plus an account-relationship check) and fully
confirmed against real captured creation transactions, including one where
the creation instruction is nested inside a third-party bundler program.
Raydium detection is also instruction-level now, but its `initialize2` tag
value remains **unconfirmed against a live example** — Raydium is a native
program with no on-chain IDL, and live sampling found evidence its real
instruction numbering may not match the widely-cited historical enum. See
that document for the full investigation, what was tried, and the
deliberate fail-closed dual-signal design this leads to for Raydium.

**Further update (Phase 1.1.1, see `docs/PHASE_1_1_1_RAYDIUM_HARDENING.md`)**:
Raydium detection was hardened further — strictly scoped to the AMM V4
program ID only (never applied to any other Raydium program), plus full
`initialize2` account-layout validation (pool, LP mint, coin/PC mint,
vaults, market, signing user wallet). Still not live-confirmed; the
"valid" test case is a clearly-labeled synthetic transaction, not a
captured one. pump.fun detection is unaffected by this update.

## What's stubbed vs. fully implemented

**Fully implemented, real logic (not stubs)**: config + frozen hard-risk
module; Raydium + pump.fun log-subscription discovery with instruction-level,
evidence-based creation detection (see `docs/PHASE_1_1_DISCOVERY_VALIDATION.md`);
DexScreener/Birdeye aggregator client; the
full on-chain safety gate (mint/freeze authority via `@solana/spl-token`,
holder concentration via `getTokenLargestAccounts`, liquidity threshold,
sellability via a real Jupiter round-trip quote); entry scorer + net-edge
calculator; the full risk engine (daily circuit breaker with latching,
exposure/concurrency caps, re-entry cap + cooldown + consecutive-loss
cutoff, emergency stop); all 8 exit conditions plus priority ordering;
`DryRunExecutor` producing realistic simulated fills from live
Jupiter/DexScreener quotes; the SQLite trade ledger; an end-to-end
orchestrator; 147 unit tests covering all of the above deterministically.

**Stubbed / explicitly deferred**:
- `LiveExecutorStub` — interface exists, `buy`/`sell` throw. The
  orchestrator refuses to start at all if `DRY_RUN=false` in this pass
  (see `src/index.ts`), since there is no real `Signer` to pair it with.
- `Signer` — only `NullSigner` exists (always throws). Real signing via
  Windows Credential Manager is a separate pass by design, so key handling
  never had to be designed under this pass's time pressure.
- Python `analytics/` package — a read-only ledger reader + a CLI summary
  script only, proving the shared-file contract. No statistics beyond a
  basic win-rate/PnL summary, no pattern discovery.
- No AI/LLM code at all. The only seam is `strategyVersion` in config
  (default `"baseline-v1"`) and the `token_evaluations`/`trades` ledger
  tables recording *every* scored token (not just traded ones) — exactly
  what a future learning pipeline needs, without any AI-facing code
  existing yet to misuse it.
- No Telegram bot, no backtesting/OOS/shadow-trading machinery.

## Roadmap for later passes

1. Windows Credential Manager–backed `Signer` + a real `LiveExecutor`
   (transaction building, simulation, submission, confirmation).
2. Python local-analytics/pattern-discovery pipeline reading the ledger.
3. Backtesting + out-of-sample harness.
4. Shadow trading + validation gate for promoting a new `strategyVersion`.
5. Rate-limited/cached/token-budgeted AI analyst layer — read-only over
   analytics output, structurally unable to import `config/hardRisk.ts` or
   touch the order path (enforced the same way orchestrator/risk/config
   already are).
6. Telegram monitoring/control bot.

## Running it

See the root `README.md` for setup and the `npm run start --workspace=engine`
DRY_RUN walkthrough.
