"""Finalized minimum sample sizes (Phase 2 task 15). Never generate a
pattern, propose a parameter change, or validate a strategy from a smaller
sample than these -- the learning engine and analytics modules import these
constants rather than each hardcoding their own copy.
"""

MIN_TRADES_FOR_PATTERN = 50
MIN_TRADES_FOR_PARAMETER_PROPOSAL = 100
MIN_TRADES_FOR_STRATEGY_VALIDATION = 300
