# scalp-python (Phase 2: analytics + self-learning foundation)

Reads the TypeScript engine's shared `data/ledger.sqlite` (WAL-mode, via
Node's built-in `node:sqlite`) with nothing more than Python's stdlib
`sqlite3` module -- no native extension, no ORM. SQLite remains the single
source of truth for both languages; see `docs/PHASE_2_ARCHITECTURE.md` at
the repo root for the full shared-schema contract (which tables the
TypeScript engine owns vs. which this package owns).

**No AI/LLM integration exists in this package.** `analytics/reports.py`
produces compact JSON summaries specifically so that a future AI analyst
layer never needs raw ledger data -- but no such layer is implemented or
called here.

## What's here

- `analytics/schema_contract.py` -- documented table/column names for
  every shared table (both TS-owned and Python-owned).
- `analytics/reader.py` -- **read-only** access to the TS-owned
  trading-truth tables (`trades`, `token_evaluations`, `daily_risk_state`).
- `analytics/constants.py` -- the finalized minimum sample sizes
  (`MIN_TRADES_FOR_PATTERN`=50, `_PARAMETER_PROPOSAL`=100,
  `_STRATEGY_VALIDATION`=300).
- `analytics/features.py` -- deterministic bucketing of entry conditions
  (token age, liquidity, price velocity, buy/sell ratio, volume
  acceleration, price impact, slippage, entry score).
- `analytics/statistics.py` -- win rate, PnL, median, profit factor, max
  drawdown, hold time, exit-reason frequencies, re-entry performance,
  consecutive losses, and per-bucket breakdowns. Every function is a pure,
  deterministic computation over a list of trade dicts.
- `analytics/patterns.py` -- local pattern discovery. Every result is
  labeled `OBSERVED_CORRELATION` and worded as correlation, never
  causation, and gated by `MIN_TRADES_FOR_PATTERN`.
- `analytics/reports.py` -- compact, fixed-shape JSON summaries (the AI
  token-efficiency seam described above).
- `learning/db.py` -- owns and creates (idempotently) the **Python-owned**
  learning tables (`strategy_versions`, `feature_snapshots`,
  `learning_runs`, `candidate_strategies`, `validation_results`) in the
  SAME shared SQLite file -- never a second database.
- `learning/candidates.py` -- candidate strategy format + hard-parameter
  rejection (position size, daily loss limit, max re-entries, max
  exposure, max concurrent positions, max slippage, max price impact,
  emergency stop are never modifiable by a candidate).
- `learning/validation.py` -- minimum-sample-size gating and a strictly
  chronological train/validation/out-of-sample split with an enforced
  (not just documented) look-ahead-bias check.
- `learning/backtest.py` -- backtesting foundation; refuses to fabricate a
  result when historical data is insufficient rather than inventing one.
- `learning/shadow.py` -- shadow-strategy foundation; pure computation
  over already-hypothetical trades, no execution capability of any kind.
- `learning/learner.py` -- orchestrates ledger → statistics → pattern
  discovery → candidate generation. Never modifies production
  parameters; every candidate it produces starts at `status='pending'`.
- `scripts/inspect_ledger.py` -- CLI trade-summary printout.

## Usage

```bash
python scripts/inspect_ledger.py ../data/ledger.sqlite
python -c "from learning.learner import run_learning_cycle; print(run_learning_cycle('../data/ledger.sqlite'))"
```

## Tests

```bash
pip install -e ".[dev]"
pytest   # 99 tests
```
