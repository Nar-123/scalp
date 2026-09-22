# Phase 1.1.1 — Raydium Detection Hardening

Follow-up to Phase 1.1 (`docs/PHASE_1_1_DISCOVERY_VALIDATION.md`), which got
pump.fun creation detection to a fully-confirmed state but left Raydium's
`detectRaydiumPoolCreation()` as a single tag-byte check plus a loose
"fresh mint anywhere in the instruction's accounts" corroboration. This pass
hardens that into full account-layout validation and tightens the
program-ID scoping, without ever claiming live confirmation that still
doesn't exist.

## Supported Raydium program IDs

**Only one**: Raydium **AMM V4**, `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
(exported as `RAYDIUM_AMM_V4_PROGRAM_ID` in `creationDetector.ts`; matches
`discovery.raydiumProgramId`'s default in `config/schema.ts`).

`detectRaydiumAmmV4PoolCreation(tx, programId)` checks `programId` against
this constant as its very first step and returns `{ detected: false,
evidence: ['unsupported_raydium_program_id'] }` immediately for anything
else -- it never attempts to decode a tag byte or account layout for a
program it wasn't given the AMM V4 ID for. `RaydiumLogSubscriber` also now
warns at startup if it's configured with a different program ID, since
detection would silently never fire for it otherwise.

## NOT supported

Raydium ships several other on-chain programs with **different program
IDs and different instruction encodings** -- notably a newer CPMM
(constant-product) program, a CLMM (concentrated-liquidity) program, and a
stable-swap program. None of these are decoded by this detector, and their
exact program IDs are deliberately **not asserted here**: doing so from
memory without on-chain verification would repeat exactly the mistake this
whole Phase 1.x effort exists to correct (see Phase 1's original
unverified log-marker guesses). If pool creation detection for any other
Raydium program is needed later, it requires its own investigation --
capturing real transactions for that specific program and confirming its
instruction encoding, the same way this document does for AMM V4 -- not an
assumption that AMM V4's tag/layout carries over.

## Exact detection conditions (all required; any failure fails closed)

1. `programId === RAYDIUM_AMM_V4_PROGRAM_ID` (see above).
2. A matching instruction exists -- top-level **or** nested/CPI, per
   Phase 1.1's finding that real creations can be wrapped by other programs
   -- whose first data byte equals `RAYDIUM_AMM_V4_INITIALIZE2_TAG` (`1`).
   This tag is the same one carried over from Phase 1.1: well-documented
   across the ecosystem's tooling, still **not confirmed against a live
   example** (see below).
3. Full account-layout validation on that specific instruction (next
   section) passes.

If any step fails, `detectRaydiumAmmV4PoolCreation` returns `{ detected:
false }` -- it never returns a partial match or degrades a failed check
into a warning.

## Account-layout checks

Uses the historically well-known, widely-replicated open-source
`raydium-amm` `initialize2` account order (0-indexed): token program,
associated-token program, system program, rent sysvar, **AMM pool**,
AMM authority, AMM open orders, **LP mint**, **coin mint**, **PC mint**,
**coin vault**, **PC vault**, withdraw queue, AMM target orders, LP vault,
market program, **market**, **user wallet**, user's coin/PC/LP token
accounts (21 accounts total). Like the tag, this layout is **not confirmed
against a live-captured transaction** -- if the deployed program build has
reordered or added accounts, a real creation could fail these checks even
with a correct tag and a genuinely fresh mint. That's an accepted,
deliberate trade-off (recall for precision) given task constraints.

Hard requirements, checked in `validateRaydiumInitialize2Layout()`:

- **≥ 21 accounts** present at all (catches a truncated/malformed
  instruction outright).
- Pool, LP mint, coin mint, PC mint, both vaults, market, and user wallet
  are all present **and pairwise distinct** (catches a corrupted/degenerate
  account list -- e.g. two of these positions resolving to the same key).
- **LP mint is a genuinely freshly-initialized mint** (real
  `spl-token`/`-2022` `InitializeMint`/`InitializeMint2` elsewhere in the
  transaction, absent from `preTokenBalances`) -- carried over from Phase
  1.1, now checked at its specific documented position rather than
  "anywhere among the instruction's accounts" (see "mismatched mint
  account" below for why that mattered).
- **User wallet is a real signer** of the transaction -- the same
  fresh-signer pattern pump.fun's mint check uses, applied to the pool
  creator instead.

Recorded as evidence but never gating (soft/informational, since they're
legitimately scenario-dependent): whether the coin mint is *also* freshly
initialized (a from-scratch token+pool launch bundled into one transaction
is legitimate, not a red flag) -- surfaced as
`coin_mint_also_freshly_initialized` or `coin_mint_pre_existing`.

### Why "mismatched mint account" needed a real fix

Phase 1.1's detector accepted a fresh mint match anywhere among the
instruction's accounts. That's looser than it needs to be: a transaction
could contain a fresh mint completely unrelated to LP creation (e.g. one of
the user's other token accounts happens to reference a mint initialized
earlier in the same batched transaction) that still happens to appear
somewhere in the Raydium instruction's account list without being the LP
mint at all. Requiring the freshness specifically at the documented LP
mint position closes that gap. A regression test (`mismatched mint
account`) constructs exactly this case and confirms it's now rejected.

## Live validation status

**Not observed.** Across both Phase 1.1 and this pass, three independent
live-sampling attempts (a 2-minute broad `onLogs` capture, a ~150-transaction
historical scan, and a further ~40-transaction targeted hunt specifically
for tag `1`) found **zero** genuine Raydium AMM V4 `initialize2`
transactions -- pool creations are rare, and public-RPC rate limits capped
how much could be sampled. Per the constraint on this phase (do not claim
live validation without an actually-observed, actually-accepted real
transaction), this document makes no such claim. The "valid initialize2"
regression test uses a clearly-labeled **synthetic** transaction
constructed to match the documented layout exactly -- it validates the
detector's logic correctly, not the tag/layout's correctness against the
live program.

pump.fun's detector, by contrast, *has* been live-confirmed (Phase 1.1) and
is unaffected by this pass.

## Files changed

- `engine/src/discovery/creationDetector.ts` -- added
  `RAYDIUM_AMM_V4_PROGRAM_ID`, renamed `RAYDIUM_INITIALIZE2_TAG` →
  `RAYDIUM_AMM_V4_INITIALIZE2_TAG`, added
  `RAYDIUM_AMM_V4_INITIALIZE2_ACCOUNTS` + `RAYDIUM_AMM_V4_MIN_ACCOUNTS` +
  `validateRaydiumInitialize2Layout()`, renamed
  `detectRaydiumPoolCreation` → `detectRaydiumAmmV4PoolCreation` (now
  program-ID-gated and layout-validated, and surfaces the pool address in
  its result), added `getWritableAccountSet()`, hardened
  `findProgramInstructions` / `findFreshMintInitializations` /
  `getSignerAccountSet` against missing `accountKeys`/`instructions`
  (a real gap this pass's malformed-transaction test caught).
- `engine/src/discovery/raydiumLogSubscriber.ts` -- uses the renamed
  detector; warns at startup if configured with a non-AMM-V4 program ID;
  now passes the detected pool address through to `DiscoveredTokenEvent`
  instead of always `null`.
- `engine/test/discovery/creationDetector.test.ts` -- Raydium test block
  fully rewritten (see below).

No changes to hard risk parameters, position sizing, exit logic, the risk
engine, ledger schema, `DRY_RUN` posture, wallet signing, or any LLM
integration. pump.fun detection is unchanged.

## Tests added

The Raydium section of `creationDetector.test.ts` grew from 4 tests (Phase
1.1) to 15 (11 net new), covering exactly the task list:

- program-ID scoping: rejects immediately for a non-AMM-V4 program ID, and
  rejects a well-formed instruction when the caller passes the wrong
  program ID constant (e.g. pump.fun's)
- valid synthetic `initialize2` (top-level and nested variants, plus the
  bundled-launch coin-mint-also-fresh variant)
- real captured Raydium `SwapBaseIn` (tag 9) nested in a real bundler
  transaction → reject
- real unrelated transaction and real pump.fun creation transaction (no
  Raydium instruction present) → reject
- wrong instruction tag (otherwise-perfect layout) → reject
- missing mint initialization → reject
- mismatched mint account (fresh mint present but not at the LP position)
  → reject
- malformed instruction: truncated account list, collapsed/duplicate
  required accounts, empty instruction data, fully malformed transaction
  shape → reject, none throw

## Final test count

164 → **175** engine unit tests, all passing (`npm test --workspace=engine`)
-- the Raydium test block grew from 4 tests (Phase 1.1) to 15, and one
existing pump.fun-adjacent utility test file is unchanged. Build,
typecheck, and lint remain clean.

## Remaining limitations

1. The `initialize2` tag value and the full account ordering are both
   still unconfirmed against a live example -- this pass adds more
   structure to fail closed on, it does not resolve the underlying
   uncertainty documented in Phase 1.1.
2. Other Raydium program types (CPMM, CLMM, stable-swap) remain completely
   undetected -- not a regression, since Phase 1.1 never supported them
   either, but worth restating: if meme-token pools increasingly launch on
   one of those instead of AMM V4, this detector won't see them.
3. Live end-to-end confirmation of Raydium detection (as opposed to the
   offline synthetic/real-fixture tests, which exercise the exact same
   code) is still outstanding.
