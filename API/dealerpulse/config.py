"""Configuration from environment variables only (no secrets in code). See .env.example."""
from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("dealerpulse.config")


def _env(name: str, default: str) -> str:
    """Empty values (e.g. `DATABASE_URL=` copied from .env.example) count as unset."""
    v = os.getenv(name)
    return default if v is None or not v.strip() else v.strip()


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None or not v.strip() else v.strip().lower() in ("1", "true", "yes", "on")


def _list(name: str, default: str) -> list[str]:
    return [s.strip() for s in _env(name, default).split(",") if s.strip()]


@dataclass(frozen=True)
class Settings:
    env: str = field(default_factory=lambda: _env("DEALERPULSE_ENV", "development"))
    # SQLite for local and Docker; on Vercel point this at a hosted database (e.g. postgresql+psycopg://...).
    database_url: str = field(default_factory=lambda: _env("DATABASE_URL", f"sqlite:///{(ROOT / 'data' / 'dealerpulse.db').as_posix()}"))
    jwt_secret: str = field(default_factory=lambda: _env("JWT_SECRET", ""))
    access_token_minutes: int = field(default_factory=lambda: int(_env("ACCESS_TOKEN_MINUTES", "30")))
    stream_ticket_seconds: int = 60
    cors_origins: list[str] = field(default_factory=lambda: _list("CORS_ORIGINS", "http://localhost:3000"))
    max_upload_mb: int = field(default_factory=lambda: int(_env("MAX_UPLOAD_MB", "20")))
    login_rate_limit: str = field(default_factory=lambda: _env("LOGIN_RATE_LIMIT", "10 per minute"))
    default_rate_limit: str = field(default_factory=lambda: _env("DEFAULT_RATE_LIMIT", "300 per minute"))
    rate_limit_storage: str = field(default_factory=lambda: _env("RATE_LIMIT_STORAGE", "memory://"))
    lockout_attempts: int = 5
    lockout_minutes: int = 15
    # Vercel functions have a time limit; streams close early and the browser reconnects.
    stream_max_seconds: int = field(default_factory=lambda: int(_env("STREAM_MAX_SECONDS", "300")))
    stream_poll_seconds: float = field(default_factory=lambda: float(_env("STREAM_POLL_SECONDS", "5")))
    page_size_default: int = 25
    page_size_max: int = 200
    https_only: bool = field(default_factory=lambda: _bool("HTTPS_ONLY", False))
    trust_proxy: bool = field(default_factory=lambda: _bool("TRUST_PROXY", False))

    @property
    def is_production(self) -> bool:
        return self.env == "production"


def resolve_sqlite(url: str) -> str:
    """`sqlite:///data/dealerpulse.db` is relative to the API folder, whatever directory the server starts in."""
    prefix = "sqlite:///"
    if url.startswith(prefix) and not url.startswith(prefix + "/") and ":" not in url[len(prefix):len(prefix) + 2]:
        return prefix + (ROOT / url[len(prefix):]).as_posix()
    return url


def load_settings(**overrides) -> Settings:
    s = Settings(**overrides)
    object.__setattr__(s, "database_url", resolve_sqlite(s.database_url))
    if not s.jwt_secret:
        if s.is_production:
            raise RuntimeError("JWT_SECRET must be set in production (at least 32 random bytes).")
        # Development only: a random per-process secret, so tokens die on restart.
        object.__setattr__(s, "jwt_secret", secrets.token_urlsafe(48))
        log.warning("JWT_SECRET not set: using a random development secret. Set it in .env for stable sessions.")
    if len(s.jwt_secret) < 32:
        raise RuntimeError("JWT_SECRET is too short; use at least 32 characters.")
    return s
