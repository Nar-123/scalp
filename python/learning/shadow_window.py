"""Same-window BACKTEST vs SHADOW comparison for the live read-only shadow run
(Phase 5.1).

Data sources (all read from the ONE shared ledger file, read-only here):
  * shadow_trades / shadow_* tables  -- what the live shadow runner did
  * token_evaluations                -- the live loop's own evaluation log for
                                        the same ticks (the backtest's input)
  * the TypeScript replay engine (via learning.backtest_bridge) replays that
    log with the same V1 parameters, risk rules and fee assumptions

Nothing here claims profitability. Every section is labelled OBSERVED /
CALCULATED / ASSUMED / HYPOTHESIS, and differences are explained, never
forced to match.
"""

from __future__ import annotations

import json
from typing import Any

from analytics.reader import open_ledger_readonly
from .backtest_bridge import run_ts_backtest
from .shadow import compare_backtest_vs_shadow


def _normalize_backtest_trades(bridge_trades: list[dict], start_ms: int, end_ms: int) -> list[dict]:
    out = []
    for t in bridge_trades:
        if t.get("status") != "closed":
            continue
        if not (start_ms <= t["entryTimeMs"] <= end_ms):
            continue
        out.append(
            {
                "entry_time_ms": t["entryTimeMs"], "exit_time_ms": t["exitTimeMs"], "pnl_sol": t["pnlSol"],
                "pnl_pct": t["pnlPct"], "exit_reason": t["exitReason"], "hold_duration_ms": t["holdDurationMs"],
                "entry_fees_sol": t["entryFeesSol"], "exit_fees_sol": t["exitFeesSol"], "mint": t["mint"],
            }
        )
    out.sort(key=lambda r: r["entry_time_ms"])
    return out


def _exit_reason_counts(trades: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in trades:
        counts[t.get("exit_reason") or "unknown"] = counts.get(t.get("exit_reason") or "unknown", 0) + 1
    return counts


def _scalar(conn, sql: str, params: tuple = ()) -> Any:
    row = conn.execute(sql, params).fetchone()
    return row[0] if row else None


def shadow_window_bounds(conn, strategy_version: str) -> tuple[int, int] | None:
    """Window = first..last shadow tick actually observed (latency samples are
    written for every tick, including rejected ones)."""
    row = conn.execute("SELECT MIN(observed_at_ms), MAX(observed_at_ms) FROM shadow_latency_samples").fetchone()
    if not row or row[0] is None:
        return None
    return int(row[0]), int(row[1])


def build_window_comparison(
    db_path: str,
    strategy_version: str,
    backtest_result: Any | None = None,
    node_executable: str = "node",
    cli_path: str | None = None,
) -> dict:
    """Runs (or accepts) a backtest of the same strategy version over the same
    ledger, restricts BOTH sides to the shadow window, and reports differences
    with evidence. `backtest_result` can be injected (tests / precomputed)."""
    with open_ledger_readonly(db_path) as conn:
        bounds = shadow_window_bounds(conn, strategy_version)
        if bounds is None:
            return {"status": "insufficient_data", "note": "No shadow ticks were recorded, so there is no window to compare."}
        start_ms, end_ms = bounds

        shadow_trades = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM shadow_trades WHERE strategy_version = ? AND status = 'closed' AND entry_time_ms BETWEEN ? AND ? ORDER BY entry_time_ms",
                (strategy_version, start_ms, end_ms),
            ).fetchall()
        ]
        shadow_open = _scalar(conn, "SELECT COUNT(*) FROM shadow_trades WHERE strategy_version = ? AND status = 'open'", (strategy_version,))
        evaluations = _scalar(
            conn, "SELECT COUNT(*) FROM token_evaluations WHERE strategy_version = ? AND evaluated_at_ms BETWEEN ? AND ?", (strategy_version, start_ms, end_ms)
        )
        evals_with_price = _scalar(
            conn,
            "SELECT COUNT(*) FROM token_evaluations WHERE strategy_version = ? AND evaluated_at_ms BETWEEN ? AND ? AND price_sol IS NOT NULL",
            (strategy_version, start_ms, end_ms),
        )
        counters = {r["name"]: r["value"] for r in conn.execute("SELECT name, value FROM shadow_health_counters").fetchall()}
        dq = {r["kind"] + ":" + r["severity"]: r["n"] for r in conn.execute(
            "SELECT kind, severity, COUNT(*) AS n FROM shadow_data_quality_events WHERE observed_at_ms BETWEEN ? AND ? GROUP BY kind, severity", (start_ms, end_ms)).fetchall()}
        missed = {r["reason"]: r["n"] for r in conn.execute(
            "SELECT reason, COUNT(*) AS n FROM shadow_missed_signals WHERE strategy_version = ? AND observed_at_ms BETWEEN ? AND ? GROUP BY reason", (strategy_version, start_ms, end_ms)).fetchall()}
        lat = conn.execute(
            """SELECT COUNT(*) n, AVG(discovery_latency_ms) discovery, AVG(market_data_latency_ms) market_data, AVG(quote_latency_ms) quote,
                      AVG(processing_latency_ms) processing, AVG(shadow_processing_latency_ms) shadow_processing
               FROM shadow_latency_samples WHERE observed_at_ms BETWEEN ? AND ?""",
            (start_ms, end_ms),
        ).fetchone()
        entry_quotes = _scalar(conn, "SELECT COUNT(*) FROM shadow_trades WHERE strategy_version = ? AND entry_quote_json IS NOT NULL", (strategy_version,))

    if backtest_result is None:
        backtest_result = run_ts_backtest(db_path, label=f"{strategy_version}-same-window", strategy_version=strategy_version,
                                          node_executable=node_executable, cli_path=cli_path)
    backtest_all = [t for t in backtest_result.trades]
    backtest_trades = _normalize_backtest_trades(backtest_all, start_ms, end_ms)
    backtest_open = sum(1 for t in backtest_all if t.get("status") != "closed" and start_ms <= t["entryTimeMs"] <= end_ms)

    comparison = compare_backtest_vs_shadow(backtest_trades, shadow_trades)
    bt_reasons, sh_reasons = _exit_reason_counts(backtest_trades), _exit_reason_counts(shadow_trades)

    ticks = counters.get("shadow_ticks_received", 0)
    rejected_dq = counters.get("shadow_ticks_rejected_data_quality", 0)
    analysis: list[dict] = []

    def add(category: str, label: str, statement: str, evidence: dict) -> None:
        analysis.append({"category": category, "label": label, "statement": statement, "evidence": evidence})

    add("data availability", "OBSERVED",
        f"{evals_with_price} of {evaluations} logged evaluations in the window had a price; shadow counted {counters.get('missing_market_data', 0)} ticks with missing market data.",
        {"evaluations": evaluations, "evaluations_with_price": evals_with_price, "missing_market_data": counters.get("missing_market_data", 0)})
    if abs((ticks or 0) - (evaluations or 0)) > 0:
        add("timing", "OBSERVED",
            f"Shadow received {ticks} ticks vs {evaluations} logged evaluations in the window; the counts are taken at slightly different moments (counter vs row) and the window is bounded by shadow's own first/last tick.",
            {"shadow_ticks": ticks, "logged_evaluations": evaluations})
    if rejected_dq:
        add("stale/out-of-order data", "OBSERVED", f"{rejected_dq} ticks were rejected/blocked by data-quality rules in shadow; the backtest replays every logged row and applies no such rejection.", {"rejected": rejected_dq, "by_kind": dq})
    if counters.get("quote_error", 0) or counters.get("quote_success", 0):
        add("quote difference", "OBSERVED",
            f"Shadow observed {counters.get('quote_success', 0)} successful and {counters.get('quote_error', 0)} failed read-only quote requests; a failed quote falls back to the ASSUMED impact in both engines.",
            {"quote_success": counters.get("quote_success", 0), "quote_error": counters.get("quote_error", 0)})
    if counters.get("rpc_error", 0) or counters.get("aggregator_error", 0):
        add("RPC/aggregator failure", "OBSERVED", "Upstream errors occurred during the live window; failed ticks yield no signal in shadow but the backtest only sees rows that were logged.",
            {"rpc_error": counters.get("rpc_error", 0), "aggregator_error": counters.get("aggregator_error", 0)})
    add("fill-model assumptions", "ASSUMED",
        "Both engines use the same simulateFill formula, fee schedule and latency-slippage buffer, so fill-model differences should be small; assumed execution latency is NOT the measured system latency reported here.",
        {"observed_latency_ms": dict(lat) if lat else {}})
    if len(shadow_trades) != len(backtest_trades):
        add("timing / exit timing", "HYPOTHESIS",
            "Different trade counts likely reflect entry/exit evaluated on live ticks vs the ~2s log (and shadow's data-quality gating, safety verdict availability and persisted risk state), not a defect in either engine.",
            {"shadow_closed": len(shadow_trades), "backtest_closed": len(backtest_trades)})
    if missed:
        add("risk/exposure", "OBSERVED", "Valid signals blocked by risk rules in shadow (missed signals) also exist as decisions in the backtest's replay, so counts can differ by design.", {"missed_by_reason": missed})
    add("token discovery difference", "HYPOTHESIS",
        "Backtest replays tokens that produced evaluation rows in the production loop; shadow sees exactly the same stream, so discovery differences are not expected. Any gap would come from rows written after shadow's first/last tick.", {})
    add("liquidity change / latency", "HYPOTHESIS", "Live price and liquidity move between the moment a tick is observed and any real fill; neither engine measures that, and observed system latency does not substitute for it.", {})

    return {
        "status": "completed",
        "window": {"start_ms": start_ms, "end_ms": end_ms, "duration_hours": (end_ms - start_ms) / 3_600_000},
        "labels": comparison["labels"],
        "opportunities": {"logged_evaluations": evaluations, "shadow_ticks_received": ticks, "shadow_ticks_rejected_data_quality": rejected_dq},
        "entries": {"shadow_closed": len(shadow_trades), "shadow_open": shadow_open, "backtest_closed": len(backtest_trades), "backtest_open": backtest_open},
        "exit_reasons": {"shadow": sh_reasons, "backtest": bt_reasons},
        "backtest": comparison["backtest"],
        "shadow": comparison["shadow"],
        "differences": comparison["differences"],
        "data_quality": dq,
        "missed_signals": missed,
        "quotes": {"shadow_entries_with_quote": entry_quotes, "quote_success": counters.get("quote_success", 0), "quote_error": counters.get("quote_error", 0)},
        "observed_system_latency_ms": dict(lat) if lat else {},
        "assumed_execution": "fees + impact + latency-slippage buffer from simulateFill (ASSUMED, not measured)",
        "difference_analysis": analysis,
        "note": "SHADOW != LIVE TRADING. Simulated PnL under configured assumptions over a short window is not evidence of profitability.",
    }


def dumps(report: dict) -> str:
    return json.dumps(report, indent=2, default=str)
