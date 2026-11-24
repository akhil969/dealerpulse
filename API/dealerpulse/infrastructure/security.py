"""Password hashing and signed tokens."""
from __future__ import annotations

import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from werkzeug.security import check_password_hash, generate_password_hash

ALGORITHM = "HS256"
ISSUER = "dealerpulse-api"
# Constant-cost dummy so unknown usernames take as long as wrong passwords (no user enumeration by timing).
_DUMMY_HASH = generate_password_hash(secrets.token_urlsafe(16), method="scrypt")


def hash_password(password: str) -> str:
    return generate_password_hash(password, method="scrypt")  # scrypt: memory-hard, OWASP-recommended


def verify_password(password_hash: str | None, password: str) -> bool:
    if not password_hash:
        check_password_hash(_DUMMY_HASH, password)
        return False
    return check_password_hash(password_hash, password)


class TokenError(Exception):
    pass


class TokenService:
    def __init__(self, secret: str, access_minutes: int, ticket_seconds: int):
        self._secret = secret
        self._access = timedelta(minutes=access_minutes)
        self._ticket = timedelta(seconds=ticket_seconds)

    def _encode(self, claims: dict[str, Any], ttl: timedelta, audience: str) -> tuple[str, int]:
        now = datetime.now(timezone.utc)
        payload = {**claims, "iat": now, "nbf": now, "exp": now + ttl, "iss": ISSUER, "aud": audience,
                   "jti": secrets.token_urlsafe(12)}
        return jwt.encode(payload, self._secret, algorithm=ALGORITHM), int(ttl.total_seconds())

    def access_token(self, user_id: int, token_version: int) -> tuple[str, int]:
        return self._encode({"sub": str(user_id), "ver": token_version}, self._access, "access")

    def stream_ticket(self, user_id: int, token_version: int) -> tuple[str, int]:
        """Short-lived ticket for EventSource, which can't send an Authorization header."""
        return self._encode({"sub": str(user_id), "ver": token_version}, self._ticket, "stream")

    def decode(self, token: str, audience: str) -> dict[str, Any]:
        try:
            # Algorithm pinned: rejects "none" and algorithm-confusion tokens.
            return jwt.decode(token, self._secret, algorithms=[ALGORITHM], audience=audience, issuer=ISSUER,
                              options={"require": ["exp", "iat", "sub", "aud", "iss"]})
        except jwt.PyJWTError as e:
            raise TokenError(str(e)) from e


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())
