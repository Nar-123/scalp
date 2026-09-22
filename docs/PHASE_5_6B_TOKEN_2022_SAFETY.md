# Phase 5.6B — Token-2022 safety support

Labels: **[implementation]** what the code does · **[measured]** a number from a real run/command · **[limitation]** known gap · **[observation]** interpretation.
Scope: make the EXISTING safety gate able to read and evaluate Token-2022 mints. No strategy, threshold, risk, edge, Jupiter-limit or DexScreener change. DRY_RUN only.

## 1. Token-2022 / classic-SPL assumptions found (dependency map)
| Location | Assumption | Status |
|---|---|---|
| `safety/dataSource.ts` `DirectSafetyDataSource.getMintSummary` | `getMint(connection, mint)` = classic SPL only; any other owner throws `TokenInvalidAccountOwnerError` | **Changed**: that error now triggers a strict Token-2022 read; classic path untouched |
| `safety/checks/mintAuthorityCheck.ts` `fetchMintAccountSummary` | same `getMint` | Legacy helper, not on the runtime path; left unchanged (fails closed for Token-2022) |
| `safety/checks/holderConcentrationCheck.ts` `fetchLargestHolders` | none (getTokenLargestAccounts works for both programs) | Unchanged |
| `safety/checks/sellabilityHeuristic.ts` | quote impact only; blind to token-side fees/hooks | Unchanged; safe because every behaviour-changing extension is rejected upstream (section 2) |
| `discovery/creationDetector.ts` | already accepts spl-token and spl-token-2022 InitializeMint | Unchanged |

## 2. Safety contract [implementation]
Files: `src/safety/token2022Mint.ts` (strict decoder, no spl-token import), `src/safety/checks/token2022ExtensionCheck.ts` (policy), used by `safety/safetyGate.ts`. Classic mints carry no `token2022` field and are skipped (behaviour unchanged).

Principle: Token-2022 support means "evaluate", never "accept". A holder must be able to buy, then sell, without anyone else being able to take, freeze, tax, block or hide the tokens. Anything not understood is rejected.

| Extension | Class | Rule / reason code |
|---|---|---|
| MetadataPointer, TokenMetadata, GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember | ALLOW | no effect on transfers/balances/fees (pointers must be 64 bytes, else malformed) |
| TransferFeeConfig | REQUIRES VERIFICATION | both fee schedules must be exactly 0 bps, else `token2022_transfer_fee_nonzero` (see limitation) |
| TransferHook | REQUIRES VERIFICATION | hook program AND authority both unset, else `token2022_transfer_hook` |
| PermanentDelegate | REQUIRES VERIFICATION | delegate unset, else `token2022_permanent_delegate` |
| DefaultAccountState | REQUIRES VERIFICATION | Initialized only; Frozen = `token2022_default_account_state_frozen` |
| MintCloseAuthority | REQUIRES VERIFICATION | only while supply > 0, else `token2022_mint_close_authority_with_zero_supply` |
| NonTransferable | REJECT | `token2022_non_transferable` |
| ConfidentialTransferMint / FeeConfig / MintBurn | REJECT | `token2022_confidential_transfer` (hidden balances defeat holder concentration) |
| Pausable | REJECT | `token2022_pausable` |
| InterestBearing, ScaledUiAmount, PermissionedBurn | REQUIRES VERIFICATION | unverified pipeline effect => `token2022_unsupported_extension` |
| account-level types (2,5,7,8,11,13,15,17,27) | NOT RELEVANT | cannot appear on a mint => `token2022_extension_data_malformed` |
| unknown id | unsupported | `token2022_unsupported_extension` |

Structural problems (short data, bad option tag, uninitialized, wrong account type, truncated/duplicate TLV) make the mint UNAVAILABLE (`mint_account_unavailable`, cause `token:token2022_extension_data_malformed`); no partial summary is ever produced. Owner other than Token-2022 => `unsupported_token_program`.

## 3. Mint / freeze authority [implementation]
Same base layout; authorities are decoded and the existing `mint_authority_not_renounced` / `freeze_authority_present` checks apply unchanged (tested on Token-2022 mints). Extension authorities that matter (transfer-hook authority, permanent delegate) are part of the contract above.

## 4. Holder data [measured]
`getTokenLargestAccounts` works on Token-2022 through Helius: 20 accounts, about 300 ms, 24 of 24 candidates read. Fail-closed when unreadable (`holder_data_unavailable`, `top10HolderPct` stays null).

## 5. Sellability [implementation]
The Jupiter round-trip check is unchanged. It is accepted as sellability evidence for Token-2022 only because every extension that changes transfer behaviour (fee, hook, delegate, non-transferable, frozen default, pausable, confidential) is rejected before the quote matters. 24 of 24 candidates got a real Jupiter buy+sell quote.

## 6. Transfer fee [limitation]
Any non-zero fee (current or scheduled) is rejected rather than accounted for: the dry-run fills, position amounts and expected-net-edge are gross-amount based, so supporting a token-side fee needs net-amount accounting in the execution simulation (future task). It is never treated as zero.

## 7. Tests [measured]
`test/safety/token2022.test.ts`, 42 tests, deterministic hand-built mint buffers: classic mint; Token-2022 with no dangerous extension; transfer fee (current, scheduled, zero, malformed); hook (program set, authority set, inert, malformed); permanent delegate; non-transferable; default frozen / initialized / invalid; mint-close authority; confidential/pausable/interest-bearing/scaled/permissioned-burn; unknown and account-level extension ids; malformed layouts (9 cases); unreadable mint (missing, RPC down, wrong owner); unreadable holders; holder concentration and sellability still enforced; authorities still enforced; getMint non-owner errors not mistaken for Token-2022. Also fixed one type error in `test/providers/quoteClient.test.ts` found by `npm run typecheck`.

Suite: 72 files / **631 tests** (589 before), Python 242, `tsc` (both configs), `eslint`, `npm run build` clean.

## 8. Mainnet read-only validation [measured]
Real mints from the scanner ledger (44-minute Helius-HTTP + public-WS run), read through the real provider stack.
- 945 mints: 942 Token-2022, 3 classic, 0 unreadable. All 942 have exactly MetadataPointer + TokenMetadata => all pass the extension contract. Unsupported/unknown extensions found: 0.
- Cross-check against spl-token `unpackMint` on the same bytes: 942 of 942 identical (authorities, supply, decimals, extension ids).
- 24 tokens that passed all six V1 filters and reached the gate: mint parsed 24/24 (mint and freeze authority renounced 24/24), holders read 24/24, quotes 24/24, safety passes **0**. Failures: `holder_concentration_too_high` 24/24 (top-10 72.9% to 100%, limit 60%) and `excessive_round_trip_loss` 24/24 (2.66% to 7.77%, limit 2.5%).
- RPC during validation: 3,117 requests, 192 HTTP 429 from Helius at about 8 rps, all retried successfully; Jupiter 48/48 ok.
- Production loop (14.5-minute run, Token-2022-aware build): see section 10.

## 9. Why safety passes are rare (not Token-2022) [observation]
In the 24-token sample (section 8) both rules rejected every token, but the 15-minute production run (section 10) shows they are strong filters, not absolute blocks (6 of 243 gate evaluations passed). The two rules dominate the failures:
1. **Bonding-curve vault counts as a holder.** The largest token account is owned by the token's bonding-curve PDA in 20 of 24 candidates and holds 50% to 100% of supply while a token is young, so top-10 exceeds 60%. Only tokens whose supply has already spread out (top-10 of 53% to 60%) pass. Whether the vault should be excluded and concentration measured against circulating supply is a change to safety semantics and needs an explicit decision.
2. **Round-trip bound is close to Pump.fun's own fees.** The bound is `safetyMarginBps/100 + 2 x maxPriceImpactPct` = 2.5%. Jupiter's priceImpact includes the venue fee: recorded Pump.fun trades show 0.95% protocol fee plus a creator fee of 0.30% in most trades (46,965 of the 50,994 trades in the four most common fee configurations; the others carry 0.75%, 1.00% or 1.25%), per leg. The measured round trip was 2.66% to 7.77% in the sample; 91 of 243 gate evaluations in the production run failed on it.
Neither rule was changed.

## 10. Production-loop run (14.5 minutes, Helius HTTP + public WS, scratch ledger, DRY_RUN) [measured]
Normal production loop with the Token-2022-aware build, `JUPITER_MAX_RPS=0.5`, `JUPITER_MAX_RETRIES=0`, shadow off, no wallet.
- Stream: 218,352 Pump.fun notifications, 53,012 trade events decoded, 2 duplicates, 4,637 non-SOL trades excluded, 0 truncated logs, 0 coverage breaks, 0 WS errors, 0 reconnects.
- Data: 370 tokens, 77,214 native evaluations, 43,636 with usable 1-minute volume and price, 0 `native_token_state_unproven`.
- Gate: 20 tokens (243 evaluations) passed all six V1 filters and reached the safety gate. Failure reasons (an evaluation can have several): `holder_concentration_too_high` 178, `quote_unavailable` 103 (limiter budget at 0.5 rps), `excessive_round_trip_loss` 91, `stale_safety_data_at_decision` 4. **`mint_account_unavailable`: 0.**
- **Safety passes: 6 evaluations on 2 tokens, both Token-2022 mints** (`DuaPgni...` top-10 57.89% then 53.18%; `B6F3rUqf...` top-10 60.00%). For all six: fresh data (age -0.02 to 0.09 s), snapshot skew 1 s, no coverage break, volume 40.6 to 71.0 SOL, buy/sell ratio 3.3 to 4.8, velocity 2.7% to 33.5%, acceleration 2.0x to 34.5x, buy impact 0.35% to 0.40%, expected net edge 0.33% to 0.38% (> 0), risk allowed on 4 (2 blocked by `reentry_cooldown_active`). The full decision context of every candidate is in the run ledger (`entry_context_json` on each trade).
- Simulated trades: 4 entries, 4 exits (all `quick_tp`), reported PnL +0.0468 SOL. **This total double-counts: see below.** Nothing else was traded.
- Providers: Helius 1,398 of 1,398 ok; Jupiter 264 ok, 5 network errors, 0 HTTP 429; DexScreener 4,106 requests, 2,362 HTTP 429 (57.5%, graduated tokens only).
- Process: RSS 243 MB to 345 MB (rising during the run), heap up to 114 MB, CPU mean 18.3% of one core, event-loop lag p99 at most 83 ms. Shutdown 103 ms, exit 0.

### New defect found: duplicate concurrent entries for one token [observation]
Each of the 2 passing tokens produced TWO trades with identical entry time (to the millisecond), entry price, token amount, exit time, exit price and PnL. Cause (read from the code and the ledger): `watchToken` starts a new `evaluateToken` every 2 s without waiting for the previous one (`orchestrator/loop.ts`, `setInterval(() => void evaluateToken(...))`). With the quote limiter at 0.5 rps the safety gate takes longer than 2 s, the second tick joins the first tick's in-flight quotes, both ticks pass, and both open a position for the same mint before either is recorded (evaluations at 16:43:49.978 and 16:43:51.989, both entered at 16:43:54.501). Effect: double exposure (0.6 SOL against a 0.3 SOL position size) and double-counted PnL. The real single-trade PnL of the run is +0.0234 SOL (0.00063 + 0.02276). This is independent of Token-2022; it was hidden earlier because nothing reached entry. Not fixed here.

## 11. Security verification
No signer, keypair, sendTransaction, wallet or LLM symbol in any file added or changed by this task; `DRY_RUN` default true; `hardRisk.ts` identical to HEAD; architecture tests pass; API key not present in the working tree, scratch outputs or git history (scanned).

## 12. Files
New: `engine/src/safety/token2022Mint.ts`, `engine/src/safety/checks/token2022ExtensionCheck.ts`, `engine/test/safety/token2022.test.ts`, this document.
Modified: `engine/src/safety/dataSource.ts`, `engine/src/safety/safetyGate.ts`, `engine/src/types/token.ts`, `engine/test/providers/quoteClient.test.ts` (type fix).
