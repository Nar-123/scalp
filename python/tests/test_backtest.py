import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.backtest import run_backtest


def make_trades(count, pnl=0.01, strategy_version="V1"):
    return [{"pnl_sol": pnl, "strategy_version": strategy_version, "hold_duration_ms": 5000} for _ in range(count)]


def test_refuses_to_fabricate_a_result_below_minimum_sample_size():
    result = run_backtest("cand_1", make_trades(50), min_sample_size=300)
    assert result.data_sufficient is False
    assert result.metrics == {}
    assert "Insufficient historical data" in result.notes


def test_produces_real_metrics_above_minimum_sample_size():
    trades = make_trades(150, pnl=0.01) + make_trades(150, pnl=-0.005)
    result = run_backtest("cand_1", trades, min_sample_size=300)
    assert result.data_sufficient is True
    assert result.sample_size == 300
    assert "win_rate" in result.metrics
    assert result.metrics["win_rate"] == 0.5


def test_rejects_a_sample_mixing_strategy_versions():
    trades = make_trades(200, strategy_version="V1") + make_trades(200, strategy_version="V1.1")
    try:
        run_backtest("cand_1", trades, min_sample_size=300)
        assert False, "expected ValueError for mixed strategy versions"
    except ValueError:
        pass


def test_insufficient_data_result_is_not_a_pass_or_fail():
    # data_sufficient=False must not be conflated with "candidate failed" --
    # there's simply no verdict yet.
    result = run_backtest("cand_1", make_trades(10), min_sample_size=300)
    assert result.data_sufficient is False
    assert not hasattr(result, "passed")
