# New-Token Ultra Scalper V1

A Solana meme-token scalping bot: a deterministic real-time trading engine,
a Python local-analytics + self-learning foundation, and (as of Phase 2)
secure wallet-signing infrastructure — none of it wired up for live
trading yet. See `docs/SPEC.md` for the full frozen specification and
`docs/ARCHITECTURE.md` / `docs/PHASE_1_1_DISCOVERY_VALIDATION.md` /
`docs/PHASE_1_1_1_RAYDIUM_HARDENING.md` / `docs/PHASE_2_ARCHITECTURE.md` for
what each pass actually built, what's verified against live mainnet data,
and what's deferred.

**This project runs in `DRY_RUN` mode only.** No transaction is ever built
or sent. Simulated fills are computed from real, live market data (Jupiter
quotes, DexScreener), so you can watch the engine evaluate genuinely new
tokens end-to-end with zero funds at risk. A real wallet-signing
implementation exists (`engine/src/execution/signer/`) but is not
connected to the orchestrator — see `docs/PHASE_2_ARCHITECTURE.md`'s
"DRY_RUN protection" section for the three independent layers that keep it
that way.

## Discovery status

| Path | Status |
|---|---|
| pump.fun | **Live validated** against a real mainnet token creation |
| Raydium AMM V4 | Implemented and hardened; **live validation pending** |
| Raydium CPMM / CLMM / StableSwap | **Not supported** (different programs, not decoded) |

## Prerequisites

- Node.js **>= 22.5.0** (this project uses the built-in `node:sqlite` module
  specifically to avoid requiring a native C++ build toolchain like Visual
  Studio Build Tools just to install dependencies on Windows)
- Python **>= 3.10** (for the `python/analytics` + `python/learning` packages)

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
python python/scripts/inspect_ledger.py
```

Run a local learning cycle (pattern discovery + candidate proposals; does
nothing to production config):

```bash
python -c "from learning.learner import run_learning_cycle; print(run_learning_cycle('data/ledger.sqlite', strategy_version='baseline-v1'))"
```

## Testing

```bash
npm run test --workspace=engine       # 216 unit tests, no network required
npm run typecheck --workspace=engine
npm run lint --workspace=engine

cd python && python -m pytest         # 99 unit tests, no network required
```

## Configuration

All strategy parameters are configurable via environment variables or by
editing `engine/src/config/schema.ts`'s defaults — see `.env.example` for
the commonly-tuned ones. The **hard risk parameters** (position size, daily
loss limit, max re-entries, max exposure, max concurrent positions, max
slippage/price-impact, emergency stop) are intentionally NOT
environment-configurable — see `engine/src/config/hardRisk.ts` and
`docs/ARCHITECTURE.md`'s "hard-risk isolation boundary" section for why.
The same protection extends to the Python learning package: see
`docs/PHASE_2_ARCHITECTURE.md`'s "hard parameter protection" section.

## Project layout

```
engine/       TypeScript realtime trading engine + wallet-signing infrastructure
python/       Python local analytics + self-learning foundation (no AI/LLM yet)
data/         ledger.sqlite lives here at runtime (gitignored) -- the ONE
              shared database both sides read/write, per table ownership
docs/         SPEC.md (frozen spec) + one doc per implementation phase
```
