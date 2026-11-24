"""Use cases. Each public method is one business operation running in one unit of work.

Depends only on the domain and on the ports in ports.py, never on Flask or SQLAlchemy.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, ContextManager, Iterable

from ..domain import access
from ..domain.access import Principal
from ..domain.anomaly.detect import detect
from ..domain.model import (DAY, STALE_DAYS, STUCK_ORDER_DAYS, STATUS_LABEL, Model, build_model, inr, month_label, pct,
                            stale_leads, stuck_orders, ts)
from ..domain.validation import validate_dataset
from .errors import Conflict, Forbidden, Invalid, Locked, NoData, NotFound, Unauthorized
from .serialization import json_and_etag
from .ports import Hasher, LeadQuery, Page, PageRequest, Repos, SnapshotCache, Tokens, UserRecord

ROLE_FROM_REP = {"branch_manager": "manager", "sales_officer": "rep"}
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")


def password_problems(password: str, username: str) -> list[str]:
    """OWASP ASVS-style policy: length first, plus some variety; never the username."""
    problems = []
    if len(password) < 8:
        problems.append("Use at least 8 characters.")
    if len(password) > 128:
        problems.append("Use at most 128 characters.")
    classes = sum(bool(re.search(p, password)) for p in (r"[a-z]", r"[A-Z]", r"\d", r"[^A-Za-z0-9]"))
    if classes < 3:
        problems.append("Mix at least three of: lower-case, upper-case, numbers, symbols.")
    if username and username.lower() in password.lower():
        problems.append("Don't include the username in the password.")
    return problems


@dataclass
class Deps:
    uow: Callable[[], ContextManager[Repos]]
    hasher: Hasher
    tokens: Tokens
    cache: SnapshotCache
    lockout_attempts: int = 5
    lockout_minutes: int = 15


# ---------- Shared data access ----------

class DataAccess:
    """Loads the current dataset once per revision and derives each person's scoped view."""

    def __init__(self, d: Deps):
        self.d = d

    def snapshot(self, r: Repos):
        v = r.datasets.current_version()
        if not v:
            raise NoData("No data has been loaded yet. An administrator needs to upload a file.")
        snap = self.d.cache.get(v.key, r.datasets.load_current)
        return v, snap

    def scope_key(self, p: Principal) -> str:
        return f"{p.role}:{p.branch_id or ''}:{p.rep_id or ''}"

    def scoped(self, snap, p: Principal) -> tuple[dict[str, Any], Model]:
        def compute():
            data = access.scope_dataset(snap.data, p)
            return data, build_model(data, (snap.model.as_of, snap.model.months))
        return self.d.cache.memo(snap, f"scoped:{self.scope_key(p)}", compute)


# ---------- Authentication ----------

class AuthService:
    def __init__(self, d: Deps):
        self.d = d

    def principal(self, u: UserRecord, r: Repos) -> Principal:
        if u.role == "ceo":
            return Principal(u.id, u.username, u.display_name, "ceo")
        rep = r.datasets.get_rep(u.rep_id) if u.rep_id else None
        if not rep:
            # The person behind this login isn't in the current data (e.g. removed by an upload).
            raise Forbidden("Your login isn't linked to anyone in the current data. Ask the administrator.")
        return Principal(u.id, u.username, u.display_name, u.role, rep["id"], rep["branch_id"])  # type: ignore[arg-type]

    def login(self, username: str, password: str, ip: str) -> dict[str, Any]:
        # Failures are recorded and committed first, then raised: a rollback must not erase the lockout count or audit entry.
        failure: Exception | None = None
        with self.d.uow() as r:
            u = r.users.by_username(username)
            now = datetime.now(timezone.utc)
            if u and u.locked_until and u.locked_until > now:
                r.audit.add(u.username, "login", "locked", ip=ip)
                failure = Locked("Too many failed attempts. Try again in a few minutes.")
            elif not self.d.hasher.verify(u.password_hash if u else None, password) or not u or not u.active:
                if u:
                    fails = u.failed_attempts + 1
                    lock = now + timedelta(minutes=self.d.lockout_minutes) if fails >= self.d.lockout_attempts else None
                    r.users.update(u.id, failed_attempts=0 if lock else fails, locked_until=lock)
                r.audit.add(username[:64], "login", "failed", ip=ip)
                failure = Unauthorized("Wrong username or password.")  # same message for every failure (no enumeration)
        if failure:
            raise failure
        with self.d.uow() as r:
            u = r.users.by_username(username)
            p = self.principal(u, r)
            r.users.update(u.id, failed_attempts=0, locked_until=None, last_login_at=now)
            r.audit.add(u.username, "login", "success", ip=ip)
            token, ttl = self.d.tokens.access_token(u.id, u.token_version)
            return {"access_token": token, "token_type": "Bearer", "expires_in": ttl, "user": self.me_payload(p)}

    @staticmethod
    def me_payload(p: Principal) -> dict[str, Any]:
        return {"id": p.user_id, "username": p.username, "display_name": p.display_name, "role": p.role,
                "rep_id": p.rep_id, "branch_id": p.branch_id}

    def authenticate(self, token: str, audience: str = "access") -> Principal:
        claims = self.d.tokens.decode(token, audience)
        with self.d.uow() as r:
            u = r.users.get(int(claims["sub"]))
            if not u or not u.active or u.token_version != claims.get("ver"):
                raise Unauthorized("Your session has ended. Sign in again.")
            return self.principal(u, r)

    def refresh(self, p: Principal) -> dict[str, Any]:
        with self.d.uow() as r:
            u = r.users.get(p.user_id)
            token, ttl = self.d.tokens.access_token(u.id, u.token_version)
            return {"access_token": token, "token_type": "Bearer", "expires_in": ttl}

    def logout(self, p: Principal, ip: str) -> None:
        with self.d.uow() as r:
            u = r.users.get(p.user_id)
            r.users.update(u.id, token_version=u.token_version + 1)  # revokes every token issued so far
            r.audit.add(u.username, "logout", "success", ip=ip)

    def change_password(self, p: Principal, current: str, new: str, ip: str) -> None:
        with self.d.uow() as r:
            u = r.users.get(p.user_id)
            wrong = not self.d.hasher.verify(u.password_hash, current)
            if wrong:
                r.audit.add(u.username, "password_change", "failed", ip=ip)
        if wrong:
            raise Unauthorized("Your current password is wrong.")
        with self.d.uow() as r:
            u = r.users.get(p.user_id)
            problems = password_problems(new, u.username)
            if problems:
                raise Invalid("Choose a stronger password.", problems)
            r.users.update(u.id, password_hash=self.d.hasher.hash(new), token_version=u.token_version + 1)
            r.audit.add(u.username, "password_change", "success", ip=ip)

    def stream_ticket(self, p: Principal) -> dict[str, Any]:
        with self.d.uow() as r:
            u = r.users.get(p.user_id)
            ticket, ttl = self.d.tokens.stream_ticket(u.id, u.token_version)
            return {"ticket": ticket, "expires_in": ttl}


# ---------- User administration (leadership only) ----------

class UserService:
    def __init__(self, d: Deps):
        self.d = d

    @staticmethod
    def _require_admin(p: Principal) -> None:
        if p.role != "ceo":
            raise Forbidden("Only leadership can manage logins.")

    def list(self, p: Principal, page: PageRequest, search: str | None, role: str | None) -> Page:
        self._require_admin(p)
        with self.d.uow() as r:
            users, total = r.users.list(page, search, role)
            return Page([u.public() for u in users], page.page, page.page_size, total)

    def candidates(self, p: Principal, page: PageRequest, branch_id: str | None, search: str | None) -> Page:
        """People in the current data who don't have a login yet."""
        self._require_admin(p)
        with self.d.uow() as r:
            taken = r.users.rep_ids_with_login()
            snap = DataAccess(self.d).snapshot(r)[1]
            people = [{**rep, "branch_name": snap.model.branch_by_id.get(rep["branch_id"], {}).get("name"),
                       "login_role": ROLE_FROM_REP[rep["role"]]}
                      for rep in snap.data["sales_reps"] if rep["id"] not in taken
                      and (not branch_id or rep["branch_id"] == branch_id)
                      and (not search or search.lower() in rep["name"].lower())]
            return Page(people[page.offset:page.offset + page.page_size], page.page, page.page_size, len(people))

    def create(self, p: Principal, body: dict[str, Any], ip: str) -> dict[str, Any]:
        self._require_admin(p)
        username = body["username"].strip().lower()
        if not USERNAME_RE.match(username):
            raise Invalid("Usernames are 3–32 characters: letters, numbers, dot, dash or underscore.")
        problems = password_problems(body["password"], username)
        if problems:
            raise Invalid("Choose a stronger password.", problems)
        with self.d.uow() as r:
            if r.users.by_username(username):
                raise Conflict("That username is already taken.")
            if body.get("role") == "ceo":
                fields = dict(role="ceo", display_name=body.get("display_name") or username, rep_id=None, branch_id=None)
            elif body.get("rep_id"):
                rep = r.datasets.get_rep(body["rep_id"])
                if not rep:
                    raise NotFound("That person isn't in the current data.")
                if rep["id"] in r.users.rep_ids_with_login():
                    raise Conflict(f"{rep['name']} already has a login.")
                fields = dict(role=ROLE_FROM_REP[rep["role"]], display_name=rep["name"], rep_id=rep["id"], branch_id=rep["branch_id"])
            elif body.get("new_person"):
                np = body["new_person"]
                if not r.datasets.branch_exists(np["branch_id"]):
                    raise NotFound("That branch isn't in the current data.")
                DataAccess(self.d).snapshot(r)  # requires data to exist
                rep = {"id": r.datasets.next_rep_id(), "name": np["name"].strip(), "branch_id": np["branch_id"],
                       "role": np["role"], "joined": datetime.now(timezone.utc).date().isoformat()}
                r.datasets.add_person(rep)
                fields = dict(role=ROLE_FROM_REP[rep["role"]], display_name=rep["name"], rep_id=rep["id"], branch_id=rep["branch_id"])
            else:
                raise Invalid("Pick an existing person, add a new person, or create a leadership login.")
            u = r.users.create(username=username, password_hash=self.d.hasher.hash(body["password"]), created_by=p.username, **fields)
            r.audit.add(p.username, "user_create", "success", target=username, ip=ip, detail={"role": u.role, "rep_id": u.rep_id})
            return u.public()

    def update(self, p: Principal, user_id: int, body: dict[str, Any], ip: str) -> dict[str, Any]:
        self._require_admin(p)
        with self.d.uow() as r:
            u = r.users.get(user_id)
            if not u:
                raise NotFound("No such login.")
            changes: dict[str, Any] = {}
            if "active" in body:
                if u.id == p.user_id and not body["active"]:
                    raise Invalid("You can't deactivate your own login.")
                changes["active"] = body["active"]
                changes["token_version"] = u.token_version + 1
            if body.get("password"):
                problems = password_problems(body["password"], u.username)
                if problems:
                    raise Invalid("Choose a stronger password.", problems)
                changes.update(password_hash=self.d.hasher.hash(body["password"]), token_version=u.token_version + 1,
                               failed_attempts=0, locked_until=None)
            if body.get("unlock"):
                changes.update(failed_attempts=0, locked_until=None)
            if body.get("display_name"):
                changes["display_name"] = body["display_name"].strip()
            u = r.users.update(user_id, **changes)
            r.audit.add(p.username, "user_update", "success", target=u.username, ip=ip,
                        detail={k: (v if k != "password_hash" else "changed") for k, v in changes.items() if k != "token_version"})
            return u.public()

    def delete(self, p: Principal, user_id: int, ip: str) -> None:
        self._require_admin(p)
        if user_id == p.user_id:
            raise Invalid("You can't delete your own login.")
        with self.d.uow() as r:
            u = r.users.get(user_id)
            if not u:
                raise NotFound("No such login.")
            r.users.delete(user_id)
            r.audit.add(p.username, "user_delete", "success", target=u.username, ip=ip)


# ---------- Dataset ----------

class DatasetService:
    def __init__(self, d: Deps):
        self.d = d
        self.da = DataAccess(d)

    def info(self, p: Principal) -> dict[str, Any]:
        with self.d.uow() as r:
            v = r.datasets.current_version()
            if not v:
                return {"loaded": False}
            snap = self.d.cache.get(v.key, r.datasets.load_current)
            # The dataset's "today" and month list come from the full file, so every role measures staleness the same way.
            out = {"loaded": True, "version": v.key, "uploaded_at": v.uploaded_at.isoformat(),
                   "as_of": int(snap.model.as_of * 1000), "months": snap.model.months}
            if p.role == "ceo":  # who uploaded what, and full counts, are leadership information
                out.update(uploaded_by=v.uploaded_by, source_name=v.source_name, counts=v.counts)
            return out

    def scoped(self, p: Principal) -> tuple[dict[str, Any], str]:
        with self.d.uow() as r:
            v, snap = self.da.snapshot(r)
        return self.d.cache.memo(snap, f"json:{self.da.scope_key(p)}", lambda: json_and_etag(self.da.scoped(snap, p)[0]))

    def upload(self, p: Principal, data: Any, source_name: str, ip: str) -> dict[str, Any]:
        if p.role != "ceo":
            raise Forbidden("Only leadership can upload data.")
        result = validate_dataset(data)
        if not result.ok:
            with self.d.uow() as r:
                r.audit.add(p.username, "dataset_upload", "rejected", target=source_name, ip=ip, detail={"errors": result.error_count})
            raise Invalid("The file has problems to fix before it can be used.", result.to_dict())
        with self.d.uow() as r:
            v = r.datasets.replace(data, source_name, p.username)
            orphaned = [u.username for u in r.users.list(PageRequest(1, 10_000), None, None)[0]
                        if u.rep_id and not r.datasets.get_rep(u.rep_id)]
            r.audit.add(p.username, "dataset_upload", "success", target=source_name, ip=ip,
                        detail={"version": v.key, "counts": v.counts, "unlinked_logins": orphaned})
        return {"version": v.key, "counts": v.counts, "warnings": result.to_dict()["warnings"],
                "unlinked_logins": orphaned}


# ---------- Paginated reads ----------

class QueryService:
    def __init__(self, d: Deps):
        self.d = d

    @staticmethod
    def _scope(p: Principal) -> tuple[str | None, str | None]:
        if p.role == "ceo":
            return None, None
        if p.role == "manager":
            return p.branch_id, None
        return None, p.rep_id

    def leads(self, p: Principal, q: LeadQuery, page: PageRequest) -> Page:
        sb, sr = self._scope(p)
        q = LeadQuery(**{**q.__dict__, "scope_branch": sb, "scope_rep": sr})
        with self.d.uow() as r:
            DataAccess(self.d).snapshot(r)
            rows, total = r.datasets.list_leads(q, page)
        return Page([access.project_lead(p, l, include_history=False) for l in rows], page.page, page.page_size, total)

    def lead(self, p: Principal, lead_id: str) -> dict[str, Any]:
        with self.d.uow() as r:
            l = r.datasets.get_lead(lead_id)
        if not l or not access.can_see_lead(p, l):
            raise NotFound("No such lead.")  # 404, not 403: don't confirm that records outside your scope exist
        return access.project_lead(p, l)

    def table(self, p: Principal, name: str, page: PageRequest, search: str | None = None) -> Page:
        if name == "targets" and not access.sees_targets(p):
            return Page([], page.page, page.page_size, 0)
        sb, sr = self._scope(p)
        if p.role == "rep" and name == "branches":
            sb = p.branch_id
        with self.d.uow() as r:
            DataAccess(self.d).snapshot(r)
            rows, total = r.datasets.list_table(name, sb, sr, page, search)
        if name == "sales_reps":
            rows = [access.project_rep(p, x) for x in rows]
        return Page(rows, page.page, page.page_size, total)

    def audit(self, p: Principal, page: PageRequest, action: str | None) -> Page:
        if p.role != "ceo":
            raise Forbidden("Only leadership can see the audit log.")
        with self.d.uow() as r:
            rows, total = r.audit.list(page, action)
        return Page(rows, page.page, page.page_size, total)


# ---------- Anomalies and reviews ----------

class AnomalyService:
    def __init__(self, d: Deps):
        self.d = d
        self.da = DataAccess(d)

    def _live(self, snap, p: Principal) -> list[dict[str, Any]]:
        def compute():
            model = self.da.scoped(snap, p)[1]
            return [f.to_dict() for f in detect(model)]
        return self.d.cache.memo(snap, f"findings:{self.da.scope_key(p)}", compute)

    def _known(self, r: Repos, p: Principal) -> tuple[Any, list[dict[str, Any]], dict[str, dict[str, Any]], set[str]]:
        v, snap = self.da.snapshot(r)
        live = self._live(snap, p)
        reviews = r.reviews.all(v.id)
        live_ids = {a["id"] for a in live}
        decided = [rv["snapshot"] for aid, rv in reviews.items() if aid not in live_ids and rv.get("snapshot")]
        visible = [a for a in live + decided
                   if access.finding_visible(p, a.get("branchId"), a.get("repId"), reviews.get(a["id"], {}).get("decision") == "confirmed")]
        return v, visible, reviews, live_ids

    def _decorate(self, a: dict[str, Any], reviews: dict, live_ids: set[str], p: Principal) -> dict[str, Any]:
        rv = reviews.get(a["id"])
        return {**a, "status": rv["decision"] if rv else "flagged",
                "review": {k: rv[k] for k in ("decision", "note", "by", "role", "at")} if rv else None,
                "can_review": a["id"] in live_ids and access.can_review(p, a.get("branchId"))}

    def list(self, p: Principal, page: PageRequest, status: str | None, category: str | None, branch_id: str | None) -> dict[str, Any]:
        with self.d.uow() as r:
            _, visible, reviews, live_ids = self._known(r, p)
        items = [self._decorate(a, reviews, live_ids, p) for a in visible]
        counts = {s: sum(1 for a in items if a["status"] == s) for s in ("flagged", "confirmed", "dismissed")}
        if status:
            items = [a for a in items if a["status"] == status]
        if category:
            items = [a for a in items if a["category"] == category]
        if branch_id and p.role == "ceo":
            items = [a for a in items if a.get("branchId") == branch_id]
        return {**Page(items[page.offset:page.offset + page.page_size], page.page, page.page_size, len(items)).to_dict(), "counts": counts}

    def get(self, p: Principal, anomaly_id: str) -> dict[str, Any]:
        with self.d.uow() as r:
            v, visible, reviews, live_ids = self._known(r, p)
            a = next((x for x in visible if x["id"] == anomaly_id), None)
            if not a:
                raise NotFound("No such finding.")
            return {**self._decorate(a, reviews, live_ids, p), "history": r.reviews.events(v.id, anomaly_id)}

    def review(self, p: Principal, anomaly_id: str, decision: str | None, note: str, ip: str) -> dict[str, Any]:
        with self.d.uow() as r:
            v, visible, reviews, live_ids = self._known(r, p)
            a = next((x for x in visible if x["id"] == anomaly_id), None)
            if not a:
                raise NotFound("No such finding.")
            if anomaly_id not in live_ids or not access.can_review(p, a.get("branchId")):
                raise Forbidden("You can't review this finding.")
            now = datetime.now(timezone.utc)
            if decision is None:
                if anomaly_id not in reviews:
                    raise Invalid("This finding hasn't been reviewed yet.")
                r.reviews.delete(v.id, anomaly_id)
            else:
                r.reviews.upsert(v.id, anomaly_id, decision=decision, note=note, by_user_id=p.user_id, by_name=p.display_name,
                                 role=p.role, at=now, branch_id=a.get("branchId"), rep_id=a.get("repId"), snapshot=a)
            r.reviews.add_event(v.id, anomaly_id, decision=decision or "reopened", note=note, by_name=p.display_name, role=p.role, at=now)
            r.audit.add(p.username, "anomaly_review", "success", target=anomaly_id, ip=ip, detail={"decision": decision or "reopened"})
        return self.get(p, anomaly_id)


# ---------- Notifications ----------

@dataclass(frozen=True)
class Notice:
    id: str
    severity: str
    title: str
    body: str
    href: str
    at: int  # epoch ms

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


class NotificationService:
    def __init__(self, d: Deps):
        self.d = d
        self.da = DataAccess(d)
        self.anomalies = AnomalyService(d)

    def _compute(self, r: Repos, p: Principal) -> list[Notice]:
        v, snap = self.da.snapshot(r)
        m = self.da.scoped(snap, p)[1]
        at = int(m.as_of * 1000)
        out: list[Notice] = []
        _, visible, reviews, live_ids = self.anomalies._known(r, p)
        pending = [a for a in visible if a["id"] not in reviews and a["id"] in live_ids and access.can_review(p, a.get("branchId"))]
        if pending:
            out.append(Notice(f"anomaly-review:{v.id}:{'|'.join(sorted(a['id'] for a in pending))}", "warning",
                              f"{len(pending)} unusual pattern{'s' if len(pending) > 1 else ''} waiting for your review",
                              "Numbers that are too far from normal to be chance. Confirm the real problems and dismiss the rest.",
                              "/dashboard/anomalies", at))
        if p.role != "ceo":
            for a in visible:
                rv = reviews.get(a["id"])
                if rv and rv["decision"] == "confirmed":
                    out.append(Notice(f"anomaly-confirmed:{v.id}:{a['id']}", "critical", f"Confirmed: {a['title']}",
                                      f"{rv['by']} confirmed this is a real problem." + (f" “{rv['note']}”" if rv["note"] else ""),
                                      a.get("href") or "/dashboard/anomalies?tab=confirmed", at))
        if p.role == "rep":
            out += self._rep_notices(m, p, at)
        else:
            out += self._lead_notices(m, p, at)
        rank = {"critical": 0, "warning": 1, "info": 2}
        return sorted(out, key=lambda n: (rank[n.severity], -n.at))[:200]

    def _rep_notices(self, m: Model, p: Principal, at: int) -> list[Notice]:
        out = []
        for l in stuck_orders(m):
            days = int((m.as_of - (l.order_at or m.as_of)) / DAY)
            out.append(Notice(f"stuck:{l.id}", "critical", f"{l.customer_name}'s {l.model_interested} hasn't been delivered",
                              f"Ordered {days} days ago. Check allocation and finance, then update the customer.",
                              f"/dashboard/followups?rep={p.rep_id}&view=orders", int((l.order_at or m.as_of) * 1000)))
        for l in stale_leads(m):
            out.append(Notice(f"stale:{l.id}", "critical" if l.days_since_activity >= 14 else "warning", f"Follow up with {l.customer_name}",
                              f"{l.model_interested} · {STATUS_LABEL[l.status]} · no contact for {int(l.days_since_activity)} days.",
                              f"/dashboard/followups?rep={p.rep_id}", int(l.last_activity * 1000)))
        for l in m.leads:
            if l.status == "new" and 1 <= l.days_since_activity < STALE_DAYS:
                out.append(Notice(f"new:{l.id}", "info", f"New lead waiting for a first call: {l.customer_name}",
                                  f"Interested in the {l.model_interested} ({l.source.replace('_', ' ')}).",
                                  f"/dashboard/rep/{p.rep_id}", int(l.created * 1000)))
        return out

    def _lead_notices(self, m: Model, p: Principal, at: int) -> list[Notice]:
        out = []
        last = m.months[-1]
        home = f"/dashboard/branch/{p.branch_id}" if p.role == "manager" else "/dashboard"
        qs = f"?branch={p.branch_id}" if p.role == "manager" else ""
        stale, stuck = stale_leads(m), stuck_orders(m)
        if stale:
            out.append(Notice(f"stale-summary:{last}:{len(stale)}", "critical" if len(stale) >= 5 else "warning",
                              f"{len(stale)} customer{'s' if len(stale) > 1 else ''} not contacted for {STALE_DAYS}+ days",
                              f"Their deals are worth {inr(sum(l.deal_value for l in stale))}. Call them today, before they buy somewhere else.",
                              f"/dashboard/followups{qs}", at))
        if stuck:
            out.append(Notice(f"stuck-summary:{last}:{len(stuck)}", "critical",
                              f"{len(stuck)} car{'s' if len(stuck) > 1 else ''} ordered over {STUCK_ORDER_DAYS} days ago and not yet delivered",
                              f"{inr(sum(l.deal_value for l in stuck))} of sales waiting. Check stock allocation and finance with operations.",
                              f"/dashboard/followups{qs}{'&' if qs else '?'}view=orders", at))
        for b in m.branches:
            t = next((x for x in m.targets if x["branch_id"] == b["id"] and x["month"] == last), None)
            if not t:
                continue
            orders = sum(1 for l in m.leads if l.branch_id == b["id"] and l.order_month == last)
            if orders / t["target_units"] < 0.5:
                out.append(Notice(f"behind:{b['id']}:{last}", "warning",
                                  f"{b['name']} reached {round(orders / t['target_units'] * 100)}% of its {month_label(last)} target",
                                  f"{orders} of {t['target_units']} cars. Go through the customers in progress"
                                  + (" with the branch manager." if p.role == "ceo" else "."),
                                  f"/dashboard/branch/{b['id']}", at))
        if p.role == "manager":
            per_rep: dict[str, int] = {}
            for l in stale:
                per_rep[l.assigned_to] = per_rep.get(l.assigned_to, 0) + 1
            for rid, n in per_rep.items():
                if n >= 2:
                    out.append(Notice(f"repstale:{rid}:{n}", "warning", f"{m.rep_by_id.get(rid, {}).get('name', rid)} has {n} leads going cold",
                                      "No contact in over a week. A quick check-in could save these deals.", f"/dashboard/rep/{rid}", at))
        return out

    def list(self, p: Principal, page: PageRequest, unread_only: bool) -> dict[str, Any]:
        with self.d.uow() as r:
            notices = self._compute(r, p)
            read = r.reads.read_ids(p.user_id)
        items = [{**n.to_dict(), "read": n.id in read} for n in notices if not (unread_only and n.id in read)]
        return {**Page(items[page.offset:page.offset + page.page_size], page.page, page.page_size, len(items)).to_dict(),
                "unread": sum(1 for n in notices if n.id not in read)}

    def mark_read(self, p: Principal, ids: Iterable[str]) -> int:
        with self.d.uow() as r:
            valid = {n.id for n in self._compute(r, p)}
            chosen = [i for i in ids if i in valid]  # only your own notifications can be marked
            r.reads.mark(p.user_id, chosen)
            return len(chosen)

    def state(self, p: Principal) -> tuple[str, list[dict[str, Any]]]:
        """(change stamp, unread notices) for the stream to compare between polls."""
        with self.d.uow() as r:
            v = r.datasets.current_version()
            if not v:
                return "none", []
            stamp = f"{v.key}:{r.reviews.stamp(v.id)}"
            notices = self._compute(r, p)
            read = r.reads.read_ids(p.user_id)
            return stamp, [n.to_dict() for n in notices if n.id not in read]
