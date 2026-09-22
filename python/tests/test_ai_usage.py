import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.ai.usage import estimate_cost_usd


def test_returns_none_for_an_unrecognized_model_rather_than_fabricating_a_cost():
    assert estimate_cost_usd("totally-unknown-model", 1000, 500) is None


def test_computes_cost_from_a_provided_pricing_table():
    pricing = {"model-a": (0.01, 0.03)}
    cost = estimate_cost_usd("model-a", 2000, 1000, pricing_table=pricing)
    assert cost == (2000 / 1000) * 0.01 + (1000 / 1000) * 0.03


def test_zero_tokens_costs_zero_for_a_known_model():
    pricing = {"model-a": (0.01, 0.03)}
    assert estimate_cost_usd("model-a", 0, 0, pricing_table=pricing) == 0.0
