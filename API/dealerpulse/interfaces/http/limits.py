"""Rate limiting (OWASP A04/A07): defaults for every route, stricter where guessing or heavy work is possible."""
from __future__ import annotations

from flask import current_app
from flask_limiter import Limiter

from .auth import client_ip

limiter = Limiter(key_func=client_ip, headers_enabled=True)


def login_limit() -> str:
    return current_app.config["DP_SETTINGS"].login_rate_limit


def default_limit() -> str:
    return current_app.config["DP_SETTINGS"].default_rate_limit
