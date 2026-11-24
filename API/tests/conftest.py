import json
from pathlib import Path

import pytest

from dealerpulse.config import load_settings
from dealerpulse.interfaces.http.app import SEED_FILE, create_app

SEED = json.loads(SEED_FILE.read_text(encoding="utf-8"))
MANAGER_B1 = next(r for r in SEED["sales_reps"] if r["branch_id"] == "B1" and r["role"] == "branch_manager")
STRONG = "Str0ng!pass"


@pytest.fixture()
def app(tmp_path: Path):
    settings = load_settings(database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}", jwt_secret="t" * 48,
                             login_rate_limit="1000 per minute", default_rate_limit="10000 per minute",
                             stream_max_seconds=2, stream_poll_seconds=0.2)
    return create_app(settings)


@pytest.fixture()
def client(app):
    return app.test_client()


def login(client, username="Admin", password="Admin$123"):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.get_json()
    return {"Authorization": f"Bearer {r.get_json()['access_token']}"}


@pytest.fixture()
def admin(client):
    return login(client)


@pytest.fixture()
def manager(client, admin):
    client.post("/api/users", headers=admin, json={"username": "mgr.b1", "password": STRONG, "rep_id": MANAGER_B1["id"]})
    return login(client, "mgr.b1", STRONG)


@pytest.fixture()
def rep(client, admin):
    client.post("/api/users", headers=admin, json={"username": "rep13", "password": STRONG, "rep_id": "SR13"})
    return login(client, "rep13", STRONG)
