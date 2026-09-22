# Phase 5.6D — Holder-concentration semantics: is the Pump.fun bonding-curve vault a holder? (read-only investigation)

Labels: [measured] a number from mainnet reads; [estimate] derived, not per-token verified; [observation] interpretation. No code, threshold or gate was changed. Scratch scripts and raw data are outside the repo.

## 1. Vault identification (on-chain evidence, 118 tokens: 24 previous candidates, 40 tokens that reached the gate in two later runs, 44 random active tokens, 10 graduated) [measured]
| Check | Result |
|---|---|
| V1 curve PDA = findProgramAddress(["bonding-curve", mint], Pump program 6EF8...) | 118 / 118 |
| V2 that PDA is off the ed25519 curve (no private key can exist) | 118 / 118 |
| V3 the curve account is owned by the Pump program | 118 / 118 |
| V4 the account decodes as a BondingCurve (discriminator, layout) | 118 / 118 |
| V5 the largest token account is the associated token account of that PDA for the mint; its mint and owner fields say so, under the mint's own token program (117 Token-2022, 1 classic) | 118 / 118 |
| V6 vault balance = curve.real_token_reserves + exactly 206,900,000 tokens (Pump.fun's reserve for post-graduation liquidity) | 99 / 99 live curves; graduated: vault 0 and real reserves 0 (19 / 19) |
| V7 mint supply <= curve.token_total_supply (burns only reduce supply) | 112 / 118; the 6 that fail are mayhem-mode tokens with 2x supply: UNKNOWN |

Verified as protocol-owned unsold inventory: 112 / 118 (99 live + 13 graduated with a 0 vault). In all 99 live verified curves the vault is the largest account and is inside the top 10. Note: 206.9M of the vault (20.69% of supply) is not sellable on the curve at all; it is held for the later liquidity migration.
Relation measured on all live curves: vault = virtualTokenReserves - 73,000,000 tokens, so it is fully determined by SOL raised (100% at 0 SOL, about 51% at 25 SOL, 23% at 77 SOL).

## 2. Current metric
`top10_balance / total_supply` over the 10 largest token accounts (vault included). Unchanged (`holderConcentrationCheck.ts`).

## 3. Diagnostic metric (vault removed only when verified)
circulating = supply - vault balance; diagnostic = top-10 accounts excluding ONLY the verified vault / circulating. Unverified => UNKNOWN (6 mayhem tokens). Nothing else was removed (no developer wallet, LP or unknown account).

## 4. The 24 previous candidates (state at investigation time, hours after the gate saw them) [measured]
Supply, vault and circulating in millions of tokens.

| token | supply | vault | circulating | current top10 % | diagnostic top10 % of circulating | vault in top 10 | vault verified |
|---|---|---|---|---|---|---|---|
| 6ga4UxSk | 1000.0 | 999.9 | 0.1 | 100.00 | 100.00 | YES | YES |
| E6E5h44L | 1000.0 | 999.4 | 0.6 | 100.00 | 100.00 | YES | YES |
| C18mMfqA | 1000.0 | 999.3 | 0.7 | 100.00 | 100.00 | YES | YES |
| B35TBQ9j | 1000.0 | 993.6 | 6.4 | 100.00 | 100.00 | YES | YES |
| 6HjrBKrQ | 1000.0 | 997.7 | 2.3 | 100.00 | 100.00 | YES | YES |
| 53eW4BTB | 1000.0 | 998.4 | 1.6 | 100.00 | 100.00 | YES | YES |
| 7EBJFBef | 1000.0 | 999.9 | 0.1 | 100.00 | 100.00 | YES | YES |
| 5DQJqoxA | 1000.0 | 1000.0 | 0.0 | 100.00 | undefined (nothing circulating) | YES | YES |
| D4WrCdLu | 1000.0 | 968.5 | 31.5 | 100.00 | 100.00 | YES | YES |
| HSqrJ1xj | 1000.0 | 999.3 | 0.7 | 100.00 | 100.00 | YES | YES |
| G9qo1JMt | 1000.0 | 998.2 | 1.8 | 100.00 | 100.00 | YES | YES |
| HetBsLkr | 1000.0 | 999.5 | 0.5 | 100.00 | 100.00 | YES | YES |
| AqGQyELG | 1000.0 | 998.2 | 1.8 | 100.00 | 100.00 | YES | YES |
| FthRzHdT | 999.7 | 994.6 | 5.1 | 100.00 | 100.00 | YES | YES |
| AYFRBExD | 999.6 | 976.2 | 23.5 | 99.96 | 98.81 | YES | YES |
| 2Rg6Bawz | 1000.0 | 996.5 | 3.5 | 99.90 | 75.14 | YES | YES |
| BncK1KSu | 961.0 | 0.0 | 961.0 | 99.35 | 99.35 | NO (graduated, vault 0) | YES |
| F14cqhfZ | 999.4 | 921.0 | 78.3 | 98.91 | 87.49 | YES | YES |
| BycvRzxW | 943.2 | 0.0 | 943.2 | 98.65 | 98.65 | NO (graduated, vault 0) | YES |
| 2twWJmqU | 1000.0 | 888.8 | 111.2 | 95.71 | 65.78 | YES | YES |
| BsNJNzyG | 947.1 | 0.0 | 947.1 | 94.18 | 94.18 | NO (graduated, vault 0) | YES |
| Ecmhg5s1 | 954.3 | 0.0 | 954.3 | 93.88 | 93.88 | NO (graduated, vault 0) | YES |
| Fma2FG4U | 1000.0 | 700.6 | 299.4 | 90.29 | 72.11 | YES | YES |
| BL5pQeeb | 999.9 | 581.7 | 418.2 | 80.47 | 57.40 | YES | YES |

**Time caveat (corrects my earlier report).** The 24-token numbers above, and the "top-10 72.9% to 100%" I reported earlier, were read hours after the gate evaluated these tokens. At the gate they had 20.6 to 82.8 SOL raised (curve-implied vault 21% to 56% of supply, [estimate]); 18 of the 20 still-live curves later fell below 20% of that SOL (most below 1 SOL), so their vault refilled to about 99% to 100%. Numbers recorded AT the gate for 42 tokens in two later runs: SOL raised 13.9 to 77.3 (median 27.7), curve-implied vault share 22.7% to 66.1% (median 46.4%), recorded top-10 32.9% to 100% (median 69.8%), 11 of 42 at or below 60%.

## 5. Population results (99 live verified curves, at investigation time) [measured unless marked]
- Current top10/supply: median 100%, 3 of 99 at or below 60%.
- Diagnostic top10/circulating: defined for 74 (25 have nothing circulating yet: 0/0), median 100%, 5 of 74 at or below 60%, 50 of 74 at or above 99%.
- Reference only (top-10 excluding the vault over TOTAL supply): median 0.2%, max 28.0%, 99 of 99 at or below 60%.
- Creator share of circulating: 13 of 74 at or above 50%, 12 of 74 at or above 90%. Largest non-vault holder: median 56.2% of circulating. Median non-vault accounts with a balance among the 20 the RPC returns: 2.
- [estimate] At the gate, top-10 excluding the vault over circulating would be at or below 60% for 35 of 42 tokens (assumes the vault is in the top 10 and vault = virtualTokenReserves - 73M; not verified per token).
- Graduated (curve complete): vault balance 0 and real reserves 0 for 19 of 19. The largest account of all 13 non-mayhem graduated tokens is a PumpSwap-program-owned account holding 37% to 98% of supply. It is a different account from the bonding-curve vault and was NOT excluded.

## 6. Safety analysis (evidence only, no recommendation)
1. Does the current metric measure circulating-holder concentration? No. The numerator includes protocol inventory and the denominator is total supply, so it measures "share of total supply held by the 10 largest accounts including the curve vault". Before graduation it mostly moves with SOL raised, not with who holds tokens.
2. Is the vault inventory holder ownership? On-chain it is owned by an off-curve PDA of the Pump program (no key), equals the unsold curve reserve plus the fixed migration reserve, and only becomes circulating when the program sells it.
3. Could excluding it hide real concentration? With a circulating denominator no concentration was hidden in this sample (50 of 74 show 99% or more; 12 show the creator at 90% or more). With the total-supply denominator it would hide everything (max 28%). The circulating ratio is unstable when little is circulating (25 undefined, many near 100%). Neither metric sees several wallets controlled by one actor (no owner or funder aggregation), and the RPC returns only 20 accounts.
4. After graduation: the vault is 0; the dominant account becomes a PumpSwap-owned account (owner program verified, pool identity not verified here). Both metrics count it as a holder.
5. If the vault is drained/sold: buys drain it toward 0 at graduation (metrics converge). If holders sell back it refills: 18 of 20 candidates went from 20 to 45 SOL raised to under 1 SOL, vault back to about 99%, the current metric back to about 100% and circulating near 0.
6. Different semantics before and after graduation? The dominating account differs (verified curve vault before, PumpSwap-owned account after), so the current rule treats two different things the same way. Whether they should be treated differently is a policy decision.

## 7. Risks
Excluding the vault: needs verification per token (6 of 118 UNKNOWN), adds one read (getMultipleAccounts of mint, curve and vault; PDA derivation needs no RPC), circulating can be tiny or 0 (ratio unstable or undefined), does not address multi-wallet actors, and the 206.9M migration reserve would also count as non-circulating.
Including the vault: the rule mostly gates on how much has been sold (vault share at the gate 22% to 66%), rejects most tokens for a reason unrelated to holder behaviour, and mixes two different protocol accounts before and after graduation.

## 8. Implementation options (not implemented, no winner chosen)
A. Keep the current rule. B. Exclude the verified curve vault, denominator circulating supply, with an explicit rule for circulating = 0. C. Exclude the verified vault but keep total supply as the denominator (99 of 99 in this sample would pass: effectively disables the rule). D. B plus a minimum circulating share or a minimum number of non-vault holders. E. Owner-level (wallet) aggregation of the top holders. F. Different treatment before graduation (verified curve vault) and after (PumpSwap pool account; needs its own verification). G. Add a creator-share limit.

FINAL STATUS: READY FOR POLICY DECISION.
