"""Local analytics for the New-Token Ultra Scalper V1.

Reads the TypeScript engine's shared SQLite trade ledger (read-only -- see
reader.py) and computes deterministic statistics, feature buckets, and
correlation-only pattern observations from it. No AI/LLM code here; see
../learning/ for the pipeline that consumes this package's output.
"""
