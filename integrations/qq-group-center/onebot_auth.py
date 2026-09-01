"""Authentication helpers for OneBot HTTP event callbacks."""

from __future__ import annotations

import hashlib
import hmac
from secrets import compare_digest
from typing import Optional


def authorize_onebot(
    expected: str,
    body: bytes,
    authorization: Optional[str] = None,
    x_access_token: Optional[str] = None,
    x_signature: Optional[str] = None,
) -> bool:
    """Accept API tokens and NapCat's HMAC-SHA1 callback signature."""
    if not expected:
        return True

    candidate = x_access_token or ""
    if authorization and authorization.lower().startswith("bearer "):
        candidate = authorization[7:].strip()
    if candidate and compare_digest(candidate, expected):
        return True

    if not x_signature or not x_signature.lower().startswith("sha1="):
        return False
    supplied_signature = x_signature[5:].strip().lower()
    expected_signature = hmac.new(
        expected.encode("utf-8"), body, hashlib.sha1
    ).hexdigest()
    return compare_digest(supplied_signature, expected_signature)
