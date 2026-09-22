# Phase 5.6G — The 2.5% round-trip rule versus real Pump.fun costs (read-only investigation)

Labels: [measured] recomputed from recorded ledgers/on-chain events or live read-only quotes; [assumption] a configured value not measured on chain; [limitation]. No code, configuration, threshold, strategy, risk or execution was changed; no transaction was built. Scripts and raw data are outside the repo.

## 1. Data used
- **Candidates**: 384 gate-time evaluations of 58 native-curve tokens from four DRY_RUN ledgers (runs 5.6A, the 44-minute public-WS run, the Token-2022 run, and the duplicate-entry regression run), restricted to evaluations that reached the safety gate with a known round-trip outcome (no `quote_unavailable` / `no_sell_route_found`). Curve reserves and fee rates come from the token's latest recorded on-chain TradeEvent at or before the evaluation. All 384 are live bonding curves with protocol 95 + creator 30 = **125 bps per leg**.
- **Trades**: 5 unique simulated trades with recorded entry/exit (the 2 pre-fix duplicate pairs counted once).
- **Live calibration**: 30 live curves, real Jupiter quotes (read-only) against the exact curve math.
- **Not usable / not present**: no shadow trades, no replay data with post-entry price paths, no graduated-token round trips (Jupiter routes those through PumpSwap, different fees).

## 2. Pump.fun fee assumptions and sources
| Item | Value | Source |
|---|---|---|
| Fee per leg | protocol 95 bps + creator 30 bps = 125 bps (97% of 4,004 tokens; 3% at 95 bps) | [measured] `fee_basis_points` and `creator_fee_basis_points` of 148,354 recorded on-chain TradeEvents (non-mayhem, SOL-quoted) |
| Buy fee | charged on top of the curve amount: net = spend / (1 + rate) | repo math `entryNetLamports`, verified in Phase 5.5 (`docs/PHASE_5_5_NATIVE_PUMPFUN_MARKET_DATA.md`) |
| Sell fee | deducted from the SOL paid: proceeds = gross - ceil(gross x rate) | `sellNetLamports`, same source |
| Cross-check with the aggregator | Jupiter's quoted tokens out and sell proceeds equal the fee-inclusive curve math (ratio 1.00000 on all 30 live curves, route "Pump.fun") | [measured] live quotes |
| Network + priority | 0.000005 + 0.0005 SOL per leg | [assumption] config (`edge.networkFeeSol`, `edge.priorityFeeSol`); no signed transaction exists to measure it |
| Creator fee is dynamic | non-mayhem SOL-quoted tokens showed only 30 bps in this data; events of other quote types carry other creator fees | [measured]; the curve account's own `creator_fee_bps` field read 0 and is not the source |

## 3. Cost components per candidate (0.3 SOL) [measured, exact curve math, price unchanged after our own buy]
| Component | median | min | max |
|---|---|---|---|
| BUY fee | 1.235% | 1.235% | 1.235% |
| BUY price impact (vs pre-trade spot) | 0.491% | 0.269% | 0.581% |
| SELL price impact (actual held tokens, sold into the post-buy curve) | -0.491% | -0.581% | -0.269% |
| SELL fee | 1.235% | 1.235% | 1.235% |
| Network + priority, both legs [assumption] | 0.337% | 0.337% | 0.337% |
| **Pure round trip** (buy, then sell at once, others do not move the price) | **2.81%** | 2.81% | 2.81% |
The sell impact is negative because the buy already moved the price up and the sell hands that back: on a constant-product curve an immediate round trip costs only fees (2 x 1.235% = 2.47%) plus fixed costs. Tokens actually received matched the fee-inclusive exact amount for all 5 recorded trades.

## 4. The quantity that decides profit: break-even move versus the pre-entry price [measured]
The take-profit and the expected-gross-move parameters are measured against the pre-entry spot. Our own buy raises the spot by about 1% immediately, which the later sell partly pays back through its own impact, so the break-even move is larger than the pure round-trip cost:
| Definition | min | median | max |
|---|---|---|---|
| TRUE (exact curve, Pump.fun fees, held tokens, both legs, fixed costs) | 3.44% | **3.91%** | 4.11% |
| Dry-run SIMULATOR (executor formulas, config fees, recorded impacts) | 2.11% | 2.58% | 2.77% |
| Expected-net-edge FORMULA (sum of its cost terms incl. 0.5% margin) | 1.54% | 1.77% | 1.86% |
| What the 2.5% rule compares (model of the two independent 0.05 SOL Jupiter quotes) | 2.59% | 2.67% | 2.70% |
The exact-accounting model reproduces the 5 recorded trades to 0.00 percentage points.

## 5. Distribution by market state [measured]
| SOL raised at the gate | evaluations (tokens) | true break-even median (min..max) | gate-like model median | rt rule failed (recorded) |
|---|---|---|---|---|
| 20 to 30 | 209 (47) | 4.01% (3.90..4.11) | 2.68% | 139 |
| 30 to 45 | 128 (26) | 3.85% (3.70..3.90) | 2.66% | 96 |
| 45 and above | 47 (10) | 3.62% (3.44..3.69) | 2.62% | 34 |
By run: medians 3.76%, 3.99%, 3.94%, 3.90%. By fee tier: a single tier (125 bps) among candidates; population fee floor 2 x rate = 2.50% for 97% of tokens and 1.90% for 3%.

## 6. The 2.5% rule against the real cost
- The rule's bound is `safetyMarginBps/100 + 2 x maxPriceImpactPct` = 0.5 + 2.0 = 2.5%. At the 125 bps tier the fee floor alone (2 x 1.25%) is 2.50%, so the bound sits at the fee floor.
- Recorded outcome: the rule failed 269 of 384 evaluations (70%), passed 115. Yet the exact cost model puts every candidate above 2.5% (2.59% to 2.70%). Pass or fail therefore does not follow the true cost.
- **Cause [measured, 30 live curves]:** Jupiter's tokens out and sell proceeds are exact, but its reported `priceImpactPct` is not a reliable cost: of 60 legs, 6 were exactly 0.000, 7 were below 0.5% and 5 were above 3%, against a model value of 1.34% to 1.42% per leg. The sum ranged 2.48% to 5.43% (model 2.68% to 2.83%); 29 of 30 exceeded 2.5%, one was 2.482%.
- Rejected ONLY by the rule (recorded reasons exactly `excessive_round_trip_loss`, i.e. they had passed the old holder rule): 37 evaluations, 9 tokens. Their true break-even move is 3.44% to 3.85%; true PnL at a +2% / +3% / +4% / +6% move is -1.56% / -0.59% / +0.37% / +2.30% (median), positive for 0 / 0 / 37 / 37 of them.

## 7. Expected net edge across all 384 candidates
| Gross move | edge formula > 0 | simulator PnL > 0 | true PnL > 0 | true median PnL | simulator median PnL |
|---|---|---|---|---|---|
| 2% (quick-TP minimum) | 384 | 0 | 0 | -1.84% | -0.56% |
| 3% (quick-TP maximum) | 384 | 384 | 0 | -0.88% | +0.41% |
| 4% (momentum-TP minimum) | 384 | 384 | 266 | +0.08% | +1.39% |
| 6% (momentum-TP maximum) | 384 | 384 | 384 | +2.01% | +3.34% |
- True break-even below 2.5%: 0 of 384; below 3%: 0; below 3.5%: 9; below 4%: 266.
- No candidate has a positive true edge at a cost below 2.5%. Because every candidate's modelled gate number is above 2.5%, no candidate "passes a lower threshold": the question "negative edge despite passing a lower threshold" cannot be populated from this data. On the break-even scale: 9 candidates at or below 3.5% (all negative at +2% and +3%), 266 at or below 4.0% (negative at +2% and +3%, none at +4%).
- Candidates that passed every gate (9 evaluations, 5 tokens) became the 5 trades: exact PnL positive for 2 of 5.

## 8. Recorded simulated trades versus exact accounting [measured, 5 trades]
| price move | sim PnL | exact PnL | true break-even |
|---|---|---|---|
| +9.06% | +6.76% | +5.39% | 3.49% |
| +2.83% | +0.70% | -0.60% | 3.45% |
| +2.22% | -0.27% | -1.55% | 3.83% |
| +2.52% | +0.21% | -1.08% | 3.64% |
| +10.12% | +7.59% | +6.22% | 3.69% |
Sum: simulated +0.0449 SOL versus exact +0.0252 SOL; profitable 4 of 5 in the simulator, 2 of 5 with exact costs. The simulator overstates PnL by 1.28 to 1.37 points per trade. Real fees in these trades were 0.0085 to 0.0088 SOL against 0.0028 to 0.0029 SOL simulated.

## 9. Discrepancies between simulator, edge formula and trade accounting
1. **Neither the simulator nor the edge formula contains the Pump.fun fee.** Both use the generic 25 + 5 bps (0.30%) per leg; the curve charges 125 bps per leg. True break-even exceeds the simulator's by 1.34 points (1.33 to 1.34) and the formula's by 2.15 points (1.90 to 2.25).
2. **The formula counts one leg; the simulator counts both** (fees, fixed costs, slippage, impact), the earlier finding, now quantified: formula 1.77% versus simulator 2.58% median, before the Pump.fun fee gap.
3. **Token accounting is right, SOL accounting is not.** `entry_token_amount_raw` equals the exact fee-inclusive token amount in all 5 trades, but the position's SOL value is `filledAmountSol x price ratio`, which never sees the Pump.fun fee.
4. **Impact units differ between the entry filter, the edge and the gate.** Native impact excludes fees ("fees excluded" in the code); the gate's Jupiter figure is fee-inclusive but noisy; the edge subtracts the fee-exclusive impact once.
5. **Sell impact is measured against the pre-buy curve** in the loop (0.494% median) versus the post-buy curve (0.497%): immaterial.
6. **The gate tests 0.05 SOL, the position is 0.3 SOL**: impacts differ (about 0.09% versus 0.49% per leg).
7. **Reference frames differ**: the rule uses an unchanged reference; the strategy's TP uses the pre-entry spot, which already includes about 1% of our own price impact.
8. **Every candidate's true break-even (3.44% to 4.11%) is above the quick-TP range (2% to 3%)**: in the 5 recorded trades the quick-TP exits at +2.2% to +2.8% lost 0.6% to 1.6% with exact costs.

## 10. Limitations
The candidate set is 58 tokens at one fee tier from four short DRY_RUN runs; fixed costs are configured, not measured; state is the last recorded event before each evaluation (seconds old at most); graduated tokens, mayhem tokens and other fee tiers are not covered; only 5 trades exist and they held for 1 to 6 seconds; no post-entry price paths (shadow or replay) exist to say how often price moves beyond the break-even.

## 11. Conclusion
The **cost side is settled by existing data**: fees are deterministic and verified on chain and against live quotes, the exact model reproduces recorded trades to 0.00 points, and it shows (a) a 2.81% pure round trip and a 3.44% to 4.11% break-even move at the 125 bps tier, (b) a 2.5% rule that sits at the fee floor and whose outcome follows the noisy Jupiter `priceImpactPct` (70% fail) rather than the near-constant true cost, and (c) a simulator and formula that understate cost. The **policy for the 2.5% rule cannot be decided from existing data alone**: which value (or which quantity) is appropriate depends on how often real post-entry price moves exceed the 3.4% to 4.1% break-even within the holding window, and on the take-profit parameters. No shadow trades or price paths exist for that. More shadow data, recording post-entry price paths with exact fee accounting, is required before choosing the policy; the cost model itself needs no more data.
