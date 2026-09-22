# Phase 5.5 — Native Pump.fun bonding-curve market data

**Purpose:** let a young Pump.fun token that is still on the bonding curve reach the V1 filters *before* any DexScreener pair exists, removing the `market_data_unavailable` bottleneck for it. **V1 is unchanged** (age 30 s–15 min, liquidity ≥ 20 SOL, `volume1mSol` ≥ 5, buy/sell ≥ 1.5, 5 s velocity ≥ +1 %, acceleration ≥ 1.5x, impact ≤ 1 %, 0.3 SOL, TP/SL, 30 s timeout, 5 re-entries, 10 % daily loss, all hard-risk parameters). No PumpSwap, Raydium, live trading, signing, Telegram or AI. Read-only public chain data.

## 1. Where the curve state comes from

No account read, no per-token poll. **Every `TradeEvent` on the existing shared Pump.fun log stream carries the complete post-trade curve state** (virtual and real reserves, fee rates, mayhem flag). It is event-driven: state only changes when a trade happens, so the latest event *is* the current state as long as the stream's coverage is proven (Phase 5.4B rules).

Verified against the chain (live, 13 min, public RPC): **215 of 215** valid `BondingCurve` accounts equalled the post-trade state of the last event with slot ≤ the account read's context slot, on all four reserves, exactly. Also: real quiet tokens' accounts equal their last event (unit-tested with real fixtures).

## 2. Exact account layout (verified: IDL + 9 real accounts, sizes 125 B and 151 B)

`BondingCurve` (Anchor, discriminator `[23,183,248,55,96,216,172,96]`), PDA seeds `["bonding-curve", mint]` under `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (re-derived and equal to the real address for every fixture):

| Offset | Field | Type |
|---|---|---|
| 0 | discriminator | 8 B |
| 8 | virtual_token_reserves | u64 |
| 16 | virtual_quote_reserves (virtual SOL) | u64 |
| 24 | real_token_reserves | u64 |
| 32 | real_quote_reserves (real SOL) | u64 |
| 40 | token_total_supply | u64 (1e15) |
| 48 | complete | bool (true ⇒ graduated; reserves zeroed) |
| 49 | creator | pubkey |
| 81 | is_mayhem_mode | bool |
| 82 | is_cashback_coin | bool |
| 83 | quote_mint | pubkey |
| 115 | creator_fee_bps | u64 |
| 123 / 124 | can_edit_creator_fee / is_holder_reward | bool |

Accounts are 151 B (newer; 26 reserved bytes) or 125 B (older). The decoder (`src/volume/bondingCurveAccount.ts`, pure) classifies: missing → `UNAVAILABLE`; wrong owner → `WRONG_PROGRAM`; shorter than 81 B, wrong discriminator, non-boolean flag, real > virtual → `MALFORMED`; `complete` → `GRADUATED`; a read whose context slot lags the reference → `STALE`. It is used for verification and to classify any account ever read; production does not read accounts.

`Global` (real): initial virtual tokens 1.073e15, initial virtual SOL 30e9, initial real tokens 793.1e12, supply 1e15, fee 95 bps, creator fee 5 bps default (events carry the rate actually applied, commonly 30).

## 3. Price

`priceSol = (virtual_sol / 1e9) / (virtual_token / 10^6)` — SOL per whole token, from the latest curve state, in exact bigint math with 30 fixed-point digits (an early 1e12 scale lost 4 of 5 significant digits at prices ~1e-8; caught by a test).
Justification: the curve is a **constant-product** AMM over the virtual reserves. Verified on 14,238 non-mayhem events: every one is a valid step (k preserved within 1e-6; observed deviations ~1e-11) and 13,697 consecutive events of the same mint chain exactly (`post(n) = post(n−1) ± (sol, tokens)`), **0 breaks**. Sells follow `sol = floor(tok·vSol/(vTok+tok))` exactly; buys follow `tokens = floor(net·vTok/(vSol+net))` to ~1 lamport of `net` (the program's own rounding).
Decimals: 6 — verified on-chain for all 9 fixture mints; the pump program creates them with 6. A fresh curve prices at 30/1.073e9 = 2.7959e-8 SOL, which matches DexScreener's own price for untouched pairs to 4 digits.
`priceSol` is `null` if a reserve is not positive. Never USD, DexScreener, a stale value or a token amount.

## 4. Liquidity (defined, not assumed)

`liquiditySol = real_sol_reserves` — the SOL **actually held by the curve**, i.e. what sellers can withdraw. **Not** the virtual reserve: a brand-new curve has 30 SOL virtual and 0 SOL real, and equating virtual with liquidity would make the `≥ 20` filter meaningless (always true). This matches how the existing DexScreener path defines liquidity (SOL side of a TOKEN/SOL pool, Phase 5.2). Verified: `account lamports − real_sol_reserves` equals the account's rent-exempt minimum (`5,080 × (size + 128)`: 1,285,240 for 125 B, 1,417,320 for 151 B) within a few lamports (≤ 12 in the tests) on every SOL-quoted account, so the real reserve is genuinely backed SOL.
Consequence (a strategy result, threshold untouched): a curve needs 20 SOL raised (~24 % of the way to graduation) to pass. In the live sample 121 of 130 valid snapshots failed `liquidity_below_minimum`.

## 5. Price impact

Buy of the entry size, **execution price vs pre-trade spot, fees excluded**:

```
net   = floor(0.3e9 · 10000 / (10000 + fee_bps + creator_fee_bps))   # fees are charged on top of the curve amount
out   = floor(net · vTok / (vSol + net))
impact = (net / out) / (vSol / vTok) − 1
```
Exact bigint evaluation; for a constant-product curve this equals `net / virtual_SOL` (asserted in tests), **not** `0.3 / liquidity` — the naive real-liquidity shortcut is off by 0.09–1.8 percentage points across the tested curves. On the thinnest possible curve (virtual 30 SOL): 0.9877 % — under the unchanged 1 % limit, as a fact of the curve, not a tuned pass. The fee rates come from the latest event. Fees are excluded because they are a fixed ~1.25 % cost that would make every trade fail a 1 % limit. If `out` exceeds the tokens left on the curve (the buy would graduate it) or a reserve is empty, `priceImpactPct = null` and the filter **fails closed** (`price_impact_unavailable`) — the pre-existing "fallback impact" default is *not* used on the native route. Sell-side impact for exits reuses the buy figure as an approximation in the dry-run executor.

## 6. Unsupported curves: mayhem mode

`is_mayhem_mode` curves do **not** follow these mechanics: virtual SOL moves ~100× the traded real SOL (only 2,355 of 6,601 live mayhem events pass the k test, and only because those trades were tiny), so neither the spot price nor the impact formula applies. (Their real SOL *is* lamport-backed, but a liquidity number without a trustworthy price is not offered.) The event's mayhem flag is honoured: such tokens are `UNAVAILABLE / unsupported_mayhem_curve` — never priced with the standard formula, never sent to DexScreener silently. **In the live sample 17 of 50 new tokens (34 %) were mayhem-mode**; they cannot be evaluated natively. An event whose reserves do not satisfy the constant-product step is `MALFORMED` and unused. Non-SOL-quoted curves (2/50) are unavailable.

## 7. Normalized snapshot and source priority

`getNativeMarketSnapshot(mint, 0.3)` returns one coherent observation: `priceSol`, `liquiditySol`, `priceImpactPct` (latest curve state) plus `volume1mSol`, `previousVolume1mSol`, `volumeAccelerationX`, `buySellRatio` (buys/sells **counts** in the current window — the same convention as the DexScreener path; `+Infinity` when no sells, `0` when only sells, `null` when no trades), `txCount1m` (trades in the window) — all from the Phase 5.4B windows of the **same engine**: no duplicated volume or decoding logic. Quality vocabulary: `VALID / UNAVAILABLE / STALE / MALFORMED / GRADUATED / WRONG_PROGRAM / TIMESTAMP_SKEW`; every non-VALID snapshot has null price, liquidity, impact and volume (never 0).

`orchestrator/marketSourcePolicy.ts` (pure, table-tested):

| Discovery source | Native snapshot | Route |
|---|---|---|
| not Pump.fun | any | DexScreener (unchanged) |
| Pump.fun | VALID | **native** — DexScreener and Jupiter are *not called* |
| Pump.fun | GRADUATED | DexScreener (curve ended; PumpSwap pair may exist; native volume stays null) |
| Pump.fun | anything else | **`market_data_unavailable`** with the reason (`native_<reason>` recorded); DexScreener only if `DEXSCREENER_FALLBACK_FOR_CURVE_TOKENS=true` |

So DexScreener is never used "because it answers faster" for a curve token, and a native value is never mixed with a DexScreener field (different timestamps and definitions). The dry-run executor and position monitor get the same priority through `NativeFirstPriceSource` / `NativeFirstAggregator` (native when VALID; delegate only for graduated/unobserved; `null` when on the curve but unproven).
Graduation uses the 5.4B lifecycle state: price and liquidity become `null` (not 0, not the last curve price).

## 8. Timestamps and skew

Recorded per evaluation (new columns): `market_source`, `market_data_asof_sec` (stream watermark; the state is valid as of it), `volume_window_end_sec` (settled window end = watermark − 1), `state_event_sec` (block time of the last trade that changed the curve). Price/liquidity and volume share one stream and one watermark, so the skew is 1 s by construction; a maximum of **5 s** is enforced (`TIMESTAMP_SKEW` ⇒ everything null). All are event time (block time, 1 s precision); receive time is never used.

## 9. Files

New: `src/volume/{bondingCurveMath,bondingCurveAccount}.ts`, `src/orchestrator/{marketSourcePolicy,nativeFirst}.ts`, migration `005_native_market_data.ts`, tests `test/volume/{bondingCurve,nativeMarket,nativeMarketLoop}.test.ts`, fixture `bonding_curve_accounts.json` (9 real accounts + Global).
Changed: decoder (reserves, fee rates, mayhem flag), engine (per-mint curve tracking with chain/order handling, snapshot), recorder + replay (`replayNativeMarketSnapshot`), `loop.ts` (source routing), `baselineFilters.ts` (null ratio/impact fail closed: new reasons `buy_sell_ratio_unavailable`, `price_impact_unavailable`; thresholds untouched), types, config (`nativeMarketEnabled`, `nativeMaxSnapshotSkewSec`, `dexscreenerFallbackForCurveTokens`), `index.ts`, ledger (additive columns).

## 10. Live validation (real mainnet, public RPC, read-only)

**Harness** (real service on the real stream, 781 s, 50 tokens tracked from creation, snapshots at 30 s / 1 / 3 / 5 / 10 min; DexScreener and account reads used for validation only, never as data):

- Stream: 105,091 notifications (134/s, 70 % failed transactions), 21,600 trade events (27.7/s), 20,840 curve updates (26.7/s); 0 decode errors, 0 coverage breaks.
- Cost: decode mean 0.012 ms (p95 0.057 ms), aggregation mean 0.012 ms (p95 0.039 ms), snapshot query ~µs; heap 37 MB; CPU 20.6 s user + 3.8 s sys over 781 s (≈3 % of one core, harness included). **RPC requests by the native path: 0.** (The harness itself made 250 account reads at 19–70 ms and 250 DexScreener GETs for validation.)
- Availability by age (50 tokens): `VALID` 26 at every milestone; `mayhem` 17; `graduated` 4–5; non-SOL 2; no curve state yet 1. **DexScreener had no pair for 43/50 tokens at 30 s and 27/50 at 60 s; at ≥ 3 min all 50 had one** — the window this phase closes.
- Integrity: 215/215 accounts equal the event-chain state; 14,238/14,238 non-mayhem events are valid constant-product steps; 13,697/13,697 chain links consistent.
- Price cross-check (validation only, no same-instant independent source exists): vs DexScreener `priceNative` for 90 comparable snapshots, median ratio 1.000, 74/90 within 5 %, worst 0.74–1.55 on fast-moving tokens where DexScreener's price lags. The exact check is the account/event equality above.
- V1 on the 130 valid snapshots (thresholds unchanged, velocity not evaluated by the harness): `liquidity_below_minimum` 121, `volume_below_minimum` 95, `buy_sell_ratio_below_minimum` 33, `buy_sell_ratio_unavailable` 59, `volume_acceleration_below_minimum` 27, `volume_acceleration_unavailable` 46, **`price_impact_above_maximum` 0**; 2 snapshots passed every evaluated filter. These are strategy outcomes, not a reason to move any threshold.

Real examples (all still on the curve; "asOf / windowEnd / stateEvent" are event seconds; all account-verified):

| Mint | Age | vSOL | vTok (M) | real SOL | real Tok (M) | priceSol | liquiditySol | impact 0.3 SOL | vol 1m / prev | accel | asOf / windowEnd / stateEvent | DexScreener |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `EvchpvEQi6vSP2bAqq2mfkmnfKjweMky82dWicAhbr5z` | 30 s | 67.3455 | 477.98 | 37.3455 | 198.08 | 1.4090e-7 | 37.346 | 0.4400 % | 205.854 / 0 | +∞ | 1789967978 / …977 / …978 | **no pair** |
| `GJgHNkfGytcQC3P5kZWxnpgZE5Np5ZD5RzF2yoYCpump` | 32 s | 57.3388 | 561.40 | 27.3388 | 281.50 | 1.0214e-7 | 27.339 | 0.5167 % | 204.153 / 0 | +∞ | 1789968006 / …005 / …006 | **no pair** |
| `HWdveFes67UGe8tFLhRcT6kjHoCJBW6DxW2Qtp6joKDS` | 61 s | 32.1943 | 999.87 | 2.1943 | 719.97 | 3.2199e-8 | 2.194 | 0.9203 % | 44.592 / 0 | +∞ | 1789968166 / …165 / …160 | **no pair** |
| `7tRXkg9eHLPekS7FLRw1zXr1qcc6cysWZimtHCgGK2Ua` | 61 s | 32.2135 | 999.27 | 2.2135 | 719.37 | 3.2237e-8 | 2.213 | 0.9198 % | 29.547 / 0 | +∞ | 1789968063 / …062 / …036 | **no pair** |
| `9UmLfYSySiYoWBpa74qMkDGUdG7HkeDk81FdYsxmpump` | 183 s | 40.4442 | 795.91 | 10.4442 | 516.01 | 5.0815e-8 | 10.444 | 0.7326 % | 21.165 / 2.331 | 9.08 | 1789968140 / …139 / …138 | pair (pumpfun) |
| `7MQdkExZtXzcJaQGUymwHKuRJM1z1ERWTZnfjLsSpump` | 301 s | 30.9967 | 1038.50 | 0.9967 | 758.60 | 2.9848e-8 | 0.997 | 0.9559 % | 0.502 / 0 | — | 1789968382 / …381 / …322 | pair (pumpfun) |
| `Dp4ZoKDQsWcsRdf2X39LihmBcSkiReTj6GmWYKoMRj98` | 602 s | 30.1843 | 1066.45 | 0.1843 | 786.55 | 2.8303e-8 | 0.184 | 0.9816 % | 0.184 / 0 | — | 1789968707 / …706 / …657 | pair (pumpfun) |

**Real engine** (`node dist/index.js`, `DRY_RUN=true`, shadow on, 5 min): 294 evaluations for the 2 tokens the (pre-existing, RPC-based) creation detector managed to discover — that path logged ~2,300 HTTP 429 / failed-handling warnings on the public endpoint. Both were evaluated with `market_source = pumpfun_native` and **no DexScreener/Jupiter request**: one mayhem token (`market_data_unavailable` + `native_unsupported_mayhem_curve`, explained), and one standard token that reached the V1 filters with real values, e.g. price 6.67e-8, liquidity 16.34 SOL (fails ≥ 20), volume 32.55 SOL, acceleration +∞, buy/sell 1.95, impact 0.639 %, stamped asOf/windowEnd/stateEvent, failing only `liquidity_below_minimum` and `price_velocity_below_minimum`. The pipeline goal — V1 reaching the volume stage for a token with no DexScreener pair — is demonstrated.

## 11. Tests

Engine 498 tests / 63 files (was 442; +56), Python 242; build, typecheck (`tsconfig.test.json`), lint clean; `git diff --check` clean. New coverage: real account decoding (both sizes, malformed, wrong owner, wrong size, missing, graduated, stale, PDA, rent), curve math (price, decimals, liquidity, exact impact vs the `net/vSol` identity and vs the naive shortcut, 0.3 SOL entry, exhausted curve, k-step and chain checks, mayhem step rejected), snapshot (valid, mayhem, malformed, stale after break, skew, graduation, no curve, non-SOL, same-slot reorder, missing trade), the source-priority table, the new-token flow, and loop-level tests (no DexScreener pair, native route makes 0 aggregator/price calls, unavailable route does not fall back, graduated → DexScreener, fallback flag, Raydium unaffected, production == shadow == backtest snapshot == recorded-event replay), plus read-only architecture tests.

## 12. Limitations

- **34 % of new tokens (mayhem mode) are unsupported** natively; they end as `market_data_unavailable` with a stated reason.
- Liquidity ≥ 20 SOL real means most young curves fail V1 on liquidity — a strategy result.
- A token with no trade yet has no curve state (the `CreateEvent` reserves are not used).
- After a stream break the state is `STALE` until the token trades again; volume returns after 60 s / acceleration after 120 s (Phase 5.4B).
- `priceImpactPct` for exits reuses the buy figure (dry-run approximation); sell impact is not modeled separately.
- The account decoder is verification tooling; production trusts the events (215/215 equal on a healthy 13-minute stream; silent drops that keep the socket healthy remain undetectable).
- Discovery still relies on the RPC-based creation detector (heavily rate-limited on the public endpoint); the native `CreateEvent` could replace it — separate work.
- Historical backtests only have native market data for periods with recorded events; otherwise `UNAVAILABLE` (nothing is fabricated).
