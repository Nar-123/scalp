# Phase 5.6E — Holder-concentration policy backtest (read-only simulation)

Labels: [measured] computed from mainnet reads; [estimate] derived, not per-token verified; [limitation]. Nothing was implemented: no code, threshold, gate or strategy change. Inputs are the existing 118-token investigation (`docs/PHASE_5_6D_HOLDER_CONCENTRATION_INVESTIGATION.md`). Scripts and raw data are outside the repo.

**Two data sets, never mixed.**
- **Investigation-time** (118 tokens, read hours after the gate saw the 24 original candidates; most live curves had already dumped, so 57 of 99 have under 5% circulating). Vault verification (V1-V7), creator share and holder counts exist only here. This is the only set where Option B is computed exactly.
- **Gate-time** (42 live-curve tokens from two later runs: top-10 recorded at the decision, vault share ESTIMATED from SOL raised). Creator share and holder counts were not recorded. [limitation] The Option B estimate here removes the vault from the recorded top-10 and so counts only 9 non-vault accounts, not 10: it is a lower bound of the true B value, so its pass counts are upper bounds.

Definitions used: limit 60%; "circulating" = supply minus the verified vault balance; "holders" = non-vault accounts with a balance among the at most 20 accounts the RPC returns (so a live curve can show at most 19); creator share = tokens held by the curve's `creator` in those accounts / circulating (a lower bound). Categories: live verified 99, graduated verified 13 (vault 0), UNKNOWN 6 (all mayhem, 2x supply, vault not verifiable). PumpSwap pool semantics = **UNVERIFIED**: PumpSwap-owned accounts are treated exactly as today (counted as holders, never excluded).

## 1. Current policy (Option A: top10 / total supply, reject above 60%) [measured, investigation-time]
| group | tokens | circulating > 0 | rejected | pass | UNKNOWN |
|---|---|---|---|---|---|
| all | 118 | 87 | 114 | 4 | 0 (not needed) |
| live | 99 | 74 | 96 | 3 | 0 |
| graduated | 13 | 13 | 12 | 1 | 0 |
| mayhem/UNKNOWN | 6 | 0 | 6 | 0 | 0 |
Gate-time [measured]: 42 tokens, 31 rejected, 11 pass.
The 24 original candidates: 24 of 24 rejected.

## 2. Option B (verified vault excluded; circulating = 0 fails closed; unverified vault fails closed) [measured, investigation-time]
| group | tokens | circ > 0 | rejected (>60%) | pass | zero circulating (fail closed) | UNKNOWN (fail closed) | newly admitted vs A | passing A but not B |
|---|---|---|---|---|---|---|---|---|
| all | 118 | 87 | 81 | 6 | 25 | 6 | 2 | 0 |
| live | 99 | 74 | 69 | 5 | 25 | 0 | 2 | 0 |
| graduated | 13 | 13 | 12 | 1 | 0 | 0 | 0 | 0 |
| mayhem/UNKNOWN | 6 | 0 | 0 | 0 | 0 | 6 | 0 | 0 |
The 24 original candidates under B: 22 rejected, 1 zero circulating, 1 pass.
The six B-passing tokens: BL5pQeeb (live, A 80.5%, B 57.4%, circulating 41.8%), 5SiY6Wop (live, A 100.0%, B 55.4%, **circulating 0.1%**), 7Dsur1HB (A 31.6, B 12.5), 7K8ap3kZ (A 32.2, B 2.9), GxqWfaHc (A 54.1, B 30.1), B6F3rUqf (graduated, A = B = 57.6%). The two newly admitted are BL5pQeeb and 5SiY6Wop.
Gate-time [estimate, upper bound of B passes]: 42 tokens, 7 rejected, 35 pass, 24 newly admitted vs A.

## 3. Option D sensitivity (B plus minimum circulating share X and minimum non-vault holders H) [measured, investigation-time]
Cell = tokens passing (newly admitted vs A in brackets). "Insufficient" = passes B but circulating share below X.
| group | X | H>=3 | H>=5 | H>=10 | H>=20 | insufficient circulating |
|---|---|---|---|---|---|---|
| live (B pass 5) | 5% to 30% (identical for 5, 10, 15, 20, 25, 30) | 4 [1] | 4 [1] | 4 [1] | 0 [0] | 1 |
| graduated (B pass 1) | 5% to 30% | 1 [0] | 1 [0] | 1 [0] | 1 [0] | 0 |
| all (B pass 6) | 5% to 30% | 5 [1] | 5 [1] | 5 [1] | 1 [0] | 1 |
Holder floor alone (no share floor), live: H>=3, 5, 10 all 5; H>=20 gives 0 because a live curve can show at most 19 non-vault accounts (the RPC returns 20 and the vault takes one). Graduated: 1 for every H.
Reading: at investigation time every floor from 5% to 30% removes exactly the same one token (5SiY6Wop, 0.1% circulating); the other passing tokens have at least 41.8% circulating, so the tested floors do not discriminate among them.
Gate-time [estimate]: estimated circulating share 33.9% to 77.3% (median 53.3%), so none of the floors 5% to 30% would bind on any of the 42 gate-time tokens (insufficient circulating = 0 at every X); pass counts stay at the 35 estimated for B.

## 4. Creator concentration (creator balance / circulating; circulating > 0 only) [measured, investigation-time]
| set | n | over 25% | over 50% | over 75% | over 90% |
|---|---|---|---|---|---|
| all (any policy's population) | 87 | 14 | 13 | 12 | 12 |
| live | 74 | 14 | 13 | 12 | 12 |
| graduated | 13 | 0 | 0 | 0 | 0 |
| among B passes | 6 | 0 | 0 | 0 | 0 |
| among D passes (X 0 to 30%, H>=3) | live 4 to 5, graduated 1 | 0 | 0 | 0 | 0 |
The 13 live tokens with the creator over 50% of circulating: 12 have exactly one visible holder (the creator, 100%, circulating share 0.00% to 12.5%), and one has creator 50.1% with 18 holders and B = 97.9%. All 13 are rejected by A and by B. No creator threshold was applied or created. Under A the metric is total-supply based and never shows the creator explicitly.

## 5. Live vs graduated [measured]
- Live (99): 25 have zero circulating, 57 have under 5%, only 5 have 30% or more. A passes 3, B passes 5. Of the 57 live tokens under 5% circulating, 45 show B of 99% or more, 1 shows 60% or less (5SiY6Wop, at 0.1% circulating), the rest are between.
- Graduated (13, vault 0): A and B are identical (12 rejected, 1 pass B6F3rUqf at 57.6%); circulating equals supply. The dominant account of all 13 is a PumpSwap-owned account counted as a holder: pool semantics UNVERIFIED, so the result stays as conservative as today.

## 6. Unknown cases
6 of 118 (all mayhem-mode, supply 2x the curve total): vault not verifiable => Option B/D = UNKNOWN, fail closed. Option A still returns a number for them (6 of 6 rejected). Zero-circulating live curves (25): B/D fail closed.

## 7. Safety trade-offs (no option is called best)
| | Option A | Option B | Option D (B + floors) |
|---|---|---|---|
| Risk it removes | creator/insider-heavy and dumped tokens are rejected (all 13 creator-over-50% tokens have A near 100%) | stops counting protocol-owned unsold inventory as a holder, so concentration is measured on circulating tokens | as B, and additionally refuses passes decided on a very small circulating base (5SiY6Wop: 55.4% of 0.1%) |
| Risk it introduces | rejects tokens because of how much has been sold, not who holds them (vault 22% to 66% at the gate) | admits tokens whose concentration is measured on a tiny base (one of six B passes had 0.1% circulating); relies on per-token vault verification and one extra read | floor values are untested where they would matter (no floor from 5% to 30% binds at gate time by estimate); a holder floor of 20 is impossible for live curves |
| Low circulating makes the metric unstable? | No (it does not use circulating) but it is uninformative | Yes: ratio near 100% or undefined; 25 zero, 57 under 5% | Partly addressed by the floor; residual instability between the floor and 100% |
| Creator concentration visible? | Only indirectly | Not explicitly; a creator holding 50% to 60% of circulating could pass B if the rest is spread (none in this sample) | Same as B unless a creator rule is added separately |
| Unknown vault fail-closed? | n/a (no verification needed) | Yes (6 UNKNOWN rejected, 25 zero-circulating rejected) | Yes |
| Post-graduation conservative? | Yes: pool-owned account counted as a holder (12 of 13 rejected) | Yes: identical to A for graduated tokens | Yes |

## 8. Candidate policy specification for a human decision (parameters left open; nothing chosen)
1. **Vault verification (all must hold, else UNKNOWN => reject):** curve PDA derived from `["bonding-curve", mint]`; PDA off-curve; curve account owned by the Pump program and decodes; largest-account candidate is the PDA's associated token account for the mint with matching mint/owner fields under the mint's token program; live curve: vault balance = curve real token reserves + 206,900,000 tokens; graduated: vault and real reserves both 0; mint supply <= curve total supply. Reads: one `getMultipleAccounts` (mint, curve, vault), cacheable up to 10 s, PDA derivation needs no RPC.
2. **Circulating supply** = supply - verified vault balance; `circulating == 0` => reject (`holder_circulating_zero`, name illustrative).
3. **Concentration** = sum of the 10 largest NON-vault accounts / circulating, limit unchanged at 60% unless the human decides otherwise. Remove only the verified vault; never remove a developer, LP, PumpSwap or unknown account.
4. **Floors (open parameters):** minimum circulating share X and minimum non-vault holders H, values to be chosen by the human (tested 5, 10, 15, 20, 25, 30% and 3, 5, 10, 20; 20 holders is unreachable with a 20-account RPC on live curves).
5. **Creator visibility (open):** report `creator / circulating` in the decision context; whether to add a threshold is a separate decision (tested reference points 25, 50, 75, 90%).
6. **Graduated tokens:** unchanged; PumpSwap-owned accounts remain counted until pool semantics are verified.
7. **Fail-closed:** any unverifiable vault, zero circulating, unreadable account, or holder-data failure => reject with a distinct reason.
8. **Tests to add with any option:** verification failure cases, zero/near-zero circulating, creator-only-holder, graduated vault 0, mayhem UNKNOWN, classic and Token-2022 mints, unchanged behavior of the 60% limit.

## 9. Limitations
Investigation-time data is dominated by post-dump curves; the B passes (5 live) are too few to characterise a policy. Gate-time B is an upper bound (9 non-vault accounts). Creator and holder counts see only the top-20 accounts. Neither metric detects several wallets controlled by one actor. No option was implemented or run through the gate.

FINAL STATUS: READY FOR POLICY DECISION.
