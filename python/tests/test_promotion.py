import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.db import open_learning_db, record_candidate
from learning.promotion import apply_promotion_decision, evaluate_promotion


def make_bare_ledger(tmp_path: Path) -> Path:
    from analytics.schema_contract import TRADES_COLUMNS, TRADES_TABLE

    db_path = tmp_path / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    columns_sql = ", ".join(f"{col} TEXT" for col in TRADES_COLUMNS)
    conn.execute(f"CREATE TABLE {TRADES_TABLE} ({columns_sql})")
    conn.commit()
    conn.close()
    return db_path


def test_evaluate_promotion_is_pending_when_no_stage_has_a_result():
    decision = evaluate_promotion("cand_1", [])
    assert decision.overall == "pending"
    assert decision.stage_statuses == {"backtest": "pending", "out_of_sample": "pending", "shadow": "pending"}


def test_evaluate_promotion_passes_only_when_every_required_stage_passes():
    results = [
        {"candidate_id": "cand_1", "stage": "backtest", "passed": 1, "created_at_ms": 1},
        {"candidate_id": "cand_1", "stage": "out_of_sample", "passed": 1, "created_at_ms": 2},
        {"candidate_id": "cand_1", "stage": "shadow", "passed": 1, "created_at_ms": 3},
    ]
    decision = evaluate_promotion("cand_1", results)
    assert decision.overall == "pass"


def test_evaluate_promotion_rejects_if_any_required_stage_failed():
    results = [
        {"candidate_id": "cand_1", "stage": "backtest", "passed": 1, "created_at_ms": 1},
        {"candidate_id": "cand_1", "stage": "out_of_sample", "passed": 0, "created_at_ms": 2},
        {"candidate_id": "cand_1", "stage": "shadow", "passed": 1, "created_at_ms": 3},
    ]
    decision = evaluate_promotion("cand_1", results)
    assert decision.overall == "rejected"
    assert decision.stage_statuses["out_of_sample"] == "rejected"


def test_evaluate_promotion_never_passes_by_omission_of_a_required_stage():
    # Only backtest + out_of_sample recorded -- shadow never ran.
    results = [
        {"candidate_id": "cand_1", "stage": "backtest", "passed": 1, "created_at_ms": 1},
        {"candidate_id": "cand_1", "stage": "out_of_sample", "passed": 1, "created_at_ms": 2},
    ]
    decision = evaluate_promotion("cand_1", results)
    assert decision.overall == "pending"  # NOT "pass" -- a missing stage never counts as passed


def test_evaluate_promotion_uses_the_latest_result_for_a_re_tested_stage():
    results = [
        {"candidate_id": "cand_1", "stage": "backtest", "passed": 0, "created_at_ms": 1},
        {"candidate_id": "cand_1", "stage": "backtest", "passed": 1, "created_at_ms": 2},  # re-tested, now passes
        {"candidate_id": "cand_1", "stage": "out_of_sample", "passed": 1, "created_at_ms": 3},
        {"candidate_id": "cand_1", "stage": "shadow", "passed": 1, "created_at_ms": 4},
    ]
    decision = evaluate_promotion("cand_1", results)
    assert decision.overall == "pass"


def test_evaluate_promotion_ignores_other_candidates_results():
    results = [
        {"candidate_id": "cand_other", "stage": "backtest", "passed": 1, "created_at_ms": 1},
        {"candidate_id": "cand_other", "stage": "out_of_sample", "passed": 1, "created_at_ms": 1},
        {"candidate_id": "cand_other", "stage": "shadow", "passed": 1, "created_at_ms": 1},
    ]
    decision = evaluate_promotion("cand_1", results)
    assert decision.overall == "pending"


def test_apply_promotion_decision_writes_promoted_status(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        record_candidate(
            conn,
            {"candidate_id": "cand_1", "parent_strategy": "V1", "changes": {}, "sample_size": 300, "created_at_ms": 1},
        )
        decision = evaluate_promotion(
            "cand_1",
            [
                {"candidate_id": "cand_1", "stage": "backtest", "passed": 1, "created_at_ms": 1},
                {"candidate_id": "cand_1", "stage": "out_of_sample", "passed": 1, "created_at_ms": 2},
                {"candidate_id": "cand_1", "stage": "shadow", "passed": 1, "created_at_ms": 3},
            ],
        )
        apply_promotion_decision(conn, decision)
        row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", ("cand_1",)).fetchone()
        assert row["status"] == "promoted"
        assert row["rejected"] == 0


def test_apply_promotion_decision_writes_rejected_status_with_reason(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        record_candidate(
            conn,
            {"candidate_id": "cand_1", "parent_strategy": "V1", "changes": {}, "sample_size": 300, "created_at_ms": 1},
        )
        decision = evaluate_promotion(
            "cand_1",
            [
                {"candidate_id": "cand_1", "stage": "backtest", "passed": 0, "created_at_ms": 1},
                {"candidate_id": "cand_1", "stage": "out_of_sample", "passed": 1, "created_at_ms": 2},
                {"candidate_id": "cand_1", "stage": "shadow", "passed": 1, "created_at_ms": 3},
            ],
        )
        apply_promotion_decision(conn, decision)
        row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", ("cand_1",)).fetchone()
        assert row["status"] == "rejected"
        assert row["rejected"] == 1
        assert "backtest" in row["rejection_reason"]


def test_apply_promotion_decision_leaves_pending_candidates_untouched(tmp_path):
    db_path = make_bare_ledger(tmp_path)
    with open_learning_db(str(db_path)) as conn:
        record_candidate(
            conn,
            {"candidate_id": "cand_1", "parent_strategy": "V1", "changes": {}, "sample_size": 300, "created_at_ms": 1},
        )
        decision = evaluate_promotion("cand_1", [])
        apply_promotion_decision(conn, decision)
        row = conn.execute("SELECT * FROM candidate_strategies WHERE candidate_id = ?", ("cand_1",)).fetchone()
        assert row["status"] == "pending"
