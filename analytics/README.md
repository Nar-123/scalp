# scalp-analytics (Phase 1 placeholder)

This package is deliberately minimal in this pass. Its only job is to prove
the shared-ledger contract: the TypeScript engine writes `data/ledger.sqlite`
(WAL-mode, via Node's built-in `node:sqlite`) and this package reads it back
with nothing more than Python's stdlib `sqlite3` module -- no native
extension, no ORM, no schema translation layer needed.

## What's here

- `analytics/schema_contract.py` -- table/column name constants mirroring
  `engine/src/ledger/migrations/001_init.ts`, kept in sync by hand for now.
- `analytics/ledger_reader.py` -- read-only helpers for opening the ledger
  and pulling basic trade/evaluation rows and daily risk state.
- `scripts/inspect_ledger.py` -- a CLI that prints a quick summary (trade
  count, win rate, total PnL) so you can confirm the engine's DRY_RUN output
  is readable from the Python side.

## What's NOT here (future passes)

Local statistical analysis (win rate by cohort, profit factor, drawdown),
pattern discovery, candidate-parameter generation, backtesting, out-of-sample
validation, shadow trading, and the AI analyst integration. See
`docs/ARCHITECTURE.md` at the repo root for the full roadmap.

## Usage

```bash
python scripts/inspect_ledger.py ../data/ledger.sqlite
```

## Tests

```bash
pip install -e ".[dev]"
pytest
```
