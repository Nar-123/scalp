import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.backtest_bridge import BacktestBridgeError, run_ts_backtest


def _fake_result_json(**overrides) -> str:
    payload = {
        "status": "completed",
        "simulatorVersion": "backtest-replay-v1",
        "strategyLabel": "baseline-v1",
        "sampleSizeSnapshots": 10,
        "trades": [],
        "dataQualityIssues": [],
        "notes": "ok",
    }
    payload.update(overrides)
    return json.dumps(payload)


class _FakeCompletedProcess:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_raises_when_cli_file_does_not_exist(tmp_path):
    with pytest.raises(BacktestBridgeError, match="not found"):
        run_ts_backtest("ledger.sqlite", label="x", cli_path=tmp_path / "does_not_exist.js")


def test_parses_a_successful_result(tmp_path, monkeypatch):
    cli_path = tmp_path / "cli.js"
    cli_path.write_text("// fake")

    captured_args = {}

    def fake_run(args, capture_output, text, timeout):
        captured_args["args"] = args
        return _FakeCompletedProcess(returncode=0, stdout=_fake_result_json(strategyLabel="candidate-a"))

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = run_ts_backtest("ledger.sqlite", label="candidate-a", cli_path=cli_path)
    assert result.status == "completed"
    assert result.strategy_label == "candidate-a"
    assert "--db" in captured_args["args"]
    assert "ledger.sqlite" in captured_args["args"]


def test_writes_tunable_overrides_to_a_temp_file_and_passes_config_flag(tmp_path, monkeypatch):
    cli_path = tmp_path / "cli.js"
    cli_path.write_text("// fake")

    seen_config_contents = {}

    def fake_run(args, capture_output, text, timeout):
        if "--config" in args:
            config_path = args[args.index("--config") + 1]
            seen_config_contents["data"] = json.loads(Path(config_path).read_text())
            assert Path(config_path).exists()
        return _FakeCompletedProcess(returncode=0, stdout=_fake_result_json())

    monkeypatch.setattr(subprocess, "run", fake_run)

    run_ts_backtest(
        "ledger.sqlite", label="candidate-a", cli_path=cli_path,
        tunable_overrides={"filters": {"minLiquiditySol": 50}},
    )
    assert seen_config_contents["data"] == {"filters": {"minLiquiditySol": 50}}


def test_raises_on_nonzero_exit_code(tmp_path, monkeypatch):
    cli_path = tmp_path / "cli.js"
    cli_path.write_text("// fake")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeCompletedProcess(returncode=1, stderr="boom"))

    with pytest.raises(BacktestBridgeError, match="boom"):
        run_ts_backtest("ledger.sqlite", label="x", cli_path=cli_path)


def test_raises_on_malformed_json_stdout(tmp_path, monkeypatch):
    cli_path = tmp_path / "cli.js"
    cli_path.write_text("// fake")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeCompletedProcess(returncode=0, stdout="not json"))

    with pytest.raises(BacktestBridgeError, match="non-JSON"):
        run_ts_backtest("ledger.sqlite", label="x", cli_path=cli_path)


def test_raises_on_result_missing_an_expected_field(tmp_path, monkeypatch):
    cli_path = tmp_path / "cli.js"
    cli_path.write_text("// fake")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _FakeCompletedProcess(returncode=0, stdout=json.dumps({"status": "completed"})))

    with pytest.raises(BacktestBridgeError, match="missing expected field"):
        run_ts_backtest("ledger.sqlite", label="x", cli_path=cli_path)


def test_raises_on_timeout(tmp_path, monkeypatch):
    cli_path = tmp_path / "cli.js"
    cli_path.write_text("// fake")

    def fake_run(*a, **k):
        raise subprocess.TimeoutExpired(cmd="node", timeout=1)

    monkeypatch.setattr(subprocess, "run", fake_run)
    with pytest.raises(BacktestBridgeError, match="timed out"):
        run_ts_backtest("ledger.sqlite", label="x", cli_path=cli_path, timeout_sec=1)
