# Phase 5.6C — Duplicate-entry race fix

Labels: **[implementation]**, **[measured]**, **[limitation]**, **[observation]**. Scope: only the duplicate-entry race. No strategy, threshold, risk-limit, safety-policy, Jupiter or DexScreener change. DRY_RUN only.

## 1. Root cause [observation, confirmed by the ledger and by a mutation test]
`orchestrator/loop.ts` starts `evaluateToken` for every watched token every 2 s with `setInterval(() => void evaluateToken(...))` and never waits for the previous evaluation. With the quote limiter at 0.5 rps the real safety gate takes longer than 2 s, so tick N+1 joined tick N's in-flight quotes; both passed, both ran the risk check (which sees no open position yet) and both bought and recorded an entry for the same mint. Measured before the fix: 2 evaluations passed per token and 2 identical trades per token (same entry instant to the millisecond, same exit, same PnL): reported PnL +0.0468 SOL, true +0.0234 SOL, exposure 0.6 SOL against a 0.3 SOL position size.
A second, related window existed between "risk allows the entry" and "position recorded" (an `await` on the execution call): other tokens deciding in that window did not see the pending entry, so the concurrent-position/exposure limits could be exceeded across tokens.

## 2. Files
New: `engine/src/orchestrator/evaluationGuard.ts`, `engine/test/orchestrator/evaluationGuard.test.ts`, `engine/test/pipeline/entryRace.test.ts`.
Changed: `engine/src/orchestrator/loop.ts` (guard wiring, entry commit, one optional dependency `evaluationTimeoutMs`, default 30 s).
Not touched: `config/*`, `risk/*`, `exit/*`, `scoring/*`, `safety/*`, `execution/*`, `engine/.env`.

## 3. Guard design [implementation]
1. **Per-token evaluation lease** (`EvaluationGuard`). `tryAcquire(mint)` is synchronous and is called in `evaluateToken` before the first `await` of the evaluation. JavaScript runs one task at a time, so two ticks can never both acquire (no `await` between check and claim). A tick that finds a live lease is skipped. Leases are per mint: different tokens evaluate concurrently, nothing is global.
2. **Release in every completion path**: the lease is released in a `finally` (entry, rejection, failed safety, quote failure, exception; a thrown error is still logged as before).
3. **Timeout takeover**: a lease older than `evaluationTimeoutMs` (30 s) is considered stuck. The next tick takes it over with a NEW lease; the stuck holder becomes stale (`isCurrent` is false), so when it eventually resumes it cannot commit an entry, and its late `release` does not free the new holder's lease.
4. **Entry commit** (second guard). The risk decision and the following reservation contain no `await`, so they are atomic. At commit the loop refuses the entry when (a) the evaluation was superseded (`evaluation_superseded`), (b) the ledger already has an OPEN position on this mint (`position_already_open`), or (c) a buy for this mint is already in flight (`entry_in_progress`). Otherwise it reserves the entry (`EntryReservations`) and releases the reservation in a `finally` only after the position is recorded or the buy failed/threw.
5. **Limits hold across tokens**: pending reservations are passed to the existing `evaluateEntryRisk` together with the ledger's open positions, so `maxConcurrentPositions` (3) and `maxTotalExposureSol` (0.9) are checked against entries that are decided but not yet recorded. No limit value changed.

## 4. Why the race is eliminated
Same-token duplicates need two evaluations of one mint alive at once; the lease makes that impossible without depending on timing. A stale (timed-out) evaluation is stopped at the commit by `isCurrent`, and any second entry while a buy is in flight is stopped by the reservation. A sequential second entry while the first position is still open is stopped by `position_already_open`. Cross-token limit races are closed by counting reservations.

## 5. Re-entry [implementation]
Unchanged. The lease is released when an evaluation finishes, and `position_already_open` looks only at OPEN positions, so after a position closes the existing policy (cooldown 60 s, consecutive-loss limit, max 5 re-entries) alone decides. Note: before this fix nothing stopped a SECOND position on a token while the first was still open (re-entry policy only looks at closed trades); `position_already_open` is a small, separately named check that closes that gap. It is one condition and is easy to remove if you consider a second concurrent position on one token intentional.

## 6. Tests [measured]
`test/orchestrator/evaluationGuard.test.ts` (8, deterministic): same-token overlap skipped synchronously; different tokens independent; release on every path; timeout takeover with stale holder unable to commit or to free the new lease; idempotent release; non-positive timeout rejected; reservations refuse duplicates and count toward limits.
`test/pipeline/entryRace.test.ts` (9, real production loop, real timers, synthetic bonding curve, only the safety gate replaced so its latency is controllable): gate 3.5 s (> 2 s tick) enters exactly once with max one active evaluation per token; entry succeeds and no duplicate, exposure 0.3 SOL, PnL once; two tokens run concurrently (max 2 active) and enter once each; first evaluation fails then a later tick enters; first evaluation throws then a later tick enters; first evaluation never returns then the takeover enters once and the resumed stale one cannot enter; re-entry after close (cooldown 0) is a later, non-overlapping second trade; open position blocks a second one; four tokens with a 700 ms buy delay never exceed 3 concurrent positions.
**Mutation check:** with the guard, the open-position check and the reservations disabled, three of these tests fail on the original bug (2 trades for one token; 4 concurrent positions with a limit of 3), then pass again with the fix restored.

Full result: TypeScript 74 files / **648 tests** (631 before), Python **242**, `tsc` both configs, `eslint`, `npm run build` clean.

## 7. DRY_RUN regression [measured]
25 minutes, normal production loop, Helius HTTP + public WS, `JUPITER_MAX_RPS=0.5`, scratch ledger, shadow off, real safety gate.
- 703 tokens, 202,207 native evaluations, 21 tokens (150 evaluations) reached the gate; 3 passed safety (3 tokens, 1 evaluation each).
- **3 trades, 3 exits, one per passing token; identical-entry duplicates 0; same-mint overlapping positions 0; total exposure 0.9 SOL = 3 x 0.3; PnL counted once: +0.021538 SOL** (+0.020267, +0.002091, -0.000819). Before the fix each passing token had 2-4 passing evaluations and 2 identical trades.
- Coverage: 439,451 notifications, 0 truncated logs, 0 coverage breaks; Helius 2,260/2,260 ok; Jupiter 447 ok, 0 HTTP 429.
- Process: RSS 250 to 360 MB (still rising slowly), CPU mean 18.3%, lag p99 at most 70 ms. Shutdown exit 0 after 3.1 s (one step reached its 3 s bound; earlier runs took about 0.1 s; not investigated, not related to the guard).
Limitation: the live run shows the fix working on 3 real entries, but a race needs a slow gate at the moment of a pass; the deterministic tests and the mutation check, not the live run, are the proof.

## 8. Confirmation
No V1 threshold, position size, exit, re-entry limit, daily-loss limit, exposure limit, holder rule, round-trip rule, expected-net-edge formula, Token-2022 policy, Jupiter limit or DexScreener behaviour was changed (config and risk files untouched; `hardRisk.ts` identical to HEAD). No signer, transaction or wallet code; `engine/.env` untouched; nothing committed.
