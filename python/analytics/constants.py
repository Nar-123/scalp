"""Finalized minimum sample sizes (Phase 2 task 15). Never generate a
pattern, propose a parameter change, or validate a strategy from a smaller
sample than these -- the learning engine and analytics modules import these
constants rather than each hardcoding their own copy.
"""

MIN_TRADES_FOR_PATTERN = 50
MIN_TRADES_FOR_PARAMETER_PROPOSAL = 100
MIN_TRADES_FOR_STRATEGY_VALIDATION = 300

# Phase 4 (AI analyst / research layer). AI is never on the realtime trading
# path -- these only govern how the (separate, offline) research pipeline
# talks to a provider. See docs/PHASE_4_AI_ANALYST.md.
AI_MAX_INPUT_TOKENS = 3000
AI_MAX_OUTPUT_TOKENS = 1000
AI_DEFAULT_PROMPT_VERSION = "AI_PROMPT_V1"
AI_SCHEDULED_RESEARCH_INTERVAL_SEC = 6 * 3600  # "once per 6 hours" (spec section 28)
