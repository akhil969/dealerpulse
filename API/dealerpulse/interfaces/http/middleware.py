"""Cross-cutting HTTP concerns: security headers, gzip, request ids, safe error responses."""
from __future__ import annotations

import gzip
import logging
import uuid

from flask import Flask, g, jsonify, request
from pydantic import ValidationError
from werkzeug.exceptions import HTTPException

from ...application.errors import AppError
from ...infrastructure.security import TokenError

log = logging.getLogger("dealerpulse.http")

SECURITY_HEADERS = {
    # An API returns JSON only: forbid every kind of active content and framing.
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-site",
}


def install(app: Flask, https_only: bool) -> None:
    @app.before_request
    def _request_id():
        g.request_id = request.headers.get("X-Request-ID", "")[:64] or uuid.uuid4().hex

    @app.after_request
    def _headers(resp):
        for k, v in SECURITY_HEADERS.items():
            resp.headers.setdefault(k, v)
        if https_only:
            resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if request.path.startswith("/api/") and "Cache-Control" not in resp.headers:
            resp.headers["Cache-Control"] = "no-store"  # responses contain personal data
        resp.headers["X-Request-ID"] = g.get("request_id", "")
        resp.headers.pop("Server", None)
        return resp

    @app.after_request
    def _gzip(resp):
        if (resp.direct_passthrough or resp.status_code < 200 or resp.status_code >= 300 or "Content-Encoding" in resp.headers
                or "gzip" not in request.headers.get("Accept-Encoding", "") or resp.mimetype != "application/json"):
            return resp
        data = resp.get_data()
        if len(data) < 1024:
            return resp
        resp.set_data(gzip.compress(data, compresslevel=5))
        resp.headers["Content-Encoding"] = "gzip"
        resp.headers["Vary"] = "Accept-Encoding"
        resp.headers["Content-Length"] = str(len(resp.get_data()))
        return resp

    @app.errorhandler(AppError)
    def _app_error(e: AppError):
        body = {"error": {"code": e.code, "message": e.message}}
        if e.details is not None:
            body["error"]["details"] = e.details
        return jsonify(body), e.status

    @app.errorhandler(TokenError)
    def _token_error(_: TokenError):
        return jsonify({"error": {"code": "unauthorized", "message": "Your session has ended. Sign in again."}}), 401

    @app.errorhandler(ValidationError)
    def _validation(e: ValidationError):
        details = [{"field": ".".join(str(x) for x in err["loc"]), "message": err["msg"]} for err in e.errors()]
        return jsonify({"error": {"code": "invalid", "message": "Some fields aren't valid.", "details": details}}), 422

    @app.errorhandler(HTTPException)
    def _http(e: HTTPException):
        return jsonify({"error": {"code": e.name.lower().replace(" ", "_"), "message": e.description}}), e.code

    @app.errorhandler(Exception)
    def _unexpected(e: Exception):
        # Log the detail, return nothing internal (no stack traces or SQL to the caller).
        log.exception("Unhandled error (request %s)", g.get("request_id"))
        return jsonify({"error": {"code": "server_error", "message": "Something went wrong. Try again.",
                                  "request_id": g.get("request_id")}}), 500
