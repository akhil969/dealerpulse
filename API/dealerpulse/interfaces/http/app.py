"""Composition root: builds every dependency once and wires it into Flask."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from flask import Flask
from flask_cors import CORS

from ...application.services import (AnomalyService, AuthService, DatasetService, Deps, NotificationService, QueryService,
                                     UserService)
from ...config import ROOT, Settings, load_settings
from ...infrastructure.cache import DatasetCache
from ...infrastructure.db import create_schema, make_engine, make_session_factory
from ...infrastructure.repositories import UnitOfWork
from ...infrastructure.security import TokenService, hash_password, verify_password
from . import middleware
from .limits import default_limit, limiter
from .routes import api

log = logging.getLogger("dealerpulse")
SEED_FILE = ROOT / "data" / "seed" / "dealership_data.json"
DEFAULT_ADMIN = ("admin", "Admin$123", "Administrator")


class _Hasher:
    hash = staticmethod(hash_password)
    verify = staticmethod(verify_password)


@dataclass
class Container:
    settings: Settings
    auth: AuthService
    users: UserService
    datasets: DatasetService
    queries: QueryService
    anomalies: AnomalyService
    notifications: NotificationService


def bootstrap(deps: Deps, seed_file: Path | None = SEED_FILE) -> None:
    """First run only: create the admin login and import the bundled sample data."""
    with deps.uow() as r:
        if r.users.count() == 0:
            u, pw, name = DEFAULT_ADMIN
            r.users.create(username=u, password_hash=deps.hasher.hash(pw), role="ceo", display_name=name, created_by="setup")
            r.audit.add("setup", "user_create", "success", target=u, detail={"role": "ceo", "default_password": True})
            log.warning("Created the default admin login (admin / Admin$123). Change its password before real use.")
        if not r.datasets.current_version() and seed_file and seed_file.exists():
            data = json.loads(seed_file.read_text(encoding="utf-8"))
            v = r.datasets.replace(data, seed_file.name, "setup")
            r.audit.add("setup", "dataset_upload", "success", target=seed_file.name, detail={"version": v.key})


def create_app(settings: Settings | None = None, seed_file: Path | None = SEED_FILE) -> Flask:
    settings = settings or load_settings()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    app = Flask(__name__)
    app.config.update(
        DP_SETTINGS=settings,
        MAX_CONTENT_LENGTH=settings.max_upload_mb * 1024 * 1024,  # oversized bodies are refused before parsing
        JSON_SORT_KEYS=False,
        PROPAGATE_EXCEPTIONS=False,
    )

    engine = make_engine(settings.database_url)
    create_schema(engine)
    factory = make_session_factory(engine)
    deps = Deps(uow=lambda: UnitOfWork(factory), hasher=_Hasher(),
                tokens=TokenService(settings.jwt_secret, settings.access_token_minutes, settings.stream_ticket_seconds),
                cache=DatasetCache(), lockout_attempts=settings.lockout_attempts, lockout_minutes=settings.lockout_minutes)
    bootstrap(deps, seed_file)
    app.extensions["dp_engine"] = engine

    CORS(app, resources={r"/api/*": {"origins": settings.cors_origins}}, supports_credentials=False,
         allow_headers=["Authorization", "Content-Type", "If-None-Match", "X-File-Name", "X-Request-ID"],
         expose_headers=["ETag", "X-Request-ID"], methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], max_age=600)
    app.config["RATELIMIT_STORAGE_URI"] = settings.rate_limit_storage
    limiter.init_app(app)
    limiter.limit(default_limit)(api)  # every API route gets the default limit unless exempt or stricter

    app.extensions["dp"] = Container(settings, AuthService(deps), UserService(deps), DatasetService(deps), QueryService(deps),
                                     AnomalyService(deps), NotificationService(deps))
    middleware.install(app, settings.https_only)
    app.register_blueprint(api)
    return app
