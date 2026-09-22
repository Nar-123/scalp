"""Secret sanitization before anything reaches an AI provider (Phase 4 task 22).

`AIAnalysisInput` is already built exclusively from compact statistics/
patterns (never raw ledger rows), so it structurally can't contain a real
secret. This module is the defense-in-depth layer anyway: it recursively
strips any key that LOOKS secret-shaped and redacts any string VALUE that
looks like a secret regardless of its key name, and separately scrubs
error-message text before it is ever logged or surfaced (accidental
leakage through an exception message is a distinct failure mode from
leakage through the payload itself).
"""

from __future__ import annotations

import re
from typing import Any

REDACTED = "[REDACTED]"

_SECRET_KEY_PATTERN = re.compile(
    r"(private[_-]?key|secret|seed[_-]?phrase|mnemonic|api[_-]?key|password|credential|authorization|bearer|wallet[_-]?key|access[_-]?token)",
    re.IGNORECASE,
)

# Heuristics for a secret-shaped VALUE, independent of its key name:
# - a base58 string in the typical Solana secret-key/keypair length range
# - a long hex blob (raw key material, tx signatures are excluded by length elsewhere)
# - a JWT-shaped three-dot-separated token
_BASE58_SECRET_VALUE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{80,}$")
_HEX_SECRET_VALUE = re.compile(r"^[0-9a-fA-F]{48,}$")
_JWT_SHAPED_VALUE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")

# Unanchored counterparts for scrubbing a secret-shaped substring out of a
# larger free-text message (sanitize_error_message), where the whole-string
# anchors above would never match.
_BASE58_SECRET_SUBSTRING = re.compile(r"[1-9A-HJ-NP-Za-km-z]{80,}")
_HEX_SECRET_SUBSTRING = re.compile(r"[0-9a-fA-F]{48,}")
_JWT_SHAPED_SUBSTRING = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")


def _looks_like_secret_value(value: str) -> bool:
    return bool(_BASE58_SECRET_VALUE.match(value) or _HEX_SECRET_VALUE.match(value) or _JWT_SHAPED_VALUE.match(value))


def sanitize_for_ai(payload: Any) -> Any:
    """Recursively returns a copy of `payload` with any secret-shaped key
    dropped to a redaction marker and any secret-shaped string value
    redacted regardless of key. Never mutates the input."""
    if isinstance(payload, dict):
        sanitized: dict[str, Any] = {}
        for key, value in payload.items():
            if isinstance(key, str) and _SECRET_KEY_PATTERN.search(key):
                sanitized[key] = REDACTED
            else:
                sanitized[key] = sanitize_for_ai(value)
        return sanitized
    if isinstance(payload, list):
        return [sanitize_for_ai(item) for item in payload]
    if isinstance(payload, str) and _looks_like_secret_value(payload):
        return REDACTED
    return payload


def sanitize_error_message(text: str) -> str:
    """Scrubs a free-text error/exception message before it is logged or
    surfaced, in case an underlying error (e.g. from a misconfigured HTTP
    provider) happens to echo back a header or config value verbatim."""
    if not isinstance(text, str):
        return text
    scrubbed = text
    # "key=value" / "key: value" pairs whose key looks secret-shaped -- scrub
    # the value, keep the key (and an intervening "Bearer ", if present)
    # visible so the message stays readable. Without the optional "Bearer"
    # consumption, "Authorization: Bearer sk-..." would match "Authorization"
    # as the key and "Bearer" as the value, leaving the actual "sk-..."
    # token sitting unredacted right after it.
    scrubbed = re.sub(
        r"(" + _SECRET_KEY_PATTERN.pattern + r")(\s*[:=]\s*[\"']?(?:Bearer\s+)?)([^\s\"',}\)]+)",
        lambda m: m.group(1) + m.group(2) + REDACTED,
        scrubbed,
        flags=re.IGNORECASE,
    )
    # Any standalone secret-shaped value, regardless of surrounding context.
    for pattern in (_BASE58_SECRET_SUBSTRING, _HEX_SECRET_SUBSTRING, _JWT_SHAPED_SUBSTRING):
        scrubbed = pattern.sub(REDACTED, scrubbed)
    return scrubbed
