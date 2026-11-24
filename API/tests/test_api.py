import json
from pathlib import Path

from conftest import MANAGER_B1, SEED, STRONG, login

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "ts_findings.json").read_text(encoding="utf-8"))


# ---------- Authentication (A07) ----------

def test_admin_login_and_me(client, admin):
    me = client.get("/api/auth/me", headers=admin).get_json()
    assert me["role"] == "ceo" and me["username"] == "admin"


def test_wrong_password_and_unknown_user_look_the_same(client):
    a = client.post("/api/auth/login", json={"username": "admin", "password": "nope"})
    b = client.post("/api/auth/login", json={"username": "ghost", "password": "nope"})
    assert a.status_code == b.status_code == 401
    assert a.get_json() == b.get_json()


def test_lockout_after_five_failures(client):
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    r = client.post("/api/auth/login", json={"username": "admin", "password": "Admin$123"})
    assert r.status_code == 423


def test_logout_revokes_token(client, admin):
    assert client.post("/api/auth/logout", headers=admin).status_code == 204
    assert client.get("/api/auth/me", headers=admin).status_code == 401


def test_tampered_and_missing_tokens_rejected(client, admin):
    assert client.get("/api/leads").status_code == 401
    tok = admin["Authorization"][:-3] + "abc"
    assert client.get("/api/leads", headers={"Authorization": tok}).status_code == 401
    # alg=none token
    import base64
    none = base64.urlsafe_b64encode(b'{"alg":"none","typ":"JWT"}').rstrip(b"=").decode() + "." + \
        base64.urlsafe_b64encode(b'{"sub":"1","ver":0,"aud":"access","iss":"dealerpulse-api","exp":9999999999,"iat":1}').rstrip(b"=").decode() + "."
    assert client.get("/api/leads", headers={"Authorization": f"Bearer {none}"}).status_code == 401


def test_password_policy_and_change(client, admin):
    r = client.post("/api/auth/password", headers=admin, json={"current_password": "Admin$123", "new_password": "short"})
    assert r.status_code == 422
    r = client.post("/api/auth/password", headers=admin, json={"current_password": "Admin$123", "new_password": "N3w!Secret"})
    assert r.status_code == 204
    assert client.get("/api/auth/me", headers=admin).status_code == 401  # old token revoked
    login(client, "admin", "N3w!Secret")


# ---------- User administration ----------

def test_admin_creates_logins_from_existing_and_new_people(client, admin):
    cand = client.get("/api/users/candidates?page_size=200", headers=admin).get_json()
    assert cand["total"] == len(SEED["sales_reps"])
    r = client.post("/api/users", headers=admin, json={"username": "kavitha", "password": STRONG, "rep_id": MANAGER_B1["id"]})
    assert r.status_code == 201 and r.get_json()["role"] == "manager"
    dup = client.post("/api/users", headers=admin, json={"username": "kavitha2", "password": STRONG, "rep_id": MANAGER_B1["id"]})
    assert dup.status_code == 409
    new = client.post("/api/users", headers=admin, json={"username": "new.rep", "password": STRONG,
                                                         "new_person": {"name": "Asha Nair", "branch_id": "B2", "role": "sales_officer"}})
    assert new.status_code == 201
    body = new.get_json()
    assert body["role"] == "rep" and body["rep_id"].startswith("ADM-") and body["branch_id"] == "B2"
    assert client.get("/api/users/candidates?page_size=200", headers=admin).get_json()["total"] == len(SEED["sales_reps"]) - 1
    me = client.get("/api/auth/me", headers=login(client, "new.rep", STRONG)).get_json()
    assert me["branch_id"] == "B2"


def test_user_admin_is_leadership_only(client, manager, rep):
    for h in (manager, rep):
        assert client.get("/api/users", headers=h).status_code == 403
        assert client.post("/api/users", headers=h, json={"username": "x", "password": STRONG, "role": "ceo"}).status_code == 403
        assert client.post("/api/dataset", headers=h, json={}).status_code == 403
        assert client.get("/api/audit", headers=h).status_code == 403


def test_unknown_fields_rejected(client, admin):
    r = client.post("/api/users", headers=admin, json={"username": "abc", "password": STRONG, "role": "ceo", "is_admin": True})
    assert r.status_code == 422


# ---------- Row and field-level access (A01) ----------

def test_dataset_scoped_per_role(client, admin, manager, rep):
    full = client.get("/api/dataset", headers=admin).get_json()
    assert len(full["branches"]) == 5 and all("•" in l["phone"] for l in full["leads"])
    mgr = client.get("/api/dataset", headers=manager).get_json()
    assert {b["id"] for b in mgr["branches"]} == {"B1"}
    assert {l["branch_id"] for l in mgr["leads"]} == {"B1"} and "•" not in mgr["leads"][0]["phone"]
    r = client.get("/api/dataset", headers=rep).get_json()
    assert {l["assigned_to"] for l in r["leads"]} == {"SR13"} and r["targets"] == []
    assert [x["id"] for x in r["sales_reps"]] == ["SR13"]


def test_object_level_checks_return_404(client, manager, rep):
    other_branch_lead = next(l for l in SEED["leads"] if l["branch_id"] != "B1")
    assert client.get(f"/api/leads/{other_branch_lead['id']}", headers=manager).status_code == 404
    other_rep_lead = next(l for l in SEED["leads"] if l["assigned_to"] != "SR13")
    assert client.get(f"/api/leads/{other_rep_lead['id']}", headers=rep).status_code == 404


def test_filters_cannot_widen_scope(client, manager):
    page = client.get("/api/leads?branch_id=B3&page_size=200", headers=manager).get_json()
    assert page["total"] == 0  # B3 filter intersects with the B1 scope


def test_etag_304(client, admin):
    r = client.get("/api/dataset", headers=admin)
    again = client.get("/api/dataset", headers={**admin, "If-None-Match": r.headers["ETag"]})
    assert again.status_code == 304


# ---------- Pagination ----------

def test_pagination_and_bounds(client, admin):
    p1 = client.get("/api/leads?page=1&page_size=50&sort=-deal_value", headers=admin).get_json()
    assert p1["total"] == len(SEED["leads"]) and len(p1["items"]) == 50 and p1["has_next"]
    vals = [l["deal_value"] for l in p1["items"]]
    assert vals == sorted(vals, reverse=True)
    last = client.get(f"/api/leads?page={p1['pages']}&page_size=50", headers=admin).get_json()
    assert not last["has_next"] and len(last["items"]) == len(SEED["leads"]) - 50 * (p1["pages"] - 1)
    assert client.get("/api/leads?page_size=1000", headers=admin).status_code == 422
    assert client.get("/api/leads?sort=password", headers=admin).status_code == 422
    q = client.get("/api/leads?q=%25&page_size=5", headers=admin).get_json()
    assert q["total"] == 0  # LIKE wildcards are matched literally


# ---------- Upload ----------

def test_upload_validates_and_replaces(client, admin):
    bad = json.loads(json.dumps(SEED))
    bad["leads"][3]["status"] = "won"
    r = client.post("/api/dataset", headers=admin, json=bad)
    assert r.status_code == 422 and r.get_json()["error"]["details"]["errors"][0]["path"] == "leads[3].status"
    small = json.loads(json.dumps(SEED))
    small["leads"] = small["leads"][:100]
    keep = {l["id"] for l in small["leads"]}
    small["deliveries"] = [d for d in small["deliveries"] if d["lead_id"] in keep]
    r = client.post("/api/dataset", headers={**admin, "X-File-Name": "small.json"}, json=small)
    assert r.status_code == 201 and r.get_json()["counts"]["leads"] == 100
    assert client.get("/api/leads", headers=admin).get_json()["total"] == 100


def test_upload_rejects_non_json(client, admin):
    r = client.post("/api/dataset", headers={**admin, "Content-Type": "text/plain"}, data="{}")
    assert r.status_code == 422


# ---------- Anomalies (Python port matches the TypeScript detector) ----------

def _ids(client, headers):
    return sorted(a["id"] for a in client.get("/api/anomalies?page_size=200", headers=headers).get_json()["items"])


def test_findings_match_typescript(app):
    from dealerpulse.domain.access import Principal, scope_dataset
    from dealerpulse.domain.anomaly.detect import detect
    from dealerpulse.domain.model import build_model
    full = build_model(SEED)
    assert sorted(f.id for f in detect(full)) == sorted(x["id"] for x in FIXTURES["full"])
    for key, p in (("manager_B3", Principal(9, "m", "m", "manager", "SR3", "B3")), ("rep_SR13", Principal(9, "r", "r", "rep", "SR13", "B2"))):
        m = build_model(scope_dataset(SEED, p), (full.as_of, full.months))
        assert sorted(f.id for f in detect(m)) == sorted(x["id"] for x in FIXTURES[key]), key
    by_id = {f.id: f for f in detect(full)}
    for x in FIXTURES["full"]:
        assert by_id[x["id"]].confidence == x["confidence"]
        assert sorted(e.method for e in by_id[x["id"]].evidence) == x["methods"]


def test_review_flow_and_permissions(client, admin, manager, rep):
    flagged = client.get("/api/anomalies?status=flagged", headers=admin).get_json()
    assert flagged["counts"]["flagged"] == 8 and flagged["counts"]["confirmed"] == 0
    aid = "conversion:branch:B3"
    r = client.put(f"/api/anomalies/{aid}/review", headers=admin, json={"decision": "confirmed", "note": "Checked"})
    assert r.status_code == 200 and r.get_json()["status"] == "confirmed"
    assert client.put(f"/api/anomalies/{aid}/review", headers=rep, json={"decision": "dismissed"}).status_code == 403
    # Manager of B1 can't review B3 and can't even see it.
    assert client.get(f"/api/anomalies/{aid}", headers=manager).status_code == 404
    hist = client.get(f"/api/anomalies/{aid}", headers=admin).get_json()["history"]
    assert hist[-1]["decision"] == "confirmed"
    assert client.delete(f"/api/anomalies/{aid}/review", headers=admin, json={}).get_json()["status"] == "flagged"


# ---------- Notifications ----------

def test_notifications_paginated_and_read(client, rep):
    page = client.get("/api/notifications?page_size=2", headers=rep).get_json()
    assert page["total"] >= 1 and len(page["items"]) <= 2
    first = page["items"][0]["id"]
    assert client.post("/api/notifications/read", headers=rep, json={"ids": [first, "someone-elses"]}).get_json()["marked"] == 1
    assert client.get("/api/notifications", headers=rep).get_json()["unread"] == page["total"] - 1


def test_stream_requires_ticket_and_streams_notices(client, rep):
    assert client.get("/api/notifications/stream").status_code == 401
    access_token = rep["Authorization"][7:]
    assert client.get(f"/api/notifications/stream?ticket={access_token}").status_code == 401  # access token isn't a ticket
    ticket = client.post("/api/notifications/stream-ticket", headers=rep).get_json()["ticket"]
    resp = client.get(f"/api/notifications/stream?ticket={ticket}")
    assert resp.status_code == 200 and resp.mimetype == "text/event-stream"
    chunks = list(resp.response)
    assert chunks and all(isinstance(chunk, bytes) for chunk in chunks)  # gunicorn rejects str chunks
    text = b"".join(chunks).decode()
    assert "event: notice" in text and "event: sync" in text and "event: bye" in text


# ---------- Security headers and errors (A05) ----------

def test_security_headers_and_safe_errors(client, admin):
    r = client.get("/api/health")
    for h in ("Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"):
        assert h in r.headers
    assert client.get("/api/does-not-exist", headers=admin).get_json()["error"]["code"] == "not_found"
    assert client.get("/api/leads", headers=admin).headers["Cache-Control"] == "no-store"


def test_cors_allowlist(client):
    ok = client.options("/api/health", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET"})
    bad = client.options("/api/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("Access-Control-Allow-Origin") == "http://localhost:3000"
    assert "Access-Control-Allow-Origin" not in bad.headers


def test_gzip(client, admin):
    r = client.get("/api/leads?page_size=200", headers={**admin, "Accept-Encoding": "gzip"})
    assert r.headers.get("Content-Encoding") == "gzip"


def test_dataset_info_shares_as_of_across_roles(client, admin, rep):
    a = client.get("/api/dataset/info", headers=admin).get_json()
    r = client.get("/api/dataset/info", headers=rep).get_json()
    assert a["as_of"] == r["as_of"] and a["months"] == r["months"] and len(a["months"]) == 7
    assert "uploaded_by" in a and "uploaded_by" not in r


def test_relative_sqlite_url_resolves_to_api_folder():
    from dealerpulse.config import ROOT, resolve_sqlite
    assert resolve_sqlite("sqlite:///data/dealerpulse.db") == f"sqlite:///{(ROOT / 'data' / 'dealerpulse.db').as_posix()}"
    assert resolve_sqlite("sqlite:////app/data/x.db") == "sqlite:////app/data/x.db"
    assert resolve_sqlite("sqlite:///C:/x.db") == "sqlite:///C:/x.db"


def test_empty_env_values_fall_back_to_defaults(monkeypatch):
    from dealerpulse.config import load_settings
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("ACCESS_TOKEN_MINUTES", "")
    s = load_settings(jwt_secret="x" * 48)
    assert s.database_url.startswith("sqlite:///") and s.access_token_minutes == 30
