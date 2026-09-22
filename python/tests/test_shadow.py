import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.shadow import evaluate_shadow_candidate


def make_trades(count, pnl=0.01):
    return [{"pnl_sol": pnl} for _ in range(count)]


def test_shadow_result_is_purely_computational_no_execution():
    result = evaluate_shadow_candidate("cand_1", make_trades(10, pnl=0.02))
    assert result.sample_size == 10
    assert result.hypothetical_pnl_sol == 0.2
    assert result.win_rate == 1.0


def test_shadow_comparison_empty_without_production_trades():
    result = evaluate_shadow_candidate("cand_1", make_trades(10))
    assert result.comparison_to_production == {}


def test_shadow_comparison_populated_with_production_trades():
    candidate_trades = make_trades(10, pnl=0.02)
    production_trades = make_trades(10, pnl=0.01)
    result = evaluate_shadow_candidate("cand_1", candidate_trades, production_trades=production_trades)
    assert result.comparison_to_production["production_sample_size"] == 10
    assert result.comparison_to_production["candidate_win_rate_delta"] == 0.0  # both 100% win rate


def test_shadow_handles_empty_hypothetical_trades():
    result = evaluate_shadow_candidate("cand_1", [])
    assert result.sample_size == 0
    assert result.hypothetical_pnl_sol == 0
    assert result.win_rate is None
