"""Authentication and authorisation decorators. Deny by default: every route needs @authenticated unless public."""
from __future__ import annotations

from functools import wraps
from typing import Callable

from flask import current_app, g, request

from ...application.errors import Forbidden, Unauthorized
from ...domain.access import Principal


def client_ip() -> str:
    if current_app.config["DP_SETTINGS"].trust_proxy:
        return (request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or request.remote_addr or "")[:64]
    return (request.remote_addr or "")[:64]


def _bearer() -> str:
    h = request.headers.get("Authorization", "")
    if not h.startswith("Bearer ") or len(h) > 4096:
        raise Unauthorized("Sign in to continue.")
    return h[7:].strip()


def authenticated(fn: Callable) -> Callable:
    @wraps(fn)
    def wrapper(*a, **kw):
        g.principal = current_app.extensions["dp"].auth.authenticate(_bearer(), "access")
        return fn(*a, **kw)
    return wrapper


def roles(*allowed: str) -> Callable:
    def deco(fn: Callable) -> Callable:
        @wraps(fn)
        @authenticated
        def wrapper(*a, **kw):
            if g.principal.role not in allowed:
                raise Forbidden("You don't have access to this.")
            return fn(*a, **kw)
        return wrapper
    return deco


def principal() -> Principal:
    return g.principal
