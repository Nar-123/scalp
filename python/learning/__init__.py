"""Self-learning pipeline foundation for the New-Token Ultra Scalper V1.

Trade Ledger -> Local Analytics -> Pattern Discovery -> Candidate Parameters
-> Backtest -> Out-of-Sample -> Shadow -> Validation -> New Strategy Version.

Phase 2 implements this pipeline's foundation WITHOUT any AI/LLM
integration (none is added in this phase) and WITHOUT ever automatically
promoting a candidate into production -- see validation.py and
candidates.py. Nothing in this package can modify HARD_RISK_PARAMETERS or
the TypeScript engine's live configuration; it only ever writes to its own
tables (see db.py) in the shared SQLite file.
"""
