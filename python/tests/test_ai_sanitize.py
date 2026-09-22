import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from learning.ai.sanitize import REDACTED, sanitize_error_message, sanitize_for_ai


class TestSanitizeForAI:
    def test_redacts_a_key_named_like_a_secret(self):
        payload = {"private_key": "whatever", "seed_phrase": "word word word", "api_key": "abc"}
        sanitized = sanitize_for_ai(payload)
        assert sanitized == {"private_key": REDACTED, "seed_phrase": REDACTED, "api_key": REDACTED}

    def test_redacts_a_base58_shaped_value_regardless_of_key_name(self):
        base58_secret = "A" * 90  # shaped like a base58-encoded Solana secret key
        payload = {"totally_innocent_field": base58_secret}
        sanitized = sanitize_for_ai(payload)
        assert sanitized["totally_innocent_field"] == REDACTED

    def test_leaves_ordinary_compact_statistics_untouched(self):
        payload = {"win_rate": 0.55, "avg_pnl_sol": 0.01, "strategy_version": "baseline-v1"}
        assert sanitize_for_ai(payload) == payload

    def test_recurses_into_nested_dicts_and_lists(self):
        payload = {"patterns": [{"description": "ok", "wallet_credential_path": "/secrets/wallet.json"}]}
        sanitized = sanitize_for_ai(payload)
        assert sanitized["patterns"][0]["wallet_credential_path"] == REDACTED
        assert sanitized["patterns"][0]["description"] == "ok"

    def test_never_mutates_the_input(self):
        payload = {"private_key": "x"}
        sanitize_for_ai(payload)
        assert payload == {"private_key": "x"}


class TestSanitizeErrorMessage:
    def test_scrubs_a_key_value_pair_shaped_like_a_secret(self):
        text = "request failed: api_key=sk-abcdef1234567890 not authorized"
        scrubbed = sanitize_error_message(text)
        assert "sk-abcdef1234567890" not in scrubbed
        assert REDACTED in scrubbed

    def test_scrubs_a_standalone_hex_blob(self):
        text = f"signing failed with key {'a' * 64}"
        scrubbed = sanitize_error_message(text)
        assert "a" * 64 not in scrubbed

    def test_leaves_an_ordinary_message_untouched(self):
        text = "provider timed out after 30 seconds"
        assert sanitize_error_message(text) == text
