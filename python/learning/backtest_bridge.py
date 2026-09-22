"""Subprocess bridge to the TypeScript historical replay engine (Phase 3-alt).

Backtesting a candidate must never become "a separate incompatible
implementation" of the fee/risk/exit logic (spec section 14/16) -- this
module runs the ONE real engine (`engine/src/backtest/cli.ts`, built to
`engine/dist/backtest/cli.js`) as a subprocess rather than recomputing any
of that in Python. Python's job here is orchestration only: build the
tunable-override file, invoke node, parse the JSON result back out.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class BacktestBridgeError(RuntimeError):
    """Raised when the TS backtest CLI is missing, exits non-zero, or returns malformed output."""


@dataclass(frozen=True)
class BridgeBacktestResult:
    status: str
    simulator_version: str
    strategy_label: str
    sample_size_snapshots: int
    trades: list[dict[str, Any]]
    data_quality_issues: list[dict[str, Any]]
    notes: str


def default_cli_path() -> Path:
    """engine/dist/backtest/cli.js, resolved relative to this file assuming
    the usual repo layout (python/ and engine/ as sibling directories)."""
    return Path(__file__).resolve().parents[2] / "engine" / "dist" / "backtest" / "cli.js"


def run_ts_backtest(
    db_path: str,
    label: str,
    strategy_version: str | None = None,
    tunable_overrides: dict[str, Any] | None = None,
    node_executable: str = "node",
    cli_path: str | Path | None = None,
    timeout_sec: float = 120.0,
) -> BridgeBacktestResult:
    """`tunable_overrides` may ONLY contain the six tunable groups (discovery,
    filters, scoring, exits, reentry, risk) -- the CLI itself validates and
    refuses anything else (including any hard-risk-parameter-shaped key), so
    this bridge cannot smuggle a hard-parameter change through even given a
    malformed candidate dict.
    """
    resolved_cli = Path(cli_path) if cli_path is not None else default_cli_path()
    if not resolved_cli.exists():
        raise BacktestBridgeError(
            f"TS backtest CLI not found at {resolved_cli}. Build the engine first: "
            "npm run build --workspace=engine (from the repo root)."
        )

    args = [node_executable, str(resolved_cli), "--db", db_path, "--label", label]
    if strategy_version is not None:
        args += ["--strategy-version", strategy_version]

    overrides_path: str | None = None
    try:
        if tunable_overrides:
            fd, overrides_path = tempfile.mkstemp(suffix=".json", prefix="scalp-backtest-overrides-")
            with open(fd, "w", encoding="utf-8") as f:
                json.dump(tunable_overrides, f)
            args += ["--config", overrides_path]

        try:
            proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout_sec)
        except subprocess.TimeoutExpired as exc:
            raise BacktestBridgeError(f"TS backtest CLI timed out after {timeout_sec}s") from exc
        except FileNotFoundError as exc:
            raise BacktestBridgeError(f"Could not launch node executable {node_executable!r}: {exc}") from exc
    finally:
        if overrides_path is not None:
            Path(overrides_path).unlink(missing_ok=True)

    if proc.returncode != 0:
        raise BacktestBridgeError(f"TS backtest CLI failed (exit {proc.returncode}): {proc.stderr.strip()}")

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise BacktestBridgeError(f"TS backtest CLI produced non-JSON stdout: {proc.stdout[:500]!r}") from exc

    try:
        return BridgeBacktestResult(
            status=payload["status"],
            simulator_version=payload["simulatorVersion"],
            strategy_label=payload["strategyLabel"],
            sample_size_snapshots=payload["sampleSizeSnapshots"],
            trades=payload["trades"],
            data_quality_issues=payload["dataQualityIssues"],
            notes=payload["notes"],
        )
    except KeyError as exc:
        raise BacktestBridgeError(f"TS backtest CLI result missing expected field {exc}") from exc
