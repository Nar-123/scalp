# New-Token Ultra Scalper V1

A Solana meme-token scalping bot: a deterministic real-time trading engine
(this phase) that will grow a local-analytics-first self-learning layer, an
optional AI research assistant, and eventually controlled live execution.
See `docs/SPEC.md` for the full frozen specification and
`docs/ARCHITECTURE.md` for what this pass actually built, what's verified
against live mainnet data, and what's deferred.

**This phase runs in `DRY_RUN` mode only.** No wallet key exists anywhere in
this codebase; no transaction is ever built or sent. Simulated fills are
computed from real, live market data (Jupiter quotes, DexScreener), so you
can watch the engine evaluate genuinely new tokens end-to-end with zero
funds at risk.

## Prerequisites

- Node.js **>= 22.5.0** (this project uses the built-in `node:sqlite` module
  specifically to avoid requiring a native C++ build toolchain like Visual
  Studio Build Tools just to install dependencies on Windows)
- Python **>= 3.10** (only needed for the `analytics/` placeholder package)

## Setup

```bash
npm install
cp .env.example engine/.env
```

Edit `engine/.env` if you want a better RPC endpoint than the public
default (recommended — the public endpoint is rate-limited and unreliable
for the log subscriptions this bot relies on for discovery). A free-tier
Helius/QuickNode/Triton URL is enough; no paid tier or wallet needed for
DRY_RUN.

## Running

```bash
npm run build --workspace=engine
npm run start --workspace=engine
```

or for development (auto-reload on change):

```bash
npm run dev --workspace=engine
```

You'll see structured logs as it subscribes to live Raydium/pump.fun
program logs, evaluates real newly-launched tokens against the baseline
filters and safety gate, scores them, and (for any that pass every gate)
records a simulated fill in `data/ledger.sqlite`. Stop with Ctrl+C.

Inspect what it recorded from Python:

```bash
python analytics/scripts/inspect_ledger.py
```

## Testing

```bash
npm run test --workspace=engine       # 147 unit tests, no network required
npm run typecheck --workspace=engine
npm run lint --workspace=engine
```

## Configuration

All strategy parameters are configurable via environment variables or by
editing `engine/src/config/schema.ts`'s defaults — see `.env.example` for
the commonly-tuned ones. The **hard risk parameters** (position size, daily
loss limit, max re-entries, max exposure, max concurrent positions, max
slippage/price-impact, emergency stop) are intentionally NOT
environment-configurable — see `engine/src/config/hardRisk.ts` and
`docs/ARCHITECTURE.md`'s "hard-risk isolation boundary" section for why.

## Project layout

```
engine/       TypeScript realtime trading engine (this phase's main output)
analytics/    Python — placeholder proving the shared SQLite ledger contract
data/         ledger.sqlite lives here at runtime (gitignored)
docs/         SPEC.md (frozen spec) and ARCHITECTURE.md (what's built)
```
