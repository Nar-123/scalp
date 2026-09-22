import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.ai.provider import MockAIProvider
from learning.ai.service import AIAnalysisService, detect_meaningful_change
from learning.db import open_learning_db


def make_bare_ledger(tmp_path: Path) -> Path:
    from analytics.schema_contract import TRADES_COLUMNS, TRADES_TABLE

    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} TEXT" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    conn.commit()
    conn.close()
    return db_path


def make_trades(count: int, win_pnl=0.01, loss_pnl=-0.02, win_fraction=0.6, liquidity=25.0) -> list[dict]:
    trades = []
    for i in range(count):
        is_win = (i % 10) < (win_fraction * 10)
        trades.append(
            {
                "pnl_sol": win_pnl if is_win else loss_pnl,
                "entry_time_ms": i * 1000,
                "hold_duration_ms": 5000,
                "exit_reason": "quick_tp" if is_win else "dynamic_sl",
                "reentry_index": 0,
                "entry_liquidity_sol": liquidity,
                "entry_price_velocity_5s_pct": 2.0,
                "entry_buy_sell_ratio": 2.0,
                "entry_volume_acceleration_x": 2.0,
                "entry_price_impact_pct": 0.3,
                "entry_slippage_pct": 0.2,
                "entry_score": 4.0,
                "entry_token_age_sec": 40.0,
            }
        )
    return trades


def make_service(mode="valid", overrides=None) -> tuple[AIAnalysisService, MockAIProvider]:
    provider = MockAIProvider(mode=mode, response_overrides=overrides or {})
    return AIAnalysisService(provider=provider, provider_name="mock", model="mock-model"), provider


class TestSampleSizeGate:
    def test_insufficient_data_never_calls_the_provider(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, make_trades(10), "V1", "p", "p", "manual", force=True)
        assert result.status == "insufficient_data"
        assert provider.calls == []


class TestMeaningfulChangeGate:
    def test_skips_ai_when_nothing_meaningful_and_not_forced(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        # Uniform trades -> no pattern deviation, no loss streak, no previous win rate to compare against.
        trades = make_trades(60, win_fraction=1.0)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p", "p", "manual", force=False)
        assert result.status == "skipped_not_meaningful"
        assert provider.calls == []

    def test_force_bypasses_the_meaningful_change_gate(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(60, win_fraction=1.0)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p", "p", "manual", force=True)
        assert result.status == "completed"
        assert len(provider.calls) == 1

    def test_a_repeated_loss_streak_is_detected_as_meaningful(self):
        class FakeStats:
            max_consecutive_losses = 5
            win_rate = 0.5
        meaningful, reason = detect_meaningful_change([], FakeStats())
        assert meaningful is True
        assert reason == "repeated_loss_pattern"

    def test_a_win_rate_shift_since_the_previous_analysis_is_detected_as_meaningful(self):
        class FakeStats:
            max_consecutive_losses = 0
            win_rate = 0.7
        meaningful, reason = detect_meaningful_change([], FakeStats(), previous_win_rate=0.5)
        assert meaningful is True
        assert reason == "meaningful_performance_change"


class TestSuccessfulAnalysis:
    def test_completed_analysis_creates_a_pending_ai_origin_candidate(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(overrides={"candidate_parameters": [{"parameter": "min_liquidity", "proposed_value": 25}]})
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            assert result.status == "completed"
            assert len(result.candidates_created) == 1

            row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", (result.candidates_created[0],)).fetchone()
            assert row["status"] == "pending"  # spec task 27: never automatically promoted, regardless of AI confidence
            assert row["origin"] == "ai_analyst"
            assert json.loads(row["changes_json"]) == {"min_liquidity": 25}

    def test_high_confidence_from_the_ai_does_not_change_the_pending_status(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(overrides={
            "confidence": "high",
            "candidate_parameters": [{"parameter": "min_liquidity", "proposed_value": 25}],
        })
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", (result.candidates_created[0],)).fetchone()
            assert row["status"] == "pending"

    def test_persists_the_analysis_row(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            row = conn.execute("SELECT * FROM ai_analyses WHERE analysis_id = ?", (result.analysis_id,)).fetchone()
            assert row["status"] == "completed"
            assert row["strategy_version"] == "V1"
            assert row["sample_size"] == 150

    def test_records_a_successful_usage_row_with_token_counts(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            usage_rows = conn.execute("SELECT * FROM ai_usage_log").fetchall()
            assert len(usage_rows) == 1
            assert usage_rows[0]["success"] == 1
            assert usage_rows[0]["input_tokens"] > 0
            assert usage_rows[0]["cache_hit"] == 0


class TestHardParameterRejection:
    def test_rejected_proposal_is_recorded_and_no_candidate_is_created_for_it(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(mode="hard_risk_attempt")
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            assert result.candidates_created == []
            assert result.rejected_parameters == [{"parameter": "position_size_sol", "reason": "HARD_PARAMETER_MODIFICATION_REJECTED"}]

            rejected_rows = conn.execute("SELECT * FROM ai_rejected_proposals").fetchall()
            assert len(rejected_rows) == 1
            assert rejected_rows[0]["reason"] == "HARD_PARAMETER_MODIFICATION_REJECTED"

            candidate_rows = conn.execute("SELECT * FROM candidate_strategies").fetchall()
            assert candidate_rows == []


class TestCaching:
    def test_identical_analysis_is_served_from_cache_without_a_second_provider_call(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            first = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            second = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
        assert first.status == "completed"
        assert second.status == "cache_hit"
        assert second.analysis_id == first.analysis_id
        assert len(provider.calls) == 1  # the provider was called exactly once, not twice

    def test_a_different_analysis_period_is_a_cache_miss(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            second = service.analyze(conn, trades, "V1", "p3", "p4", "manual", force=True)
        assert second.status == "completed"
        assert len(provider.calls) == 2

    def test_a_cache_hit_still_records_a_usage_row(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service()
        with open_learning_db(str(db_path)) as conn:
            service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            usage_rows = conn.execute("SELECT * FROM ai_usage_log ORDER BY timestamp_ms").fetchall()
        assert len(usage_rows) == 2
        assert usage_rows[1]["cache_hit"] == 1


class TestProviderFailureNeverRaises:
    def test_timeout_is_caught_and_recorded_not_raised(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(mode="timeout")
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)  # must not raise
        assert result.status == "failed"
        assert "Provider error" in result.notes

    def test_rate_limit_is_caught_and_recorded(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(mode="rate_limit")
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            rows = conn.execute("SELECT * FROM ai_usage_log WHERE success = 0").fetchall()
        assert result.status == "failed"
        assert len(rows) >= 1

    def test_empty_response_is_caught_and_recorded(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(mode="empty")
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
        assert result.status == "failed"

    def test_malformed_json_is_caught_and_recorded(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(mode="malformed")
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
        assert result.status == "failed"

    def test_a_provider_failure_produces_no_candidate_and_no_trading_side_effect(self, tmp_path):
        db_path = make_bare_ledger(tmp_path)
        trades = make_trades(150)
        service, provider = make_service(mode="network_error")
        with open_learning_db(str(db_path)) as conn:
            result = service.analyze(conn, trades, "V1", "p1", "p2", "manual", force=True)
            candidate_rows = conn.execute("SELECT * FROM candidate_strategies").fetchall()
        assert result.status == "failed"
        assert candidate_rows == []
