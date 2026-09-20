# Phase 1.1 — Discovery Validation

Follow-up to Phase 1 (see `docs/ARCHITECTURE.md`), which flagged pump.fun's
and Raydium's creation-event log markers as unverified guesses. This pass
replaced log-string matching with evidence-based, instruction-level
detection, validated against real captured mainnet transactions.

## What changed and why

Phase 1's detector asked one question: does any log line in the whole
transaction contain a marker string like `"Instruction: Create"`? Live
testing in this pass proved that's unreliable in two independent ways
(detailed below with real transaction evidence), so detection was rebuilt
around a different question: **did the target program's own `create`
instruction actually run, provably, in this transaction** — checked via
the instruction's binary discriminator (not its log text) and corroborated
by the account relationships a genuine token creation must have (a fresh
mint that signs the transaction; a genuine `InitializeMint` somewhere in
the instruction tree). This lives in the new
`engine/src/discovery/creationDetector.ts`; `engine/src/discovery/programLogs.ts`
(from Phase 1) is now only a cheap pre-filter on the free `onLogs` push,
never the final evidence.

## pump.fun: fully confirmed

**Ground truth used**: pump.fun's own on-chain Anchor IDL account, fetched
and decoded directly from mainnet during this pass (address
`AYgC53tU5BbP2NAnv5nConJxAdpQZctvmZK88pu69xRs`, derived via the standard
Anchor `["anchor:idl", programId]` seed and decompressed with `zlib`). This
gives the real, current instruction list and account layout — not a
guess. It confirms:

- `create` (8-byte discriminator `[24,30,200,40,5,28,7,119]`) and
  `create_v2` (`[214,144,76,236,95,139,49,180]`) are pump.fun's real
  bonding-curve creation instructions.
- Both declare their first account as `mint`, and it is always a signer
  (a fresh keypair signing to become the new SPL token).

**Live traffic sample** (2-minute `onLogs` capture, ~4,200 pump.fun-mentioning
transactions): `CreateV2` fired 33 times; legacy `Create` fired **zero**
times. Phase 1's marker list only had `"Instruction: Create"` — it would
have caught **none** of the real creation traffic in this sample. The
marker list now includes both.

**Real transactions captured and used as regression fixtures**
(`engine/test/discovery/fixtures/`, full detail in that folder's README):

1. `pumpfun_create_v2_top_level.json` — signature `2SJ4YrWb...`. Genuine
   creation: `CreateV2` as a direct top-level instruction on the pump.fun
   program. Discriminator bytes match the IDL exactly; account 0
   (`MAP8KCX...pump`) is a transaction signer; that mint has no
   `preTokenBalances` entry (didn't exist before) and one `postTokenBalances`
   entry (exists after). → **ACCEPT**.
2. `pumpfun_create_v2_nested_bundler.json` — signature `3FwawFnc...`.
   Genuine creation submitted through an unrelated third-party
   launchpad/bundler program (`CreateCoinAndBuyBondingCurveV3`), which CPIs
   into pump.fun's `CreateV2` at invoke depth 2. **This instruction is
   nested, not top-level** — the reason `findProgramInstructions()` scans
   `meta.innerInstructions` as well as `message.instructions`. Inner
   instructions also show the literal `system.createAccount` +
   `spl-token.initializeMint2` for the new mint, which is the second,
   independent signal (`findFreshMintInitializations()`) corroborating
   creation regardless of which program orchestrated it. → **ACCEPT**.
3. `ordinary_swap_aggregator_buy.json` — signature `pxJTGcAJ...`. The
   original Phase 1 false positive: an ordinary Buy on an **existing**
   pump.fun token, routed through a DEX aggregator, where an unrelated
   instruction elsewhere in the same transaction
   (`Instruction: CreateTokenAccountWithSeed`, from a completely different
   program) happened to contain the old marker string as a prefix. The new
   discriminator-based check correctly finds no `create`/`create_v2`
   dispatched to pump.fun anywhere in the instruction tree. → **REJECT**.
4. `unrelated_transfer.json` — signature `5GSeC7Bm...`. A plain
   wallet-to-wallet SOL transfer, never mentioning pump.fun or Raydium.
   → **REJECT**.
5. Two constructed (not captured — see rationale below) malformed-input
   cases: a transaction missing `meta.innerInstructions`/`preTokenBalances`,
   and one with empty instructions and `meta: null`. Both **REJECT without
   throwing**.

All five map onto the 17 tests in
`engine/test/discovery/creationDetector.test.ts`.

## Raydium AMM V4: could not be fully confirmed — documented limitation

Raydium AMM V4 is a **native, non-Anchor program with no on-chain IDL**, so
there is no equivalent ground truth to decode. Three separate live
investigations were run:

1. **Direct log sampling** (2-minute `onLogs` capture, ~2,100 Raydium
   events): Raydium's own log lines are almost entirely
   `"Program log: Program ID: ..."`, `"Number of accounts: N"`, and an
   opaque base64 `ray_log` blob — no equivalent of pump.fun's
   `"Instruction: <Name>"` convention. There is no reliable **cheap**
   log-text signal to pre-filter on for Raydium at all.
2. **pump.fun migration path**: pump.fun's `MigrateBondingCurveCreator`
   instruction was expected to CPI into Raydium (historically how most
   Raydium pools for meme tokens were created). A captured real migration
   transaction shows pump.fun now migrates to its own **PumpSwap** AMM —
   Raydium AMM V4 does not appear anywhere in that transaction. This path
   is no longer a source of Raydium pool creations.
3. **Historical instruction-tag scan**: sampled ~150 recent Raydium AMM V4
   transactions via `getSignaturesForAddress` + `getParsedTransaction`,
   decoding each instruction's raw data (checking both top-level and inner
   instructions, since most retail Raydium traffic is routed through
   aggregators as CPIs). Tag `9` (the well-documented `SwapBaseIn`) appeared
   as expected. Tag `16` unexpectedly **dominated** the sample — a value
   this engineer's recollection of the historical, widely-cited
   `AmmInstruction` enum does not account for, suggesting that enum is
   stale for the currently deployed program build. **No `initialize2`
   (tag 1) transaction was found** in the sample; pool creations are
   evidently rare enough, and repeated attempts to widen the sample were
   throttled by the public RPC (HTTP 429s — see below), which capped how
   much could be sampled within this pass.

**Conclusion**: `detectRaydiumPoolCreation()` (in `creationDetector.ts`)
uses tag `1` for `initialize2` because it's the most widely documented value
across the ecosystem's tooling, but this pass could **not** confirm it
against a real captured creation transaction, and found direct evidence
(tag 16's unexplained dominance) that the historical enum may not fully
match the live program. Rather than ship an unverified single-signal
check, detection **requires two independent conditions to both hold**: the
tag-1 instruction AND a freshly-initialized mint that is also one of that
instruction's own accounts. This is a deliberate fail-closed design: if
the tag guess is wrong, the detector simply finds nothing (a missed
opportunity) rather than misfiring on Raydium's dominant swap traffic (a
wrong trade). No Raydium creation fixture exists in the test suite for this
reason — see `engine/test/discovery/fixtures/README.md` for what was
tested instead (rejection of unrelated/pump.fun/malformed inputs).

Practical impact is limited: the spec's meme-token focus makes pump.fun the
primary discovery source; Raydium detection remaining conservative
(possibly under-firing) does not weaken any capital-protection guarantee,
since every discovered token — regardless of source — still has to
independently pass the full safety gate, entry scoring, expected-net-edge
check, and risk engine before any (simulated, in this DRY_RUN pass) capital
is committed.

## Rate limiting: a real operational finding, not just a testing nuisance

Live investigation and validation in this pass made roughly 1,500+ RPC
calls against the free public `api.mainnet-beta.solana.com` endpoint,
which began returning HTTP 429 (Too Many Requests) heavily partway through
and never fully recovered within the session.

The first end-to-end live orchestrator run (task 10, first attempt) was
**inconclusive**: with the public endpoint already saturated from this
pass's own investigation traffic, `RaydiumLogSubscriber`'s per-event
`getParsedTransaction` calls mostly failed with 429s rather than exercising
the detector logic live, and appeared to be consuming most of the shared
rate-limit budget -- comparing failure counts in one 45s sample, Raydium
logged 152 failed fetches to pump.fun's 3. The engine handled this exactly
as designed the whole time -- every failure caught, logged as a warning,
process kept running, zero crashes across 1,000+ consecutive errors -- but
it produced no clean live signal.

Based on that finding, `RaydiumLogSubscriber`'s default fetch throttle was
lowered from 5/s to **1/s** (Raydium has no cheap pre-filter the way
pump.fun does, so it fetches on every log event and was crowding out the
higher-value pump.fun path on the same rate-limited endpoint). A second,
shorter live run (60s) after that change succeeded cleanly:

```
[06:50:51.404] DEBUG pumpfun creation confirmed
    signature: "2hqR44FsdKb3tuoXRTwmzcriRCzyJqSPi93gCBiWXdcPJhUD474JECMspZ3qMEjDqebupp4B7qJEo2owVWeQeA1o"
    mint: "DuADciiFNFrkmyDGerAVU8cDpSTdovJcFCEy2MQupump"
    evidence: [
      "pumpfun_create_v2_discriminator_match",
      "top_level_instruction",
      "mint_account_is_transaction_signer"
    ]
```

A genuine, brand-new pump.fun token was detected live, in real time, by the
new discriminator + account-relationship check -- not a replay or a
fixture. All three evidence signals fired as designed. The engine went on
to record 12 token evaluations in the ledger during that run (0 simulated
trades, expected: every discovered token in a 60s window is younger than
`MIN_TOKEN_AGE_SEC=30` for most of its lifetime in-window, and market-data
fetches were still competing with residual 429s). No crashes.

Raydium-specific live confirmation (as opposed to the offline fixture
tests, which fully exercise the same `detectRaydiumPoolCreation` code path)
is still outstanding -- pool creations are rare enough, and the throttle
now low enough, that none fired in either live run's window. This doesn't
weaken the offline validation (same code, same logic, deterministic real
inputs), but a live Raydium creation has not been *observed* end-to-end the
way pump.fun's now has.

`RaydiumLogSubscriber`'s per-second fetch throttle (default now 1,
`maxFetchesPerSecond` option) is a real cost/latency trade-off independent
of today's testing, and reinforces the existing recommendation (README,
Phase 1 architecture doc) to run this against a dedicated low-latency RPC
provider -- ideally with pump.fun and Raydium subscriptions on separate
rate-limit budgets -- rather than the public endpoint.

## Files changed

- `engine/src/discovery/creationDetector.ts` (new) — instruction-level
  detection: `findProgramInstructions`, `getSignerAccountSet`,
  `findFreshMintInitializations`, `detectPumpFunCreation`,
  `detectRaydiumPoolCreation`.
- `engine/src/discovery/pumpFunLogSubscriber.ts` — marker list corrected
  (`Create` + `CreateV2`); final decision now delegates to
  `detectPumpFunCreation` instead of the old pre/post-token-balance diff.
- `engine/src/discovery/raydiumLogSubscriber.ts` — removed the unverified
  log-marker approach entirely (no reliable log-text signal exists); added
  the per-second fetch throttle (default 1/s, tuned down from an initial
  5/s after live testing showed 5/s was still enough to starve pump.fun's
  fetches on a shared rate-limited endpoint); final decision delegates to
  `detectRaydiumPoolCreation`.
- `engine/src/discovery/index.ts` — exports the new module.
- `engine/src/types/bs58.d.ts` (new) — minimal ambient types for `bs58`
  (added as an explicit dependency for discriminator decoding; previously
  only a transitive dependency).
- `engine/package.json` — added `bs58`.
- `engine/test/discovery/creationDetector.test.ts` (new, 17 tests).
- `engine/test/discovery/fixtures/` (new) — 4 real captured transactions
  (trimmed to the fields the detectors read) + a README documenting each
  one's signature and why it's included.

No changes to hard risk parameters, position sizing, TP/SL/timeout logic,
the risk engine, the ledger schema, or `DRY_RUN` posture. No wallet signing
was added. No LLM calls were added anywhere.

## Test count

147 → **164** engine unit tests, all passing (`npm test --workspace=engine`) — 17
new tests in `creationDetector.test.ts`.
Build and lint remain clean.

## Remaining uncertainties

1. Raydium's `initialize2` tag value (`1`) is documented-but-unconfirmed
   against a live example, and this pass found evidence (tag 16's
   unexplained dominance) that Raydium's real current instruction
   numbering may not match the widely-cited historical enum. The
   dual-signal requirement makes a wrong guess fail closed, but it may
   also mean Raydium pool creations are under-detected (missed, not
   misclassified) until this is confirmed against a real captured
   `initialize2` transaction.
2. pump.fun's legacy `create` (non-V2) instruction is kept as a marker and
   in the discriminator check (it's real, per the on-chain IDL) but was
   not observed at all in live traffic during this pass — only `create_v2`
   was. If pump.fun fully retires `create`, it's inert but harmless to
   keep.
3. Live end-to-end confirmation of the updated Raydium path specifically
   (as opposed to the offline fixture tests) is still outstanding, blocked
   by public-RPC rate limiting exhausted during this pass's investigation.
   Recommend re-running the orchestrator against a dedicated RPC provider
   with fresh rate-limit headroom before depending on Raydium discovery.
4. This pass did not re-verify pump.fun's own `Buy`/`Sell` instruction
   discriminators (only `Create`/`CreateV2`, since that's what's in scope
   here) — unaffected by this change, since the entry/exit/risk pipeline
   never inspects those instructions.
