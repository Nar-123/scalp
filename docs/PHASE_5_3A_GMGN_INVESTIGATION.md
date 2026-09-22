# Phase 5.3A — GMGN as a 1-minute volume source (investigation)

**Status: investigation stopped before live verification. Documentation
exposes candidate 1-minute fields, but their window semantics and (for kline)
their units are not established, and no read-only API key was available, so
nothing could be verified against real data. No code was changed.**

Sources read (raw text, not summaries):
`docs.gmgn.ai/index/gmgn-agent-api` (high level only),
`docs.gmgn.ai/index/llms.txt` (page index), and the official `GMGNAI/gmgn-skills`
repository: `skills/gmgn-market/SKILL.md`, `skills/gmgn-token/SKILL.md`,
`docs/cli-usage.md`, `Readme.md`. `gmgn.ai/ai` returned HTTP 403 to automated
fetch.

## What the official docs say

| Item | Documented value |
|---|---|
| Token snapshot | `GET /v1/token/info` (weight 1) |
| 1m fields in it | `price.volume_1m`, `price.buy_volume_1m`, `price.sell_volume_1m` (all "in USD"), `price.buys_1m`, `price.sells_1m`, `price.swaps_1m` (counts), `price.price_1m` ("price at the start of the window"). Same set for 5m / 1h / 6h / 24h. |
| Candles | `GET /v1/market/token_kline`, `resolution` ∈ 1s (Pro) / 30s / 1m / 5m / 15m / 1h / 4h / 1d, `from` / `to` Unix **seconds**, `chain` = `sol`, `address` = mint |
| Kline response | `{ "list": [ { time, open, close, high, low, volume, amount } ] }`, `time` = candle **open** time in seconds, oldest first, prices in USD |
| Chain / token id | `sol`; token contract address (mint) |
| Auth | API key only for read-only routes ("no signature"); `GMGN_PRIVATE_KEY` is only for trading. Keys are created by the user at gmgn.ai/ai; IPv4 only; IP whitelist applies to some capabilities (`AUTH_IP_BLOCKED` 403 exists). |
| Rate limit | Leaky bucket, plan based: Free 5/5, Plus 20/20, Pro 50/50 (rate/capacity). Weights: `token info` 1, `token kline` 2. 429 carries `X-RateLimit-Reset`; `RATE_LIMIT_BANNED` lasts up to 5 minutes and extends by 5 s per retry during the cooldown. |
| Base URL / host | **Not documented** in any page read. |
| Response latency / freshness | **Not documented.** |

## Why this is not yet usable for V1

1. **Kline units are contradicted inside the official docs.** In
   `gmgn-market/SKILL.md`, "Core Concepts" says *`volume` = USD, `amount` = token
   units*, while "Response Fields" says *`volume` = base token units, `amount` =
   USD*. Under the rule UNKNOWN UNIT = UNAVAILABLE, kline volume is unusable
   until an empirical check settles it (`amount ≈ volume × close` identifies
   which is USD).
2. **`price.volume_1m` has an unstated window.** "Total trading volume in USD for
   the window" does not say whether the window is the trailing 60 seconds ending
   at the request time or an aligned wall-clock minute, and the documented
   response has no snapshot timestamp. V1 needs a known window (requirement B)
   and freshness (D). Kline is aligned (open time is documented) but its unit is
   ambiguous (point 1) and the current, still-forming candle's semantics are not
   documented.
3. **Nothing here is SOL.** Every documented volume is USD (or token units).
   V1's threshold is 5 SOL, so a USD→SOL conversion with an independent SOL/USD
   reference would be required; GMGN's documented token fields do not include
   one, and the Phase 5.2 reference (`priceUsd / priceNative` from DexScreener)
   would come from a different source and moment. That is workable but must be
   explicit and timestamp-checked, not implicit.
4. **Endpoint host, latency, error behaviour and freshness are unknown**, and
   could not be measured: no API key exists for this project, creating one is a
   step for the account owner (it must be created at gmgn.ai/ai), and I will
   not guess a host or use an undocumented/private route.

Acceleration: if `price.volume_1m` (or aligned 1m candles) turned out to be
valid, `volumeAccelerationX = current_1m / previous_1m` can be computed locally
from two 1m values in the same unit; GMGN's own change/momentum fields
(`change1m`, hot level) were **not** used and have not been shown to match V1's
definition.

## Not done (needs a read-only key)

No real-token fetch, no comparison against the GMGN web page, and no latency
(average / p50 / p95), failure, HTTP-error or rate-limit measurements. None of
these numbers exist; none are claimed.

## Security notes

- No GMGN credential was used, requested, stored or printed. A file
  `~/.config/gmgn/keypair.pem` exists on this machine (outside the repo). It was
  listed by name only, **not opened or used**. `GMGN_API_KEY` is not set. Never
  point this project at `GMGN_PRIVATE_KEY`; read-only market data needs only an
  API key with no trading capability.
- No fixtures were added (there is no real response to sanitize).

## Verification plan once the owner supplies a read-only API key

Run with the official CLI (read-only commands only), IPv4, a low request rate
(Free plan = 5 requests/s burst; keep well below):

1. `gmgn-cli token info --chain sol --address <active mint>` ×30 at ~1 s spacing:
   record `price.volume_1m`, `buys_1m`, `sells_1m`, `price.price`, wall-clock
   request times. If `volume_1m` changes smoothly every second it is a trailing
   window; if it steps once per minute it is aligned. Record request latency.
2. `gmgn-cli market kline --resolution 1m` for the same mint over the last ~10
   minutes: check `amount ≈ volume × close` to fix the unit; compare the last
   *closed* candle against the web page's 1m bar; note whether the forming
   candle appears.
3. Compare 1 and 2: the closed-candle USD volume must equal the value
   `token info` reported for that minute (within trade-arrival lag).
4. Accept GMGN only if (A) genuine 1m data, (B) a known window, (C) a known unit,
   (D) freshness within a few seconds, (E) one definition used consistently.

## Recommendation

1. If the owner is willing: complete the plan above with a read-only key. It is
   cheap, and answers B–D directly.
2. Independently of GMGN, the only source that is natively SOL-denominated, has
   an exact and self-chosen window, and needs no USD conversion is **trade-level
   data from chain events** (for pump.fun tokens the trade event carries the SOL
   amount; the project already decodes that program). It is more work (a
   `OneMinuteVolumeProvider` fed by trade events) but removes the unit, window
   and freshness ambiguities entirely. This has not been prototyped or verified
   here.
3. Whatever the source, expose it only through a `OneMinuteVolumeProvider`
   returning `volume1mSol: number | null` (with its window end timestamp), keep
   provider-specific parsing isolated, and fail closed to `null` →
   `volume_1m_unavailable` on any timeout, error, stale sample or unknown unit.
   Production, shadow, backtest and Python should read only that normalized
   field. The V1 thresholds stay unchanged.

---

# Phase 5.3B — GMGN empirical validation (read-only)

**Result: `GMGN_NOT_VERIFIED`.** No provider or integration code was created.
Method: official `gmgn-cli` 1.6.2 only, API-key-only credentials in an isolated
HOME (no `GMGN_PRIVATE_KEY`, no wallet, no trading), IPv4, ~1 request/s, one
token (a trending SOL-quoted token), ~2 minutes of `token info` + two `market
kline` calls. Nothing was scraped; no undocumented endpoint was used.

## Findings

- `token info` `price.volume_1m` exists, is USD per docs, and behaves as a
  **rolling window**: it changed on 69 of 69 consecutive samples, never reset at
  the minute boundary, and its buy+sell parts sum to the total and buys+sells
  equals swaps on all 70 samples. Trade counts decrease between samples (trades
  leaving the window). The response has **no timestamp**, so the window end and
  the freshness are unknown.
- `market kline` (1m): 10 closed candles + the forming one. `time` is the candle
  open time in **milliseconds** (docs say seconds). Fields: time, open, close,
  high, low, volume, amount, plus an undocumented `source`. No trade count.
  `amount × close ≈ volume` (ratio 0.91–1.09) on every candle, so by numerical
  consistency `volume` is USD and `amount` is token units (matches the "Core
  Concepts" text, contradicts the "Response Fields" text). The forming candle
  revised strongly (19.6k → 43.8k) so only closed candles are usable.
- Rolling `volume_1m` vs the just-closed candle around three minute boundaries:
  differences of −8 % … +10 % (one sample within 0.3 %). The two are different
  quantities; the server-side evaluation instant of a rolling sample is unknown
  (request latency 0.9–1.2 s normally, with 8.8 s and 11.4 s outliers), so they
  cannot be reconciled.
- Latency (CLI wall time incl. ~1 s process start): sequential samples median
  ≈ 0.9 s, max 11.4 s; concurrent run p50 1.0 s, p95 3.5 s, max 4.2 s; one
  kline call took 13 s, another 2 s. No HTTP errors, timeouts or rate limits
  were observed (~85 requests).
- Unit: USD. SOL conversion would need an independent, timestamp-compatible
  SOL/USD reference; none is provided by these endpoints (only the SOL-quoted
  pool metadata), and DexScreener's reference was not auto-adopted.
- Web-UI comparison: **not performed** (no scraping; no independent visual
  check was made).

## Acceptance criteria

| Criterion | Result |
|---|---|
| Genuine 1m volume | yes (rolling `volume_1m`; closed 1m candles) |
| Provable unit | USD, by consistency + docs (not SOL) |
| Known window | **no** — rolling window end unknown; candles aligned but stale by up to 60 s |
| Known timestamp semantics | **no** for `token info` (no timestamp) |
| Acceptable freshness | **unknown / not demonstrated** (latency outliers up to 11–13 s) |
| Current + previous consistent | **no** — rolling vs candle disagree up to ~10 % |
| No undocumented endpoint | yes |
| No scraping | yes |
| Failure maps safely to NULL | yes (by design) |
| Normalizable to `volume1mSol` without unjustified assumptions | **no** — needs an unverified USD→SOL reference |

Recommendation: `GMGN_NOT_VERIFIED`. `volume1mSol` stays `null` →
`volume_1m_unavailable`. V1 thresholds untouched. Native SOL trade-event
volume (see 5.3A recommendation 2) remains the cleaner path.
