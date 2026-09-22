# New-Token Ultra Scalper V1 — Frozen Baseline Spec

This is the full specification the project was commissioned against. It is
the FINAL BASELINE: the strategy, risk model, and architecture described
here must not change unless the user explicitly instructs otherwise.

Phase 1 (this initial implementation pass) covers the deterministic
real-time trading engine end-to-end in DRY_RUN mode — sections 1–11 in full,
plus the risk/safety/execution/ledger machinery those depend on. Sections
12–29 (self-learning, AI analyst, backtesting, shadow trading, Telegram,
live execution) are represented only as clean interface seams for now — see
`docs/ARCHITECTURE.md` for exactly what's implemented vs. deferred and why.

---

## 1. Core Objective

Build a fast Solana meme-token ultra-scalping bot focused on newly launched
tokens. The bot must: detect newly launched meme tokens; evaluate initial
liquidity and activity; identify short-term momentum; enter only when
deterministic conditions are satisfied; exit within seconds when
appropriate; protect capital with strict risk controls; learn from
historical trading results; continuously discover patterns; test strategy
improvements; use AI/LLM only as an analysis/research/optimization layer;
minimize AI/API token usage. The bot must NOT depend on an LLM for
real-time trading.

## 2. Final Strategy Parameters (experimental baselines, all configurable)

- Position size: 0.3 SOL
- Token age: 30 seconds – 15 minutes
- MIN_LIQUIDITY = 20 SOL, MIN_VOLUME_1M = 5 SOL, MIN_BUY_SELL_RATIO = 1.5,
  MIN_PRICE_VELOCITY_5S = +1%, MIN_VOLUME_ACCELERATION = 1.5x,
  MAX_PRICE_IMPACT = 1%
- QUICK_TP = +2% to +3%, MOMENTUM_TP = +4% to +6%
- DYNAMIC_SL ≈ -2% to -3%
- MAX_HOLD_TIME = 30 seconds
- MAX_REENTRY_PER_TOKEN = 5
- DAILY_LOSS_LIMIT = 10%

## 3. New Token Focus

Wait for enough liquidity, transactions, volume, buy pressure, price
movement, and market activity before considering a token tradable. Avoid
synthetic/stock tokens, suspicious/unsellable tokens, abnormal liquidity,
dangerous token authorities, honeypot behavior, extreme holder
concentration, and suspicious developer behavior.

## 4. Deterministic Real-Time Trading Engine

Market data, discovery, price/liquidity/volume monitoring, buy/sell
pressure, momentum, entry/exit signals, TP/SL/trailing/timeout/re-entry,
risk controls, circuit breakers, and execution must all be deterministic.
No LLM call per price update/transaction/quote/BUY/SELL/position
update/candle. Trading must continue even when the AI provider is offline.

## 5. Entry Engine

ENTRY SCORE = momentum + volume + buy pressure + transaction velocity +
liquidity quality − slippage risk − price impact risk, against a
configurable minimum. Before every BUY, compute EXPECTED_NET_EDGE
(subtracting DEX fee, swap fee, network fee, priority fee, slippage, price
impact, and a safety margin) — if insufficient, do not buy.

## 6. Safety Gate

Before BUY: sellability, liquidity, liquidity stability, mint authority
risk, freeze authority risk, holder concentration, suspicious supply/dev
behavior, price impact, expected slippage, quote validity, RPC health,
transaction simulation where available, execution route, balance, exposure
limits. Any critical failure blocks the BUY.

## 7. Exit Engine

Quick TP, Momentum TP, Trailing Exit, Momentum Reversal, Dynamic Stop Loss,
Liquidity Deterioration, Max Hold Time, Execution Safety Failure, Emergency
Circuit Breaker. Capital protection is prioritized; never wait for an LLM
response before exiting.

## 8. Re-Entry

Max 5 re-entries per token. Never averaging down — every re-entry
independently passes entry/safety/edge/liquidity/momentum/risk conditions.
Token cooldown, token loss limiter, consecutive-loss protection required.

## 9. Daily Risk Control

10% daily loss limit is a hard circuit breaker: stop new entries once
reached. Existing positions may still be safely managed. The AI must never
override this limit.

## 10. Hard Risk Parameters

0.3 SOL position size, 10% daily loss limit, max 5 re-entries, max total
exposure, max concurrent positions, max slippage, max price impact,
emergency stop, and critical safety gates are never directly modifiable by
the AI — controlled only by deterministic configuration.

## 11. Trade Ledger

Every entry and exit recorded with rich context (timestamps, liquidity,
volume, ratios, velocity, fees, expected edge, entry score, strategy
version, market regime, re-entry number, exit reason, realized PnL, MFE/MAE,
execution latency, actual slippage/impact). Persistent.

## 12–29. Self-Learning, AI Analyst, Overfitting Protection, Shadow Trading,
Telegram, Security, Development Safety, Dry Run, Testing (summary)

The bot must keep learning primarily from its own trading data via local
statistical analysis (win rate, PnL stats, drawdown, performance by
cohort/regime, etc.) computed BEFORE any AI involvement. An LLM is used only
as an optional researcher/analyst/hypothesis-generator with a strict token
budget, caching, change-detection gating (skip AI when nothing meaningful
changed), and minimum sample sizes before proposing changes
(50/100/300 trades for pattern/parameter/validation respectively). Every
strategy is versioned; changes go through backtest → out-of-sample →
shadow trading → a validation gate before ever reaching production, guarding
against look-ahead bias, data leakage, overfitting, survivorship bias, and
parameter chasing. The AI must never say "BUY this token", never trade
directly, never override risk, and never modify hard risk parameters.
Telegram is a control/reporting surface only — no trading logic inside it.
Secrets are never hardcoded, logged, or sent to the AI/Telegram. DRY_RUN
defaults true; live trading requires explicit configuration and is never
activated accidentally.

## 30. Development Safety

Inspect the existing repository and architecture before writing code;
identify existing modules/wallet handling/RPC providers/DEX
integrations/risk controls/tests/conflicts before changing anything. Don't
blindly rewrite the repository, touch unrelated projects, or remove working
functionality without reason.

## 33–34. Implementation Order & AI Behavior

17 phases from repository inspection through controlled live deployment.
The AI should say "Pattern detected" / "Candidate parameter generated" /
"Historical test suggests this candidate should be evaluated" — never
"BUY this token" — and the deterministic validation pipeline alone decides
whether a candidate becomes a production strategy.

## 36. Final Principle

The bot learns primarily from its own data via local statistical analysis;
AI assists with complex pattern interpretation and strategy research but
never controls realtime trading or hard risk, and does not need to run
continuously. Progress flows DATA → ANALYSIS → PATTERN → HYPOTHESIS →
BACKTEST → OOS → SHADOW → VALIDATION → NEW STRATEGY VERSION, while
maintaining fast execution, low AI cost, strict risk, security,
reproducibility, and no uncontrolled strategy changes.
