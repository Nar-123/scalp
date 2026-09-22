"""AI cost estimation (Phase 4 tasks 19-20).

`estimate_cost_usd` never invents a cost for a model it doesn't recognize --
it returns None rather than a fabricated number, consistent with this
project's "never manufacture a conclusion from insufficient information"
posture used everywhere else (backtest/learning). The actual per-call usage
log lives in learning/db.py (record_ai_usage / get_ai_usage_report); this
module only computes the cost figure that goes into it.
"""

from __future__ import annotations

# USD per 1,000 tokens. Approximate, illustrative, operator-editable -- NOT
# fetched from any live pricing API (this project makes no outbound network
# calls other than the optionally-configured AI provider itself, and never
# silently changes what it charges an operator's mental model of cost).
DEFAULT_PRICING_PER_1K_TOKENS: dict[str, tuple[float, float]] = {
    # model: (input_usd_per_1k, output_usd_per_1k)
}


def estimate_cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    pricing_table: dict[str, tuple[float, float]] | None = None,
) -> float | None:
    table = pricing_table if pricing_table is not None else DEFAULT_PRICING_PER_1K_TOKENS
    rates = table.get(model)
    if rates is None:
        return None
    input_rate, output_rate = rates
    return (input_tokens / 1000) * input_rate + (output_tokens / 1000) * output_rate
