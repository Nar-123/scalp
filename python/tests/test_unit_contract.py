import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analytics.features import bucket_liquidity, compute_feature_buckets
from analytics.schema_contract import (
    MARKET_DATA_UNIT_CONTRACT_VERSION,
    TOKEN_EVALUATIONS_COLUMNS,
    TRADES_COLUMNS,
)


def test_liquidity_and_volume_columns_are_explicitly_sol():
    for col in ("entry_liquidity_sol", "entry_volume_1m_sol"):
        assert col in TRADES_COLUMNS
    for col in ("liquidity_sol", "volume_1m_sol"):
        assert col in TOKEN_EVALUATIONS_COLUMNS
    assert MARKET_DATA_UNIT_CONTRACT_VERSION == "sol-units-v2"


def test_liquidity_buckets_are_in_sol_and_thresholds_are_unchanged():
    # V1 minimum liquidity is 20 SOL: the bucket edges did not move.
    assert bucket_liquidity(19.99) == "below_20_SOL"
    assert bucket_liquidity(20) == "20-30_SOL"
    assert bucket_liquidity(30) == "30-50_SOL"
    assert bucket_liquidity(100) == "100+_SOL"


def test_a_real_sol_side_value_buckets_as_below_minimum_not_as_a_huge_pool():
    # The pre-fix bug stored a TOKEN amount (991,688,175) here, which lands in the top bucket.
    assert bucket_liquidity(0.3054) == "below_20_SOL"
    assert bucket_liquidity(991_688_175) == "100+_SOL"  # what the bug produced
    assert compute_feature_buckets({"entry_liquidity_sol": 0.3054}).liquidity_bucket == "below_20_SOL"


def test_missing_one_minute_volume_stays_missing():
    # entry_volume_1m_sol NULL must never be defaulted to a number by analytics.
    assert compute_feature_buckets({"entry_volume_1m_sol": None}).liquidity_bucket == "unknown"
