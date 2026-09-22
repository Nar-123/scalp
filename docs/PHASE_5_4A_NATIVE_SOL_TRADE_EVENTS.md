# Phase 5.4A — Native SOL trade-event investigation

**Investigation only. No production, shadow, backtest or config code was changed. No V1 threshold was touched. No provider was implemented.**
Public chain data only: `logsSubscribe`, `getParsedTransaction`, `getAccountInfo`, `getBlocks`, `getSignaturesForAddress` on the public mainnet-beta RPC. No key, signer, simulation or transaction construction.

## Verdict

| Source | Status | Why |
|---|---|---|
| **pump.fun bonding curve** | **READY** (for implementation, with the conditions below) | `TradeEvent` in the free `onLogs` push carries mint, SOL amount, direction, user, event timestamp. All amounts matched independent balance deltas. No RPC call per event. |
| PumpSwap | **NOT_READY** (not supported by the project; feasible) | Event has amounts, direction, timestamp and the *pool*, but **no mint**; needs a pool→mint registry (1 `getAccountInfo` per pool, verified) and a quote-mint check. Out of scope for this phase. |
| Raydium AMM V4 | **NOT_READY** | `ray_log` has amounts and direction but **no pool, no mint, no timestamp**; needs one `getParsedTransaction` per swap (the project caps that at 1/s) or per-pool `mentions` subscriptions. The project's own Raydium creation detector has never been confirmed on a live pool creation. |

Consequence to decide later: a pump.fun token that graduates stops producing bonding-curve events. That must become `null`, never `0`, until PumpSwap is supported.

## 1. Existing event infrastructure (what is really observable today)

| Program | Program ID | Detected today? | Event / instruction used today | Data available in the current code | SOL amount | Timestamp | Buy/sell | Pool/market | Signature | Index |
|---|---|---|---|---|---|---|---|---|---|---|
| pump.fun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | **Creation only** (`Create`/`CreateV2` discriminator + signer check, top-level and nested) | `onLogs` pre-filter → `getParsedTransaction` → `detectPumpFunCreation` | mint, slot, blockTime | not extracted | blockTime (s) | not extracted | – | yes (`logs.signature`) | not extracted |
| Raydium AMM V4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | **Pool creation only** (`initialize2` tag 1; never confirmed live) | every log fetched at ≤1/s | LP mint, pool, slot | not extracted | blockTime | not extracted | pool | yes | not extracted |
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | **No** (no reference anywhere in `engine/src`) | – | – | – | – | – | – | – | – |

No trade decoding exists. Existing fixtures (`engine/test/discovery/fixtures/*`) are trimmed `getParsedTransaction` responses **without `logMessages`**; they contain one pump.fun `Buy` (aggregator-routed) and one Raydium `SwapBaseIn` as instructions only. The subscribers use web3.js `onLogs` (commitment `confirmed`).

## 2. pump.fun — findings (real mainnet)

- IDL read from the on-chain Anchor IDL account (`anchor:idl`), not guessed. `TradeEvent` discriminator `bddb7fd34ee661ee`. Fields used: `mint, sol_amount, token_amount, is_buy, user, timestamp, fee, creator_fee, ix_name, quote_mint, quote_amount` (newer builds also carry `quote_mint`).
- The event reaches us **twice per transaction**: as a `Program data:` log line (visible in the `onLogs` push) **and** as an Anchor `emit_cpi` self-invocation (inner instruction whose data starts `e445a52e51cb9a1d`). Exactly one of the two must be used or volume doubles (16/16 checked transactions had both).
- Attribution: a `Program data:` line belongs to pump.fun only when the invoke-stack top is the pump.fun program (same walker approach as `programLogs.ts`). Wrapper programs also log their own `Program data:` lines that must be ignored (seen live).
- **`sol_amount` semantics (verified):** the SOL that moved into/out of the **bonding curve, excluding fees**. Sell: curve balance delta = −`sol_amount` exactly (6/6). Buy: curve delta = +`sol_amount` exactly (2/2, including `buy_exact_quote_in`, where the user paid 133,768,010 lamports for `sol_amount` 132,116,552 — fees are separate fields). `fee`, `creator_fee` are additional.
- **`is_buy`** is an explicit field (not inferred from price).
- **Non-SOL quote assets exist.** In 75 s of live traffic, 198 of 2,159 successful pump.fun trade events (9.2 %) had a `quote_mint` other than native SOL (`1111…1111`), including USDC. For those, `sol_amount` is **not SOL**. Rule: count only `quote_mint == 11111111111111111111111111111111` (native) — anything else is excluded (and if the field is absent on an old build, treat as SOL only after verifying the program build; otherwise unknown).
- **Failed transactions** are 39 % of pump.fun notifications (1,737 / 4,449): `logs.err != null` must be dropped.
- Multi-trade transactions: none in the pump.fun sample (0 / 2,159), but the identity scheme below supports them.
- `Log truncated` never occurred in ~50 k notifications; when it occurs the log event is lost and the CPI event (or a `getTransaction`) is the fallback.

## 3. PumpSwap — findings (not implemented)

- Program ID `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; events `BuyEvent` / `SellEvent` (on-chain IDL). Direction = which event. Each has `timestamp`, the **pool** pubkey, `user`, quote amounts, fees. **No mint field.**
- SOL amount that matches the pool's quote-vault balance change exactly (8/8 checked): BUY → `quote_amount_in_with_lp_fee`; SELL → `quote_amount_out_without_lp_fee`. (`quote_amount_in`/`quote_amount_out` include protocol/creator/buyback fees, so they are not the pool-side amount.) Difference between buy and sell definitions is the LP fee (~0.2 %).
- Pool → mint: pool account bytes `disc(8) | bump(1) | index(2) | creator(32) | base_mint(32) | quote_mint(32)`; matched the buy/sell instruction's accounts[3]/[4] in 4/4 checked. Quote mint must be WSOL (`So111…112`); other quote mints exist and must be excluded.
- Different decoder (different program, different events). Multi-event transactions are common (1,500 of 15,059 successful swap transactions had 2–4 events, mostly arbitrage bundles).
- Rate: ~470 notifications/s (≈220 swap events/s, ≈1.8 MB/s of log payload) — 8× pump.fun.

## 4. Raydium AMM V4 — findings (existing scope only)

- Swap log: `Program log: ray_log: <base64>`; type 3 = SwapBaseIn (`amount_in, min_out, direction, user_source, pool_coin, pool_pc, out_amount`, u64 LE after the 1-byte type), type 4 = SwapBaseOut. Verified against pool vault balance deltas on 6 transactions: the SOL side amount equals `out_amount` (when SOL is the coin side and direction = 1) or `amount_in` (when SOL is the pc side and direction = 1); direction is 1/2 (only direction 1 was covered by the 6 verified examples; direction 2 is not verified) and which side is SOL depends on the pool's coin/pc mints.
- **Not in the log:** pool address, mints, timestamp. Getting them needs the transaction (accounts + blockTime). The existing subscriber already limits itself to 1 transaction fetch/s for RPC-budget reasons. A per-pool `mentions` subscription would identify the pool but still not give a timestamp (needs `getBlockTime(slot)`, one call per distinct slot).
- 17 swap events/s, 133 notifications/s (53 % failed), ~334 KB/s.
- Not expanded to CLMM/CPMM/stable swap.

## 5. Definition of `volume1mSol`

`volume1mSol` = sum, over **successful swap events of one token in the window**, of the **gross pool-side native-SOL amount** of each swap, buys and sells both counted (buy SOL volume + sell SOL volume). Per venue: pump.fun = `sol_amount` (curve movement, fees excluded); PumpSwap (future) = pool quote-vault movement as above.
Excluded: liquidity add/remove, token or SOL transfers, failed transactions, any event whose quote asset is not native SOL/WSOL, routing instructions (only the venue program's own event is counted), and any event missing amount, direction or timestamp.
Not removed: arbitrage/wash volume (it is real swap volume on that venue; any future wash filter would be a separate, reviewed decision). Fees are never included, so the value is slightly smaller than "SOL paid by users" (≈1–3 %).

## 6. Timestamp

- `TradeEvent.timestamp` (i64 seconds, Solana `Clock`) equalled the transaction `blockTime` in **16/16** transactions checked. It is identical for every event in a slot (0 / 280 slots had more than one value) and never decreased along slot order (0 / 2,159).
- Precision: **1 second** (a slot is ~400 ms, so ~2–3 slots share a timestamp).
- The log push has **no blockTime**, but the event's own timestamp supplies the market-event time — no extra RPC. Slot → block time would need `getBlockTime` (not needed for pump.fun/PumpSwap; needed for Raydium).
- Local receipt time is a different quantity: measured `recv − event_ts` = min 0.54 s, p50 1.10 s, p95 1.58 s, max 2.06 s (pump.fun; PumpSwap p95 1.63 s). That includes up to 1 s from the second-granularity truncation. Receipt time must be stored only under a `received_at` label.

## 7. Deduplication

Event identity = `(signature, program, event_ordinal)`, where `event_ordinal` is the 0-based position of the program's own trade events in that transaction's log stream (same walker for live logs and for `meta.logMessages` of a backfilled transaction, so both share one namespace). Signature alone is wrong (PumpSwap has multi-event transactions). Do not mix with the CPI-instruction identity `(top_index, inner_index)`.
Measured: a single subscription delivered no duplicate signature in ~50 k notifications; **two overlapping subscriptions (same program) delivered 100 % identical duplicates** (4,449 of 4,449), and a per-mint `mentions` subscription overlaps the global one by construction. So dedupe is required whenever more than one path can deliver an event (second subscription, mentions + global, backfill, reconnect). web3.js re-subscribes on ws close without replay, so a reconnect does not by itself create duplicates; a *replay via backfill* would. A live reconnect replay was **not** induced/tested here.

## 8. Rolling 60-second window (design only, not implemented)

`volume1mSol(T) = Σ sol_amount over valid events with T − 60 < ts ≤ T`, `ts` in whole seconds (half-open interval `(T−60, T]`): an event at `T−60` is **excluded**; `T−59` is included; `T` is included. Sub-second offsets (`T−60.001`, `T−59.999`) collapse to whole seconds because event time has 1 s precision. `T` is the stream watermark (latest event timestamp seen on the global stream, which carries ~30+ trades/s), not the local clock. Out-of-order: none observed (0 / 4,449 slot regressions) but events are inserted by identity, not arrival order; an event arriving with `ts` still inside an already-emitted window is applied to future evaluations and flagged `late_event` (never silently rewrites a decision already taken); one older than a grace period (suggest 5 s) is counted and ignored.

## 9. Acceleration

`current_1m = V(T)`, `previous_1m = V(T−60)` with the identical definition over `(T−120, T−60]`. Requirements: (a) the stream must have been continuously healthy for the whole 120 s (else `null`); (b) `previous_1m = 0` with full coverage is a true zero → the existing Phase 5.1/5.2 rule applies (`+Infinity` → `degenerate_ratio` warning) — flagged as a decision for the owner; with incomplete coverage it is `null`; (c) a token first seen < 120 s ago from a source other than its own creation event has insufficient history → `null` (a token discovered from its pump.fun `Create` has complete history if the stream was continuous); (d) any RPC/subscription gap overlapping either window → `null`.

## 10. RPC / event architecture and load

Measured over 75 s (public mainnet-beta):

| Stream | notifications/s | failed | swap events/s | payload |
|---|---|---|---|---|
| pump.fun | 59 | 39 % | 29 (≈27 SOL-quoted) | ~164 KB/s |
| PumpSwap | 469 | 27 % | 221 | ~1.8 MB/s |
| Raydium V4 | 133 | 53 % | 17 | ~330 KB/s |

- **Option A — per-token polling:** `getSignaturesForAddress` took 420 ms per call, plus one `getTransaction` per new signature. For 50 tracked tokens every 2 s that is ≥25 calls/s before transaction fetches; the public RPC returned 429s at well under that. Rejected.
- **Option B — one shared program-log subscription:** 1 websocket subscription per program, **0 RPC calls per event** (the event is inside the push). Cost is bandwidth/CPU. Recommended for pump.fun (164 KB/s). One decode per notification, then route by mint.
- **Option C — per-mint `mentions` subscription** (`logsSubscribe {mentions:[mint]}`): tested on the busiest mint: it delivered every signature the global stream had for that mint (82/82 with 0 missing) plus failed/other transactions (101 total). Far lower bandwidth, but one subscription per tracked token (provider limits unknown), and a token that is not yet tracked cannot be back-filled.
- Memory: ~100 B per retained event × (120 s window + grace). A hot token produced ~4 events/s; 100 tracked tokens ≈ 1–3 MB plus a dedupe set of recent identities. Active tokens: 130 distinct pump.fun mints traded in 75 s; only 14 of 113 SOL-quoted mints did ≥5 SOL in that period (so the V1 volume filter is selective).
- Recommended: B for pump.fun with mint routing; C is an optional optimisation later; never A.

## 11. Event loss

- The project has **no** disconnect/gap handling: `index.ts` creates a plain `Connection`; the subscribers only call `onLogs`. web3.js marks subscriptions `pending` on an implicit close and re-subscribes; **missed notifications are not replayed and callers are not told**. HTTP 429 is only visible on RPC calls, not on the websocket push.
- Slot coverage measured: 282 of 282 confirmed-produced slots had a PumpSwap notification (0 gaps, 0 phantom slots). For sparser streams (pump.fun 281/282) an empty slot cannot be told apart from a lost one, so slot gaps are **not** a sufficient detector.
- Detectors that do work: (1) stream silence watchdog on the global stream (PumpSwap/pump.fun never idle for seconds), (2) a heartbeat via `onSlotChange` or the ws state, (3) **signature reconciliation** per tracked token via `getSignaturesForAddress` (420 ms/call; 91 on-chain signatures in the window vs the stream: 0 missing). Loss *injection* was not tested; reconciliation detects loss by construction.
- Rule: unknown coverage ⇒ `volume1mSol = null`. Missing events must never be treated as zero volume. After a reconnect, windows overlapping the gap stay `null` until they slide past it.
- Unproven: silent server-side drops under provider load; only one 75 s healthy window was observed.

## 12. Backtest availability

| Item | Classification |
|---|---|
| Native SOL trade events in the project's own ledgers | **UNAVAILABLE** (no trade events were ever stored; shadow/backtest ticks hold aggregator snapshots) |
| Historical pump.fun trade events (recoverable from chain) | **AVAILABLE** at ≈1 `getTransaction` per trade (CPI event or `meta.logMessages`), subject to RPC retention/archive access; not attempted here |
| Past `volume1mSol` values already in the ledgers | **ASSUMED / invalid** (pre-5.2 rows were mislabelled; post-5.2 rows are `null`) |
| Future runs | **OBSERVED** once an event recorder exists (a stored event log is what makes exact replay possible) |

Nothing was reconstructed or fabricated.

## 14. Real examples (mainnet, slot 448936243, blockTime 1789961967)

pump.fun (`ordinal` 0; event = log `Program data`; CPI copy at top/inner index shown):

| Signature | Mint | SOL | Dir | Index (top/inner) | Verified vs |
|---|---|---|---|---|---|
| `ah7nYyFc46cx8zRJXXPsdzXvZpom8x9vYY6B6P9nfSvcqKWLgWGZncKeV79vYxDBVbznaJtTR38fwbHjNk8xhKe` | D9QvnRSH…6pump | 0.084881233 | SELL | 0 / 3 | curve Δ −84,881,233 |
| `5PvKtKbeQa1TvY2MdvyCNZM1EKhafLfgh2VFmtuto96os1tMHT4z4rzj8B5aU3jmbQheZX7rkiiVAsrJXtu4mLJn` | 2ezxLpAU…Vpump | 0.006051369 | BUY | 2 / 4 | curve Δ +6,051,369 |
| `28wXPWD5FmtkKV6yGaRP5YJ3VkdoR5ayLsXFqdahLZERk8owq5ieNwvnikQ3L2wobLXFhtPCVEAo36QKaFoSukxS` | 27YL5o5B…Kpump | 0.132116552 | BUY (`buy_exact_quote_in`) | 4 / 11 | curve Δ +132,116,552 (user paid 133,768,010) |
| `5Si3QzeAjmQEpD9yVEx6BGHc2hjThgJMpd174dWakJBjbZjodsSz7Q7zbpe68zKPQvYsk4UFQJaVCR68wdrxEfMJ` | 2ScF2fgc…Xpump | 0.313078337 | SELL | 2 / 2 | curve Δ −313,078,337 |

PumpSwap: `2wLb6nF2LzaSwh4vrGQMmaM2CieLvTa8ov5Mp4st6JMqTW9zWn1HArBpjXYbDv3TqJ8kptuUfk5AAF7wHAqYtmfQ` (BuyEvent, pool `5zhXTXsp…`, 0.440479076 SOL = pool-vault Δ), `4HEHVDZrngUpL4jphuhpZDmZdGmP7vbdSUtE1NcWgNqsMy1tcxVnm8xWvZG4fw93vn1q4a8hQdSucNLQ1v2tTx64` (SellEvent, pool `4jHsJvHb…`, 0.008234346 SOL = pool-vault Δ −8,234,346).
Raydium V4 (SwapBaseIn, direction 1): `28wXPWD5FmtkKV6yGaRP5YJ3VkdoR5ayLsXFqdahLZERk8owq5ieNwvnikQ3L2wobLXFhtPCVEAo36QKaFoSukxS` (SOL-side 0.133768010 = WSOL vault Δ), `qBCg2nC8VPj6iR4hQqJ5zvfwbt6jifrr8zWtxH8XbfNRdT3jG17cG2vCUu9LyBjUjvu6uQbNzQkyqCmSw44iM8h` (SOL-side 0.0998 in = WSOL vault Δ +99,800,000).
These are 16 pump.fun/PumpSwap and 6 Raydium transactions from one slot — **a handful of examples, not proof of universal support.** Several transactions are arbitrage bundles touching more than one venue in the same transaction (one transaction appears under pump.fun/PumpSwap/Raydium), which is why per-venue event identity matters.

## 15. Acceptance (pump.fun bonding curve)

| Requirement | Result |
|---|---|
| Known SOL amount | yes — `sol_amount` (curve, fee-exclusive), only when `quote_mint` is native SOL |
| Known event timestamp | yes — `TradeEvent.timestamp` = blockTime, 1 s |
| Known event identity | yes — `(signature, program, ordinal)` |
| Known direction | yes — `is_buy` |
| Duplicate protection | designed and shown necessary (100 % duplicates with 2 subscriptions); not yet implemented |
| Event-loss visibility | partial: watchdog + reconciliation are feasible; slot gaps alone are insufficient; not implemented |

→ pump.fun: **READY** for a follow-up implementation phase, conditional on quote-mint filtering, one-channel counting, dedupe, coverage tracking → `null`, and graduation → `null`. PumpSwap and Raydium V4: **NOT_READY**.

## Recommended implementation path (next phase, not started)

1. `TradeEventDecoder` for pump.fun (pure, fixtures from real logs), log-based only.
2. Event store + identity dedupe + 120 s per-mint window; coverage tracker (`continuousSince`, watchdog, gap flags).
3. `OneMinuteVolumeProvider` returning `volume1mSol: number | null` (+ window end, coverage flag); `null` on any gap, unknown quote, graduation, or missing history.
4. Record the raw normalized events to the ledger so backtest/shadow can replay exactly.
5. PumpSwap decoder + pool registry as a separate, later phase (graduated tokens).

## Remaining unknowns

Provider behaviour under load (silent drops, ws limits, subscription caps); a real reconnect-replay case; whether older/other pump.fun builds omit `quote_mint`; graduation event timing relative to the last curve trade; wash/arbitrage share of the volume; behaviour on a paid RPC (latency, lag) versus the public one; cost of historical reconstruction.
