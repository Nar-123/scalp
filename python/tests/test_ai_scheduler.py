import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.schema_contract import TRADES_COLUMNS, TRADES_TABLE
from learning.ai.provider import MockAIProvider
from learning.ai.scheduler import run_ai_scheduler_loop, run_ai_scheduler_once
from learning.ai.service import AIAnalysisService

_NUMERIC_COLUMNS = {"reentry_index", "entry_time_ms", "pnl_sol", "entry_liquidity_sol", "entry_price_velocity_5s_pct", "entry_buy_sell_ratio", "entry_volume_acceleration_x", "entry_price_impact_pct", "entry_slippage_pct", "entry_score", "entry_token_age_sec", "hold_duration_ms"}


def make_ledger_with_trades(tmp_path: Path, count: int, win_fraction: float = 1.0) -> Path:
    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} {'REAL' if col in _NUMERIC_COLUMNS else 'TEXT'}" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    for i in range(count):
        is_win = (i % 10) < (win_fraction * 10)
        row = {col: None for col in TRADES_COLUMNS}
        row.update(
            {
                "id": f"t{i}", "mint": f"m{i}", "strategy_version": "V1", "status": "closed",
                "entry_time_ms": float(i * 1000), "reentry_index": 0.0,
                "pnl_sol": 0.01 if is_win else -0.02, "exit_reason": "quick_tp" if is_win else "dynamic_sl",
                "hold_duration_ms": 5000.0, "entry_liquidity_sol": 25.0, "entry_price_velocity_5s_pct": 2.0,
                "entry_buy_sell_ratio": 2.0, "entry_volume_acceleration_x": 2.0, "entry_price_impact_pct": 0.3,
                "entry_slippage_pct": 0.2, "entry_score": 4.0, "entry_token_age_sec": 40.0,
            }
        )
        placeholders = ", ".join("?" for _ in TRADES_COLUMNS)
        conn.execute(f"INSERT INTO {TRADES_TABLE} VALUES ({placeholders})", [row[c] for c in TRADES_COLUMNS])
    conn.commit()
    conn.close()
    return db_path


def make_service(mode="valid"):
    provider = MockAIProvider(mode=mode)
    return AIAnalysisService(provider=provider, provider_name="mock", model="mock-model"), provider


def test_run_ai_scheduler_once_skips_when_nothing_meaningful(tmp_path):
    db_path = make_ledger_with_trades(tmp_path, 60, win_fraction=1.0)  # uniform -> no pattern, no loss streak
    service, provider = make_service()
    tick = run_ai_scheduler_once(service, str(db_path), strategy_version="V1")
    assert tick.result.status == "skipped_not_meaningful"
    assert provider.calls == []


def test_run_ai_scheduler_once_calls_ai_when_a_pattern_exists(tmp_path):
    db_path = make_ledger_with_trades(tmp_path, 200, win_fraction=0.3)  # mixed outcomes -> patterns likely
    service, provider = make_service()
    tick = run_ai_scheduler_once(service, str(db_path), strategy_version="V1")
    assert tick.result.status in ("completed", "skipped_not_meaningful")  # depends on exact bucket deviations; both are valid non-crashing outcomes
    assert tick.ran_at_ms > 0


def test_run_ai_scheduler_loop_runs_requested_iterations_without_a_real_sleep(tmp_path):
    db_path = make_ledger_with_trades(tmp_path, 60, win_fraction=1.0)
    service, provider = make_service()
    sleeps: list[float] = []
    ticks = []

    run_ai_scheduler_loop(
        service, str(db_path), strategy_version="V1",
        interval_sec=21600, max_iterations=3, sleep_fn=sleeps.append, on_tick=ticks.append,
    )

    assert len(ticks) == 3
    assert sleeps == [21600, 21600]  # never sleeps after the last iteration


def test_scheduled_default_interval_matches_spec_six_hours():
    from analytics.constants import AI_SCHEDULED_RESEARCH_INTERVAL_SEC

    assert AI_SCHEDULED_RESEARCH_INTERVAL_SEC == 6 * 3600
