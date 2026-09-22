# Phase 5.6F — Holder policy: verified bonding-curve vault excluded, circulating-supply denominator (Option D)

Labels: [implementation], [measured], [limitation]. DRY_RUN only. No entry filter, position size, TP/SL, risk limit, daily-loss limit, re-entry rule, Jupiter limit, Token-2022 policy, round-trip threshold or duplicate-entry protection was changed.

## 1. What the gate does now [implementation]
| Situation | Behaviour | Reason code |
|---|---|---|
| Live Pump.fun curve, vault VERIFIED (all checks) | circulating = supply - vault balance; concentration = top 10 NON-vault accounts / circulating; limit unchanged (60%) | `holder_concentration_too_high` |
| circulating <= 0 (nothing sold yet, or vault >= supply) | reject, no concentration figure | `holder_circulating_supply_invalid` |
| Curve exists but vault NOT verified, or the read failed | reject (fail closed), never a looser fallback | `holder_vault_unknown` |
| Mayhem-mode curve (2x supply) | unverified => reject | `holder_vault_unknown` |
| Graduated curve (vault 0) | previous metric, unchanged (top 10 / total supply, PumpSwap-owned accounts still counted; pool semantics UNVERIFIED) | `holder_concentration_too_high` |
| No bonding curve for the mint (not Pump.fun) | previous metric, unchanged | `holder_concentration_too_high` |
| Optional safeguard: circulating share below `minCirculatingSharePct` (live curves only) | reject | `holder_circulating_share_too_low` |
| Optional safeguard: fewer than `minVisibleHolders` non-vault accounts with a balance (live curves only) | reject | `holder_visible_holders_too_low` |
Creator concentration is only recorded (`details.holderPolicy.creatorPctOfCirculating`, a lower bound from the visible top-20 accounts; logged at info level for passing decisions). It never rejects. Only the verified vault account is removed; developer, LP, PumpSwap and unknown accounts stay counted. `excludeAddresses` still applies.
`top10_holder_pct` on evaluations now holds the figure the decision used: the new metric for live curves, the previous one for legacy cases, null for unknown or invalid.

## 2. Vault verification [implementation] (`src/safety/bondingCurveVault.ts`, pure)
V1 curve PDA and vault address equal a fresh derivation from the mint (`["bonding-curve", mint]` under the Pump program; ATA seeds `[curve, token program, mint]`); V2 curve PDA off the ed25519 curve; V3 curve account owned by the Pump program; V4 it decodes as a BondingCurve; V5 vault is a token account of the mint's token program with `mint` = this mint and `owner` = the curve PDA; V6 vault balance = curve real token reserves + 206,900,000 tokens (live) or 0 with 0 reserves (graduated); V7 mint supply <= curve total supply; plus the mayhem flag must be readable and false. The migration reserve is a measured constant (exact difference on 99 live curves); if Pump.fun changes it, V6 fails and the gate fails closed. Works for SPL Token and Token-2022 mints.
Reads (`getBondingCurveAccounts`): one `getMultipleAccountsInfo([curve, vault])` (same slot), cached up to the existing 10 s bound, failures never cached; a diagnostic `getTokenAccountOwners` read (only for verified live curves, cached the same way). If the holder data is unavailable the curve is not read (existing `holder_data_unavailable` path unchanged).

## 3. Configuration [implementation]
`safety.minCirculatingSharePct` (0-100) and `safety.minVisibleHolders` (integer >= 0), env `SAFETY_MIN_CIRCULATING_SHARE_PCT` and `SAFETY_MIN_VISIBLE_HOLDERS`. Both default to 0 = OFF: no new policy threshold is hard-coded. A set but invalid value (text, out of range, fractional holders) fails config validation at startup instead of silently turning the safeguard off. At most 19 non-vault accounts are visible on a live curve (the RPC returns 20 and the vault takes one). `.env.example` documents both.

## 4. Files changed
New: `engine/src/safety/bondingCurveVault.ts`, `engine/src/safety/checks/holderPolicy.ts`, `engine/test/safety/holderVaultPolicy.test.ts`, this document.
Modified: `engine/src/safety/dataSource.ts` (two read methods, cache), `engine/src/safety/safetyGate.ts` (policy wiring, optional safeguards in its config type, result field `holderPolicy`), `engine/src/safety/types.ts` (`vault` failure source), `engine/src/config/schema.ts`, `engine/src/config/loader.ts`, `engine/src/orchestrator/loop.ts` (one diagnostic log line only), `engine/.env.example`.
Existing test fixtures adapted to the new data-source methods (they now model "no Pump.fun curve for this mint"; no assertion weakened): `engine/test/safety/safetyGate.test.ts`, `engine/test/safety/token2022.test.ts`, `engine/test/pipeline/providerLoop.test.ts`.
Untouched: `holderConcentrationCheck.ts` (the previous metric, reused as is), entry filters, risk, exits, scoring, execution, Jupiter, DexScreener, Token-2022 policy, the duplicate-entry guard, `engine/.env`.

## 5. Tests [measured]
`holderVaultPolicy.test.ts`, 51 tests: the seven checks each failing on its own (and aggregated), verified live (SPL and Token-2022) and graduated, no-curve token, mayhem and unreadable-mode curves; the policy (before/after on the same accounts, limit boundary 60% exact, only the vault removed, excludeAddresses, vault absent from the list, zero and negative circulating, zero supply, unverified and unavailable vault, graduated unchanged including with safeguards set, no-curve unchanged, safeguards off/at/below/above, safeguards not masking concentration, creator share recorded but never a reason); the full gate on on-chain-shaped accounts (live pass, live reject, Token-2022, tampered vault, mayhem, RPC failure recorded as a provider failure, zero circulating, graduated, no curve, holder/mint unavailable do not read the curve, safeguards, creator diagnostic and its failure, other checks untouched); the cache (success reused, failure not cached; one batch read); configuration (defaults, env, invalid values fail loudly, 60% and V1 filters unchanged).
Mutation check: removing the vault exclusion, the fail-closed branch and check V6 makes 14 of these tests fail; restored afterwards.
Full suite: 75 files / **699 tests** (648 before), Python 242, `tsc` (both configs), `eslint`, `npm run build` clean, `git diff --check` clean.

## 6. Before/after on real mainnet tokens [measured, read-only replay]
118 Pump.fun tokens (the Phase 5.6D set) through the real provider stack (Helius HTTP) and the real gate, with liquidity and the Jupiter round trip stubbed to pass so only mint/holder logic varies. State is investigation-time (many live curves have already dumped).
| | Before (previous metric) | After (this policy) |
|---|---|---|
| Pass | 0 | 3 |
| `holder_concentration_too_high` | 118 | 81 |
| `holder_circulating_supply_invalid` | - | 28 |
| `holder_vault_unknown` | - | 6 (all mayhem: V7 and mayhem flag fail) |
Categories: 99 live verified, 13 graduated, 6 unknown. Graduated tokens: identical figure and outcome to before for all 13 (all rejected). Nothing that passed before is rejected now (0 -> 0). Newly admitted (3, all live, verified): BL5pQeeb (70.96% -> 44.99%, circulating 49.8%), etYwtrNP (62.28% -> 43.04%, circulating 63.2%), **5SiY6Wop (99.97% -> 55.44% with only 0.0586% of supply circulating)**. The last one is exactly the small-base case the optional circulating-share safeguard exists for; it is OFF by default as instructed. Creator share was recorded for 71 live tokens (10 above 50%) and never appeared as a reason. Replay cost: 606 RPC requests, 35 Helius 429s, all retried.

## 7. Limitations
- The curve/vault and holder reads can be up to the 10 s cache bound apart, so on a fast-moving token circulating and the holder list can be slightly out of step.
- Creator share and visible-holder counts see only the top-20 accounts (lower bounds); wallet clusters are not aggregated.
- The gate adds one small batch read and (for verified live curves) one owner read per token per 10 s.
- Percentages of the new metric use four decimals; the previous metric truncates to two, so a value just above 60.00% can now reject where it used to pass.
- No live end-to-end run was made with this change; validation is the tests plus the read-only replay.
