# Phase 5.4B — Pump.fun native 1-minute SOL volume

**Scope: Pump.fun bonding-curve trades only.** No PumpSwap, no Raydium trade volume, no other venue.
V1 is unchanged: `volume1mSol >= 5 SOL`, `volumeAccelerationX >= 1.5x`, position 0.3 SOL, daily loss 10 %, 5 re-entries, 30 s timeout, all hard-risk parameters frozen. No live trading, signing, broadcasting, Telegram or AI was added. Everything here reads public chain data that the existing `onLogs` subscription already delivers.

## Data path

```
ONE Pump.fun onLogs subscription (PumpFunLogSubscriber, unchanged subscription)
   └─ logTap (every notification) ─► PumpfunVolumeService.onLogNotification
        └─ decodePumpfunNotification  (pure)     ─► trades / lifecycle / status
        └─ PumpfunVolumeEngine        (pure)     ─► dedupe ─► per-second buckets ─► windows
        └─ TradeEventRecorder (bounded, batched) ─► pumpfun_trade_events / lifecycle / coverage log
   consumers:  OneMinuteVolumeProvider.getOneMinuteVolume(mint) -> { volume1mSol, volumeAccelerationX, windowEndSec, coverage }
```

No RPC request is made per trade, per token or per poll; the volume path performs **no RPC at all** (an architecture test forbids it). Production, shadow and backtest read the same normalized fields; the recorded-event replay runs the **same engine class**.

## Files

New: `engine/src/volume/{types,pumpfunTradeEventDecoder,boundedStructures,pumpfunVolumeEngine,tradeEventRecorder,recordedVolumeReplay,pumpfunVolumeService}.ts`, `engine/src/ledger/migrations/004_pumpfun_trade_events.ts`, tests `engine/test/volume/*`, real fixtures `engine/test/fixtures/pumpfun/{notifications,dual_channel_transactions}.json`.
Changed: `discovery/programLogs.ts` (own `Program data:` walker, truncation marker), `discovery/pumpFunLogSubscriber.ts` (optional `logTap`), `orchestrator/loop.ts` (optional `volumeProvider`; baseline-rejected evaluations now also record the observed volume/velocity values instead of nulls), `ledger/db.ts`, `config/{schema,loader}.ts`, `index.ts`, `.env.example`.

## Decoder

Layout read from Pump.fun's on-chain IDL and checked on real transactions in Phase 5.4A. Fields: `mint, sol_amount, token_amount, is_buy, user, timestamp, quote_mint` plus signature, slot, program, ordinal. Direction is `is_buy`; nothing is inferred from price.

- **Canonical channel = the `Program data:` log line** (present in the free push). The `emit_cpi` self-invocation copy is never counted; `decodeParsedTransactionTrades` proves the two agree on the real dual-channel fixtures (1 counted, 1 CPI copy, 1 matched).
- **Success only.** `err === null` is required. `err !== null` → failed, no events. `err === undefined` (status unknown) → discarded, never assumed success.
- **Quote filter.** Counted only if `quote_mint == 11111111111111111111111111111111` (native SOL, the representation observed on every SOL-quoted event) **and** `quote_amount == sol_amount` (self-consistency of the denomination). Wrapped SOL is not accepted (never observed as a Pump.fun curve quote). Any other quote mint → class `other`; missing quote fields (older layout) or a mismatch → `unproven`. Both are excluded, and the token becomes unavailable (never 0).
- Malformed core fields, an implausible timestamp, or a truncated log are recorded as coverage breaks (a silent loss otherwise).

## Volume definition and windows (event time, whole seconds)

- Watermark `W` = newest event second seen on the stream (any mint, successful transactions).
- Window end `T = W − 1`: the newest second is still filling (2–3 slots share one second), so `T` is the newest **settled** second. Using `W` would undercount the current window and bias acceleration upward. This is a deliberate reading of "T = stream watermark"; `settleSec` is configurable.
- **Current** = `(T−60, T]` = seconds `T−59 … T` (`T−60` excluded). **Previous** = `(T−120, T−60]` = seconds `T−119 … T−60` (`T−60` belongs here). Integer boundaries are unit-tested.
- Volume = Σ gross curve-side native SOL of counted trades, buys + sells, fees excluded, integer lamports. No token amounts, price or USD is used.
- The local clock is used **only** for liveness (silence and stale-watermark checks); it never places an event in a window and never defines `T`. Receive time is stored as `receivedAtMs` metadata only.
- Watermark behavior: several events in one second → same second; out-of-order arrival → inserted by event time (counted as `lateEvents`); no event for a while → silence watchdog (5 s) breaks coverage; reconnect → coverage restarts at the first new event's second + 1. Events older than `W − 180 s` are dropped; events more than 30 s ahead of the local clock are rejected.

## Acceleration

`current / previous` over the identical definition. `previous > 0` → ratio. `previous == 0 && current > 0` → `+Infinity` (existing `degenerate_ratio` warning path, unchanged). `previous == 0 && current == 0` → **`null`** (undefined; nothing is manufactured — note this differs from the old snapshot-history path, which returned 0 for that case; the provider is authoritative when configured). `previous` uncovered → `null`.

## Coverage (the critical part)

A window is answered only if every event that could belong to it was provably observed. `volume = 0` is returned **only** with proven coverage; otherwise `null`.

| Situation | Result |
|---|---|
| Stream not started / no event yet / first 60 s after start or a break | `null`, `UNKNOWN` (`insufficient_history` / break reason) |
| Websocket close | `null` (`stream_disconnected`), `epoch++` |
| Reconnect (web3.js re-subscribes, **no replay**) | still `null` until the first new event; current window answerable 60 s later, previous 120 s later |
| No notification for `silenceMs` (5 s) | break (`stream_silent`) |
| Websocket error, malformed event, truncated log, capacity overflow | break |
| Watermark > 30 s behind the wall clock | `null` (`watermark_stale`) |
| Token never seen on the stream (e.g. a Raydium LP mint) | `UNAVAILABLE` (`mint_not_observed`) |
| Non-SOL or unproven quote | `UNAVAILABLE` |
| Graduated (`CompleteEvent` / `CompletePumpAmmMigrationEvent`, sticky) | `UNAVAILABLE` (`graduated`) — **not 0** |
| Token last proven on the curve before a break | `null` (`token_state_unproven`) until it trades again (it may have graduated inside the gap) |
| Token created inside the current healthy period | coverage counts from its own creation: a window before it existed is a proven 0 |

**Reconciliation is not implemented.** The only signature-level check available (`getSignaturesForAddress`) would need a `getTransaction` per missing trade to recover volume; that is exactly the per-trade RPC this phase must avoid. So a gap is **outlived, never repaired**: after any break the affected seconds must slide out of the window (60 s for the current window, 120 s before acceleration returns). Recovery is by the documented rule above, not by assumption.

Detection depends on the private `Connection._rpcWebSocket` events (`close`/`open`/`error`). If web3.js ever removes them, `attachConnectionHooks` returns `false` (logged, reported in stats) and only the silence watchdog remains.

## Deduplication

Identity `(signature, program, eventOrdinal)`; ordinal = position among the program's own trade events in the transaction's logs. `BoundedIdentitySet`: pruned by event time (retention 180 s) and hard-capped (200 k, FIFO). Verified: same notification twice / re-delivered later counts once; two events of one signature are both counted. Live: 14 duplicate notifications (0.24 %) arrived on the **single** subscription in the first 4 minutes and were correctly discarded.

## Memory

Per-mint per-second buckets (integer lamports), retention 180 s, hard cap 200 k buckets (overflow → coverage break), mint states idle-pruned (2 h, cap 50 k, eviction is fail-closed). Test: 36 k events across ~900 mints → buckets ≤ 7.4 k, dedupe ≤ 7.4 k.

## Recording and replay

Migration 004: `pumpfun_trade_events` (signature, program, event_ordinal, mint, sol_amount_lamports, token_amount, is_buy, event_timestamp, slot, quote_mint, quote_class, source, received_at_ms; PK = identity), `pumpfun_lifecycle_events`, `volume_coverage_log`. Only accepted events are recorded (failed transactions are not); no trader address, key or secret is stored. Batched writes (1 s), buffer cap, retention 24 h (`PUMPFUN_TRADE_EVENT_RETENTION_HOURS`), and a DB failure only increments a counter. `replayPumpfunVolume(db, mint, atMs)` rebuilds the value through the same `PumpfunVolumeEngine` from recorded events and the recorded coverage log; with no recorded events it returns `null` (`no_historical_events`) — nothing is reconstructed from 5m volume, DexScreener, GMGN, price or counts. Replay only looks back 15 minutes, so it can be **more** conservative than live (null where live had a value), never less. The Python side does not read these tables yet.

## Integration

`startOrchestrator(..., { volumeProvider })`. When present it is authoritative for `volume1mSol` **and** `volumeAccelerationX`, including when it answers `null`; an aggregator number can never fill in. When absent, behavior is exactly as before. `PUMPFUN_NATIVE_VOLUME_ENABLED=false` returns to the previous behavior. Consistency test: the same event set gives the identical value in the provider, the shadow tick, the production ledger row, the backtest snapshot and the recorded-event replay.

## Live read-only validation (real mainnet, public RPC, 5 minutes)

The real entrypoint (`node dist/index.js`, `DRY_RUN=true`, shadow on, nothing signed) against `api.mainnet-beta.solana.com`:

- 23,395 notifications in the first 240 s (≈97/s average, 167/s in the last minute; 64 % failed transactions), 5,731 trade events decoded (≈24/s; 27/s in the last minute), 5,717 accepted, 5,552 counted in volume, 162 excluded non-SOL-quote, 14 duplicates, **0** decode errors, truncated logs, capacity drops, unknown statuses or coverage breaks; 56 create events, 3 graduations (all 3 → `UNAVAILABLE/graduated`).
- Latency: decode mean 0.017 ms, p95 0.063 ms, max 3.7 ms; aggregation mean 0.009 ms, p95 0.025 ms; query mean 2.8 µs (200 mints, 4.5 k buckets, micro-benchmark). Heap 34–53 MB. RPC requests from the volume path: **0**.
- Manual verification (recorded events vs an independent SQL recomputation, no engine code), latest windows:

| Mint | events (120 s) | current 1m | previous 1m | acceleration | coverage |
|---|---|---|---|---|---|
| HhkNggVjUJ… | 699 | 131.311021834 (indep. 131.311021834) | 117.844050838 (same) | 1.114 | COMPLETE |
| 244hMYe6AW… | 588 | 76.236957354 (same) | 165.607186935 (same) | 0.460 | COMPLETE |
| 2NmE3tmK9U… | 177 | 1.899199165 (same) | 1.197875168 (same) | 1.585 | COMPLETE |
| Ry2TVaYjm9… | 174 | 0.204979400 (same) | 1.841861837 (same) | 0.111 | COMPLETE |
| CdqwSVm1bP… | 167 | 15.109418015 (same) | 23.061119281 (same) | 0.655 | COMPLETE |
| AEBkbXzWfc… | 113 | 8.176007861 (same) | 0 (same) | +Infinity | COMPLETE |

- Chain reconciliation (`getSignaturesForAddress` + `getTransaction` for anything missing): HhkNggVjUJ: 502 successful on-chain signatures in the window, 9 not recorded, **0** of those contained a Pump.fun trade event for the mint; 2NmE3tmK9U: 167 / 2 / **0**. For 244hMYe6AW the last 1,000 signatures did not reach back to the window, so that mint's reconciliation is **inconclusive**.
- Not exercised: in the same run 133 production evaluations were recorded and **none** reached the volume stage — young pump.fun tokens usually have no DexScreener pair yet, so the loop stops at `market_data_unavailable` before volume is read. The provider works; V1 cannot trade on these tokens until liquidity and price also have a native source (separate work).

This is a 5-minute, single-endpoint sample with no disconnect during it; it does not prove completeness.

## Tests

Engine: 442 tests / 60 files pass (368 → 442; 74 new). Python: 242 pass. Build, typecheck (`tsconfig.test.json`) and lint clean; `git diff --check` clean. New tests cover: real SOL buy/sell, non-SOL, failed and unknown-status transactions, log/CPI duplicate, real multi-trade transactions, identity, out-of-order, all window boundaries (`T−120/−119/−60/−59/T`), acceleration cases, disconnect/reconnect/silence/stale/error/malformed/truncated, healthy zero vs unknown, graduation (real `CompleteEvent`), bounded memory, restart, duplicate delivery, live-vs-replay equality, production/shadow/backtest consistency, threshold and hard-risk immutability, and a read-only architecture test (`src/volume` imports no signer/execution/wallet and calls no RPC).

## Limitations

- Pump.fun bonding curve only; after graduation volume is `null` (PumpSwap is a separate phase). A `CompleteEvent` lost inside a coverage gap is handled by `token_state_unproven` (needs a fresh curve trade), not by reconciliation.
- Coverage completeness is **not proven**, only tracked: silent server-side drops that leave the socket healthy are undetectable here. Reconciliation is not implemented.
- After any break, the current window returns after 60 s and acceleration after 120 s.
- The websocket drop detection reads a private web3.js field.
- Only a healthy 5-minute window was observed live; a real reconnect on the public RPC was exercised only by unit tests.
- `+Infinity`/`0` conventions and `T = W − 1` are choices documented above.
- Wash/arbitrage trades on the curve count as volume.
