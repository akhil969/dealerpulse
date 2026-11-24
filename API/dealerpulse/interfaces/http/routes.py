"""HTTP routes. Thin: parse and validate input, call one use case, shape the response."""
from __future__ import annotations

import json
import time
from typing import Any

from flask import Blueprint, Response, current_app, g, jsonify, request, stream_with_context

from ...application.errors import Invalid, Unauthorized
from .auth import authenticated, client_ip, principal, roles
from .limits import limiter, login_limit
from .schemas import (AnomalyArgs, LeadArgs, LoginIn, NoticeArgs, PageArgs, PasswordChangeIn, ReadIn, ReopenIn, ReviewIn,
                      SearchArgs, UserCreateIn, UserUpdateIn)

api = Blueprint("api", __name__, url_prefix="/api")


def svc():
    return current_app.extensions["dp"]


def body(model):
    if not request.is_json:
        raise Invalid("Send JSON with Content-Type: application/json.")
    return model.model_validate(request.get_json(silent=False))


def args(model):
    return model.model_validate(request.args.to_dict())


# ---------- Health ----------

@api.get("/health")
@limiter.exempt
def health():
    return jsonify({"status": "ok"})


# ---------- Auth ----------

@api.post("/auth/login")
@limiter.limit(login_limit)
def login():
    data = body(LoginIn)
    return jsonify(svc().auth.login(data.username, data.password, client_ip()))


@api.post("/auth/logout")
@authenticated
def logout():
    svc().auth.logout(principal(), client_ip())
    return "", 204


@api.post("/auth/refresh")
@authenticated
def refresh():
    return jsonify(svc().auth.refresh(principal()))


@api.get("/auth/me")
@authenticated
def me():
    return jsonify(svc().auth.me_payload(principal()))


@api.post("/auth/password")
@authenticated
def change_password():
    data = body(PasswordChangeIn)
    svc().auth.change_password(principal(), data.current_password, data.new_password, client_ip())
    return "", 204


# ---------- Users (leadership) ----------

@api.get("/users")
@roles("ceo")
def users_list():
    a = args(SearchArgs)
    return jsonify(svc().users.list(principal(), a.to_request(), a.q, a.role).to_dict())


@api.get("/users/candidates")
@roles("ceo")
def users_candidates():
    a = args(SearchArgs)
    return jsonify(svc().users.candidates(principal(), a.to_request(), a.branch_id, a.q).to_dict())


@api.post("/users")
@roles("ceo")
def users_create():
    return jsonify(svc().users.create(principal(), body(UserCreateIn).model_dump(exclude_none=True), client_ip())), 201


@api.patch("/users/<int:user_id>")
@roles("ceo")
def users_update(user_id: int):
    return jsonify(svc().users.update(principal(), user_id, body(UserUpdateIn).model_dump(exclude_none=True), client_ip()))


@api.delete("/users/<int:user_id>")
@roles("ceo")
def users_delete(user_id: int):
    svc().users.delete(principal(), user_id, client_ip())
    return "", 204


# ---------- Dataset ----------

@api.get("/dataset/info")
@authenticated
def dataset_info():
    return jsonify(svc().datasets.info(principal()))


@api.get("/dataset")
@authenticated
def dataset():
    payload, etag = svc().datasets.scoped(principal())
    if request.headers.get("If-None-Match") == etag:
        return Response(status=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})
    return Response(payload, mimetype="application/json", headers={"ETag": etag, "Cache-Control": "private, no-cache"})


@api.post("/dataset")
@limiter.limit("10 per minute")
@roles("ceo")
def dataset_upload():
    if not request.is_json:
        raise Invalid("Upload the file as JSON with Content-Type: application/json.")
    try:
        data = json.loads(request.get_data(cache=False))
    except (ValueError, UnicodeDecodeError) as e:
        raise Invalid("The file isn't valid JSON.", {"message": str(e)[:200]}) from None
    name = (request.headers.get("X-File-Name") or "upload.json")[:200]
    return jsonify(svc().datasets.upload(principal(), data, name, client_ip())), 201


# ---------- Paginated resources (always scoped to the caller) ----------

@api.get("/leads")
@authenticated
def leads():
    a = args(LeadArgs)
    return jsonify(svc().queries.leads(principal(), a.to_query(), a.to_request()).to_dict())


@api.get("/leads/<lead_id>")
@authenticated
def lead(lead_id: str):
    return jsonify(svc().queries.lead(principal(), lead_id[:40]))


def _table(name: str):
    a = args(SearchArgs)
    return jsonify(svc().queries.table(principal(), name, a.to_request(), a.q).to_dict())


@api.get("/branches")
@authenticated
def branches():
    return _table("branches")


@api.get("/sales-reps")
@authenticated
def sales_reps():
    return _table("sales_reps")


@api.get("/targets")
@authenticated
def targets():
    return _table("targets")


@api.get("/deliveries")
@authenticated
def deliveries():
    return _table("deliveries")


@api.get("/audit")
@roles("ceo")
def audit():
    a = args(SearchArgs)
    return jsonify(svc().queries.audit(principal(), a.to_request(), a.action).to_dict())


# ---------- Anomalies ----------

@api.get("/anomalies")
@roles("ceo", "manager", "rep")
def anomalies():
    a = args(AnomalyArgs)
    return jsonify(svc().anomalies.list(principal(), a.to_request(), a.status, a.category, a.branch_id))


@api.get("/anomalies/<path:anomaly_id>")
@authenticated
def anomaly(anomaly_id: str):
    if anomaly_id.endswith("/review"):
        raise Invalid("Use PUT or DELETE for reviews.")
    return jsonify(svc().anomalies.get(principal(), anomaly_id[:200]))


@api.put("/anomalies/<path:anomaly_id>/review")
@roles("ceo", "manager")
def anomaly_review(anomaly_id: str):
    data = body(ReviewIn)
    return jsonify(svc().anomalies.review(principal(), anomaly_id[:200], data.decision, data.note, client_ip()))


@api.delete("/anomalies/<path:anomaly_id>/review")
@roles("ceo", "manager")
def anomaly_reopen(anomaly_id: str):
    note = ReopenIn.model_validate(request.get_json(silent=True) or {}).note
    return jsonify(svc().anomalies.review(principal(), anomaly_id[:200], None, note, client_ip()))


# ---------- Notifications ----------

@api.get("/notifications")
@authenticated
def notifications():
    a = args(NoticeArgs)
    return jsonify(svc().notifications.list(principal(), a.to_request(), a.unread_only))


@api.post("/notifications/read")
@authenticated
def notifications_read():
    return jsonify({"marked": svc().notifications.mark_read(principal(), body(ReadIn).ids)})


@api.post("/notifications/stream-ticket")
@limiter.limit("30 per minute")
@authenticated
def stream_ticket():
    return jsonify(svc().auth.stream_ticket(principal()))


def _sse(event: str, data: Any, event_id: str | None = None) -> str:
    lines = [f"event: {event}"]
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append("data: " + json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines) + "\n\n"


@api.get("/notifications/stream")
@limiter.exempt
def notifications_stream():
    """Server-sent events: unread notices one per event, then new ones as data or reviews change.

    EventSource can't send headers, so it authenticates with a 60-second ticket from /stream-ticket
    (never the access token in the URL). The stream closes after STREAM_MAX_SECONDS; the browser reconnects.
    """
    ticket = request.args.get("ticket", "")
    if not ticket or len(ticket) > 2048:
        raise Unauthorized("A stream ticket is required.")
    p = svc().auth.authenticate(ticket, "stream")
    settings = current_app.config["DP_SETTINGS"]
    notifications = svc().notifications
    log = current_app.logger

    def generate():
        sent: set[str] = set()
        deadline = time.monotonic() + settings.stream_max_seconds
        last_ping = time.monotonic()
        yield "retry: 5000\n\n"
        stamp = None
        while time.monotonic() < deadline:
            try:
                new_stamp, unread = notifications.state(p)
            except Exception:  # noqa: BLE001 - keep the stream alive; the client will reconnect if needed
                log.exception("stream poll failed")
                break
            if new_stamp != stamp:
                stamp = new_stamp
                for n in unread:
                    if n["id"] not in sent:
                        sent.add(n["id"])
                        yield _sse("notice", n, n["id"])
                yield _sse("sync", {"unread": len(unread), "ids": [n["id"] for n in unread]})
            if time.monotonic() - last_ping > 15:
                last_ping = time.monotonic()
                yield ": ping\n\n"
            time.sleep(settings.stream_poll_seconds)
        yield _sse("bye", {"reconnect": True})

    # WSGI servers (gunicorn) require bytes; the stream bypasses Flask's own encoding.
    return Response(stream_with_context(chunk.encode("utf-8") for chunk in generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
                    direct_passthrough=True)
