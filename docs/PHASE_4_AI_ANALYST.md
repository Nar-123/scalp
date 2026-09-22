# Phase 4 — AI Analyst / Research Layer

Builds on Phase 1 / 1.1 / 1.1.1 / 2 / 3-alt. This phase adds an AI analyst
layer that is **outside the realtime trading path**, entirely. It activates
neither live trading nor any change to the finalized strategy:

- `DRY_RUN=true` remains the only mode. **No `LiveExecutor`. No transaction
  signing. No transaction broadcast.**
- The finalized V1 strategy (position size, filters, TP/SL, re-entry
  limits, daily loss limit) is **unchanged** — nothing in this phase writes
  to `engine/src/config/hardRisk.ts` or the TypeScript engine's config at
  all. AI-proposed candidates live only in Python's `candidate_strategies`
  table, at `status='pending'`, exactly like a locally-discovered candidate.
- **AI is an analyst, never the trader.** There is no code path from
  anything in `learning/ai/` to a BUY/SELL decision, to blocking a realtime
  evaluation tick, or to promoting a strategy.

## 1. Architecture: where the AI sits

```
Realtime path (TypeScript, unchanged by this phase):
  Market Data -> Trading Engine -> Risk Engine -> Execution -> Trade Ledger

Offline research path (this phase, Python only):
  Trade Ledger -> Local Analytics -> Pattern Discovery -> Compact Report -> AI Analyst
                                                                                |
                                                                                v
                                                              Candidate (status='pending')
                                                                                |
                                                                                v
                                        Backtest -> OOS -> Shadow -> Promotion Gate (Phase 3-alt, unchanged)
                                                                                |
                                                                                v
                                                        Human/system-controlled promotion (still separate, still manual)
```

`learning/ai/` is a Python package imported only by `scripts/learn_ai.py`,
`learning/ai/scheduler.py`, and their tests. Nothing in `engine/` (the
TypeScript realtime engine) imports, calls, or is called by anything under
`learning/ai/` — there is no IPC, no shared process, no callback from
Python back into the trading loop. The two languages' only shared contact
point remains the SQLite file, exactly as in Phase 2/3-alt, and AI writes
only ever land in `candidate_strategies` (as `origin='ai_analyst'`,
`status='pending'`) and three new AI-only tables — never `trades`,
`token_evaluations`, or `daily_risk_state`.

## 2. Input contract (`learning/ai/schema.py::AIAnalysisInput`)

Exactly the shape from spec section 4 — `strategy_version`,
`analysis_period{start,end}`, `sample_size`, `statistics`,
`feature_buckets`, `patterns`, `candidate_history`, `data_quality`,
`simulation_assumptions`. Built by `AIAnalysisService.build_input()` from
already-compact local analytics (`compute_core_statistics`,
`compute_pnl_by_bucket`, `discover_patterns` — all pre-existing, unchanged
Phase 2 modules). **There is no code path from a raw ledger row, raw RPC
response, private key, wallet secret, or full trade history into this
object** — it is constructed field-by-field from aggregates, never by
serializing a row or a file.

## 3. Output contract and validation (`learning/ai/schema.py::validate_ai_output`)

The exact shape from spec section 5. `validate_ai_output` is the **only**
way a provider's raw response is trusted:

- **Structural validation**: required fields present and correctly typed;
  `confidence` restricted to `{low, medium, high}`; `requires_more_data`
  must be boolean; `reasoning_basis`/`warnings` must be string lists.
  Anything else raises `AIOutputValidationError` and the whole analysis is
  rejected (recorded with `status='rejected'`, never silently dropped).

- **Fact vs. hypothesis separation (task 6), enforced structurally, not by
  convention**: every `observations`/`hypotheses` item must carry a
  `label` from `{OBSERVED, CALCULATED, ASSUMED, HYPOTHESIS, CANDIDATE}`.
  An `observations` item is rejected outright if its label is `HYPOTHESIS`
  or `CANDIDATE` (and vice versa for `hypotheses`) — the AI cannot present
  a hypothesis as a fact and have it pass validation.

- **Hallucination protection (task 25), mechanically checked, not just
  prompted for**: every `OBSERVED`/`CALCULATED`/`ASSUMED`-labeled item must
  include a `basis` field naming a dotted path (e.g.
  `"statistics.win_rate"` or `"feature_buckets.liquidity_bucket.20-30_SOL"`)
  that is resolved against the **exact** `AIAnalysisInput` object that was
  actually sent. A basis path that doesn't resolve — because the AI
  invented a statistic that was never in the input — fails validation.
  `HYPOTHESIS`/`CANDIDATE` items never require a basis (a hypothesis, by
  definition, isn't a cited fact).

- **Candidate-parameter validation (tasks 7, 8, 24)**, one proposal at a
  time so one bad proposal never discards a good one in the same response:
  1. `is_hard_parameter(name)` (reused from `learning/candidates.py`,
     unchanged) → `HARD_PARAMETER_MODIFICATION_REJECTED`.
  2. Not in `ALLOWED_SOFT_PARAMETERS` (a fixed whitelist mirroring the six
     tunable config groups) → `UNAUTHORIZED_PARAMETER_REJECTED`.
  3. `proposed_value` not a finite real number → `INVALID_VALUE_REJECTED`.
  4. Sample size below `MIN_TRADES_FOR_PARAMETER_PROPOSAL` (100) →
     `INSUFFICIENT_DATA` for every proposal in the response, regardless of
     how the AI phrased its confidence.

  A dedicated regression test
  (`test_ai_schema.py::test_allowed_soft_parameters_never_collide_with_a_hard_parameter_alias`)
  locks in that no whitelisted soft-parameter name (e.g.
  `max_price_impact_pct`, the entry-filter threshold) ever normalizes to
  collide with a hard-parameter alias (e.g. `maxPriceImpactBps`, the
  execution-safety limit) — a near-miss naming collision that would
  otherwise be a silent way to defeat hard-parameter protection.

## 4. Prompt design (task 23)

`learning/ai/service.py::PROMPT_PREAMBLE` is sent verbatim ahead of the
JSON input on every call:

> "You are an analyst reviewing trading-system statistics. You are not a
> trader. Do not give BUY/SELL instructions. Do not make profitability
> claims. Distinguish observations from hypotheses using the labels
> OBSERVED, CALCULATED, ASSUMED, HYPOTHESIS, and CANDIDATE. Only propose
> changes to whitelisted soft parameters. Never propose changes to hard
> risk parameters. Any candidate must be tested by the deterministic
> backtest/OOS/shadow pipeline before it can ever be promoted."

The prompt instruction is a first layer, never the enforcement mechanism —
`validate_ai_output` above is what actually rejects a response that
ignores the prompt.

## 5. Token optimization (task 13)

- `AI_MAX_INPUT_TOKENS = 3000`, `AI_MAX_OUTPUT_TOKENS = 1000`
  (`analytics/constants.py`) — the output budget is passed to every
  provider call (`max_output_tokens`); the input is bounded structurally by
  sending only the compact `AIAnalysisInput`, never raw data.
- `REALTIME_AI_CALLS = 0`: nothing under `learning/ai/` is reachable from
  the TypeScript realtime loop. AI is called only from a 6-hour scheduler
  tick or a manual CLI invocation.
- The meaningful-change gate (§7 below) and the cache (§6 below) are the
  two mechanisms that keep actual call volume near zero even for the
  scheduled path.

## 6. Caching (task 14)

`learning/ai/cache.py` computes a deterministic SHA-256 cache key from
`(strategy_version, analysis_period, feature_hash, pattern_hash, model,
prompt_version)` — `feature_hash`/`pattern_hash` are themselves SHA-256 of
the canonical (sorted-key) JSON of the feature-bucket summary and pattern
list, so two analyses are considered identical only if their actual content
matches, not just their labels. `learning/db.py::get_cached_ai_analysis`
looks up the most recent **completed** `ai_analyses` row for that key
before ever calling the provider; a hit returns immediately (with its own
usage-log row, `cache_hit=1`, `input_tokens=0`) and the provider is not
called a second time. Verified directly:
`test_ai_service.py::TestCaching::test_identical_analysis_is_served_from_cache_without_a_second_provider_call`
asserts the mock provider's call count stays at 1 across two `analyze()`
calls with identical inputs.

## 7. Local-analysis-first + trigger gating (tasks 11-12)

`AIAnalysisService.analyze()` runs, in order:

1. Local statistics (`compute_core_statistics`) and pattern discovery
   (`discover_patterns`) — both pre-existing, unchanged.
2. Sample-size gate: below `MIN_TRADES_FOR_PATTERN` (50) → returns
   `status='insufficient_data'` immediately. **The provider is never
   called.**
3. Meaningful-change gate (`detect_meaningful_change`, skipped when
   `force=True`): a statistically notable pattern exists, OR a repeated
   loss streak (`max_consecutive_losses >= 3`), OR a meaningful win-rate
   shift since the last completed analysis for this strategy version. None
   of these → `status='skipped_not_meaningful'`, **provider not called**.
   `force=True` (used by the manual `/learn-ai` command and by tests that
   want a call for setup purposes) bypasses this gate specifically — it
   does **not** bypass the sample-size gate, which always applies.
4. Only past both gates does `build_input()` run and a cache-key get
   computed; only past a cache miss is the provider actually invoked.

The scheduler (`learning/ai/scheduler.py`) always calls `analyze(force=False)`
so an idle 6-hour tick with nothing new costs zero provider calls; the
manual CLI (`scripts/learn_ai.py`) calls `analyze(force=True)` since a human
explicitly asked for an answer.

## 8. Provider abstraction (tasks 15-17)

```
Learning Engine (learning/ai/service.py::AIAnalysisService)
      |
      v
AIProvider (learning/ai/provider.py, abstract)
      ├── MockAIProvider        -- deterministic, network-free, used by every test
      └── HttpChatCompletionsProvider -- generic OpenAI-compatible-shaped HTTP client
```

`create_provider_from_env()` is the **one** place a provider is chosen,
reading `AI_PROVIDER` (default `"mock"`), `AI_MOCK_MODE`,
`AI_ANALYSIS_MODEL`, `AI_PROVIDER_BASE_URL`, `AI_PROVIDER_API_KEY_ENV`
(the *name* of an environment variable holding the key — the key itself
never appears in code or config). `HttpChatCompletionsProvider` never
hardcodes a vendor: it speaks the widely-shared OpenAI-compatible
chat-completions request/response shape, so any provider exposing that
shape works by changing `AI_PROVIDER_BASE_URL`/`AI_ANALYSIS_MODEL` alone.
Its HTTP transport is dependency-injected (`http_post_fn`), which is what
makes it fully unit-testable (request shape, status-code error mapping,
error-message sanitization) without ever making a real network call in
this project's test suite.

### Mock provider (task 17)

`MockAIProvider(mode=...)` deterministically produces every scenario task
30 asks for tests to cover: `"valid"`, `"malformed"`, `"hard_risk_attempt"`,
`"empty"`, `"timeout"`, `"rate_limit"`, `"network_error"`. No test in this
project's suite requires network access or an API key.

## 9. AI failure handling (task 18)

Every failure mode — provider timeout, rate limit, network error, empty
response, malformed JSON, failed output validation — is caught inside
`AIAnalysisService.analyze()` and turned into an `AIAnalysisResult(status='failed', ...)`.
**`analyze()` never raises an exception for any of these**, is never on the
realtime trading path in the first place, and never partially writes a
candidate: a failure produces a usage-log row (`success=0`) and, where
applicable, an `ai_analyses` row (`status='failed'` or `'rejected'`), and
nothing else. `test_ai_service.py::TestProviderFailureNeverRaises` and
`TestHardParameterRejection` cover this directly.

## 10. Usage tracking and reporting (tasks 19-20)

Every provider call (cache hit or miss, success or failure) writes one row
to `ai_usage_log` (`learning/db.py::record_ai_usage`): request id, analysis
id, timestamp, provider, model, `analysis_reason` (the trigger), input/
output/total tokens, `cache_hit`, `success`, `error`, `latency_ms`,
`estimated_cost_usd`. `learning/db.py::get_ai_usage_report(conn, since_ms)`
aggregates request count, token totals, cache hit rate, failed-call count,
and estimated cost — exposed via `scripts/ai_usage.py` (the `/ai_usage`
equivalent):

```
python scripts/ai_usage.py [path/to/ledger.sqlite] [--since-hours 24]
```

`learning/ai/usage.py::estimate_cost_usd` returns `None` (never a
fabricated number) for a model with no configured pricing entry — cost
estimation is illustrative and operator-editable, not fetched from any live
pricing API.

## 11. Prompt versioning (task 21)

`AI_DEFAULT_PROMPT_VERSION = "AI_PROMPT_V1"` (`analytics/constants.py`) is
recorded on every `ai_analyses` row and is one of the seven inputs to the
cache key (§6) — changing the prompt version invalidates the cache for
every future analysis and makes clear, in the persisted data, exactly which
prompt template produced a given result.

## 12. Security / sanitization (task 22)

`learning/ai/sanitize.py`:

- `sanitize_for_ai(payload)` — recursively redacts any dict key that looks
  secret-shaped (`private_key`, `secret`, `seed_phrase`, `api_key`,
  `password`, `credential`, `authorization`, `wallet_key`, etc.) and any
  string **value** that looks like a secret regardless of its key name
  (base58 in Solana-secret-key length range, a long hex blob, a
  JWT-shaped token) — applied to every prompt payload in
  `AIAnalysisService._build_prompt()`, on top of the structural guarantee
  that `AIAnalysisInput` never contains raw ledger rows in the first place.
- `sanitize_error_message(text)` — scrubs the same secret shapes out of
  free-text error messages before they are ever recorded or printed, so a
  misbehaving HTTP provider echoing back a header (e.g.
  `"Authorization: Bearer sk-..."`) can't leak it through an exception
  message; `HttpChatCompletionsProvider` routes every exception message it
  raises through this function.

## 13. Candidate handoff (task 26) and no automatic promotion (tasks 9, 27)

`AIAnalysisService.analyze()` hands each **accepted** proposal to
`learning/candidates.py::build_candidate` — the exact same function
Phase 2's local pattern discovery already uses — and writes it via
`learning/db.py::record_candidate(..., origin='ai_analyst')`. There is no
second candidate implementation: `build_candidate` independently
re-validates against the hard-parameter list a second time (defense in
depth), and every candidate this pipeline produces enters at
`status='pending'`, indistinguishable in its lifecycle from a
locally-discovered one — same `Backtest -> OOS -> Shadow -> Promotion Gate`
pipeline from Phase 3-alt, completely unmodified by this phase.

**AI confidence is never a promotion criterion.** A candidate proposed with
`confidence: "high"` is written with exactly the same `status='pending'`
as one proposed with `"low"` — verified by
`test_ai_service.py::test_high_confidence_from_the_ai_does_not_change_the_pending_status`.
Promotion still only ever happens via `learning/promotion.py::evaluate_promotion`
requiring every one of `backtest`/`out_of_sample`/`shadow` to have
explicitly passed, and even then, `'promoted'` remains a database label a
human reviewer acts on — nothing here or in Phase 3-alt applies a promoted
candidate to the live engine automatically.

## 14. Scheduled and manual triggers (tasks 28-29)

- **Scheduled** (`learning/ai/scheduler.py::run_ai_scheduler_loop`):
  default `AI_SCHEDULED_RESEARCH_INTERVAL_SEC = 6 * 3600` (6 hours),
  independent of the 1-hour local-learning scheduler from Phase 3-alt.
  Always `force=False` — an idle tick with nothing meaningful costs zero
  AI calls.
- **Manual** (`scripts/learn_ai.py`, the `/learn-ai` equivalent): the exact
  8-step flow from spec section 29 — local analytics, pattern check
  (informational; `force=True` bypasses only the *meaningful-change* gate,
  never the sample-size gate), compact summary, call AI, validate, store,
  create candidates if valid, leave them PENDING.

## 15. Testing (task 30)

7 new test files, 88 new tests, all network-free:

- `test_ai_schema.py` — input shape, output structural validation, fact/
  hypothesis label separation, hallucination protection (valid and invalid
  basis paths), hard/unauthorized/invalid/insufficient-data candidate
  rejection (including a parametrized sweep over every known hard-parameter
  spelling), and the soft/hard naming-collision regression.
- `test_ai_sanitize.py` — secret-shaped keys, secret-shaped values
  regardless of key, recursion into nested structures, non-mutation, and
  error-message scrubbing (including the `Authorization: Bearer` case).
- `test_ai_provider.py` — every `MockAIProvider` mode; `HttpChatCompletionsProvider`
  construction failure without an API key, request-shape/response-parsing
  via an injected transport, HTTP status-code error mapping (429/5xx),
  empty-body handling, and that its error messages never leak the API key;
  `create_provider_from_env`'s default/override/misconfiguration paths.
- `test_ai_cache.py` — key stability under dict-key reordering, and key
  changes when content, model, or prompt version changes.
- `test_ai_usage.py` — unknown-model returns `None`, known-model
  arithmetic.
- `test_ai_service.py` — sample-size gate, meaningful-change gate (and
  `force` bypassing only that gate), successful analysis creating a pending
  `origin='ai_analyst'` candidate, high confidence not affecting promotion
  status, analysis/usage persistence, hard-parameter rejection producing no
  candidate, cache hit/miss (including that a hit still logs usage), and
  every provider-failure mode never raising and never touching
  `candidate_strategies`.
- `test_ai_scheduler.py` — meaningful-change-gated scheduled tick, a
  deterministic multi-iteration loop via injected sleep/tick callbacks, and
  the 6-hour default.

**Regression**: all 135 Phase 3-alt Python tests and all 263 TypeScript
tests continue to pass unmodified — this phase touched zero TypeScript
files. Final count: **223 Python tests** (135 + 88 new), **263 TypeScript
tests**, **486 total**.

## 16. Known limitations

- `HttpChatCompletionsProvider` is real, working code but is not exercised
  against a live network by this project's test suite (no API key, no
  network access in CI) — only its request-building, response-parsing, and
  error-mapping logic are unit tested via an injected transport function.
  Wiring a specific real provider account is a follow-up operational step,
  not a code change.
- `estimate_cost_usd` ships with an empty default pricing table — cost
  reporting will show `$0.0000` until an operator supplies real per-model
  rates, by design (never a fabricated number for an unrecognized model).
- The meaningful-change detector (`detect_meaningful_change`) implements
  three of spec section 11's listed triggers concretely (notable pattern,
  repeated-loss streak, win-rate shift); the remaining two ("unusual market
  regime", "candidate requiring interpretation") are not independently
  detected — they are caller-driven instead (a human can always force an
  analysis via the manual trigger).
- Hallucination protection is mechanical, not semantic: it verifies a cited
  `basis` path resolves to something present in the sent input, which
  catches invented statistics/patterns but cannot verify that the AI's
  prose *summary* of a fact is phrased accurately.
