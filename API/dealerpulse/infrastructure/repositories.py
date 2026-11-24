"""SQLAlchemy implementations of the application ports. All queries are parameterised (no string-built SQL)."""
from __future__ import annotations

import hashlib
from contextlib import AbstractContextManager
from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from ..application.ports import LeadQuery, PageRequest, UserRecord, VersionInfo
from ..domain.model import ts
from .db import (AnomalyReview, AnomalyReviewEvent, AuditLog, BranchRow, DatasetVersion, DeliveryRow, LeadRow,
                 NotificationRead, SalesRepRow, TargetRow, UserRow)

_SORTS = {
    "created_at": LeadRow.created_ts.asc(), "-created_at": LeadRow.created_ts.desc(),
    "last_activity_at": LeadRow.last_activity_ts.asc(), "-last_activity_at": LeadRow.last_activity_ts.desc(),
    "deal_value": LeadRow.deal_value.asc(), "-deal_value": LeadRow.deal_value.desc(),
}


def _like(term: str) -> str:
    # Escape LIKE wildcards so user input can only match literally.
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _lead_dict(r: LeadRow) -> dict[str, Any]:
    return {"id": r.id, "customer_name": r.customer_name, "phone": r.phone, "source": r.source,
            "model_interested": r.model_interested, "status": r.status, "assigned_to": r.assigned_to,
            "branch_id": r.branch_id, "created_at": r.created_at, "last_activity_at": r.last_activity_at,
            "status_history": r.status_history, "expected_close_date": r.expected_close_date,
            "deal_value": _num(r.deal_value), "lost_reason": r.lost_reason}


def _num(v: float) -> int | float:
    return int(v) if float(v).is_integer() else v


class SqlDatasetRepo:
    def __init__(self, s: Session):
        self.s = s

    def current_version(self) -> VersionInfo | None:
        v = self.s.scalars(select(DatasetVersion).where(DatasetVersion.is_current.is_(True))).first()
        return VersionInfo(v.id, v.uploaded_at, v.uploaded_by, v.source_name, v.counts, v.revision or 0) if v else None

    def load_current(self) -> dict[str, Any] | None:
        v = self.s.scalars(select(DatasetVersion).where(DatasetVersion.is_current.is_(True))).first()
        if not v:
            return None
        return {
            "metadata": v.meta or {},
            "branches": [{"id": b.id, "name": b.name, "city": b.city} for b in self.s.scalars(select(BranchRow).order_by(BranchRow.id))],
            "sales_reps": [{"id": r.id, "name": r.name, "branch_id": r.branch_id, "role": r.role, "joined": r.joined}
                           for r in self.s.scalars(select(SalesRepRow).order_by(SalesRepRow.id))],
            "leads": [_lead_dict(l) for l in self.s.scalars(select(LeadRow).order_by(LeadRow.id))],
            "targets": [{"branch_id": t.branch_id, "month": t.month, "target_units": _num(t.target_units),
                         "target_revenue": _num(t.target_revenue)} for t in self.s.scalars(select(TargetRow).order_by(TargetRow.branch_id, TargetRow.month))],
            "deliveries": [{"lead_id": d.lead_id, "order_date": d.order_date, "delivery_date": d.delivery_date,
                            "days_to_deliver": _num(d.days_to_deliver), "delay_reason": d.delay_reason}
                           for d in self.s.scalars(select(DeliveryRow).order_by(DeliveryRow.lead_id))],
        }

    def replace(self, data: dict[str, Any], source_name: str, uploaded_by: str) -> VersionInfo:
        # People added by an administrator survive an upload when their branch still exists.
        keep = [dict(id=r.id, name=r.name, branch_id=r.branch_id, role=r.role, joined=r.joined)
                for r in self.s.scalars(select(SalesRepRow).where(SalesRepRow.id.like("ADM-%")))]
        for table in (DeliveryRow, LeadRow, TargetRow, SalesRepRow, BranchRow):
            self.s.execute(delete(table))
        self.s.add_all(BranchRow(**b) for b in data["branches"])
        file_reps = {r["id"] for r in data["sales_reps"]}
        branch_ids = {b["id"] for b in data["branches"]}
        self.s.add_all(SalesRepRow(id=r["id"], name=r["name"], branch_id=r["branch_id"], role=r["role"], joined=r["joined"])
                       for r in data["sales_reps"])
        self.s.add_all(SalesRepRow(**r) for r in keep if r["id"] not in file_reps and r["branch_id"] in branch_ids)
        self.s.flush()
        self.s.add_all(LeadRow(
            id=l["id"], customer_name=l["customer_name"], phone=l["phone"], source=l["source"],
            model_interested=l["model_interested"], status=l["status"],
            current_status=l["status_history"][-1]["status"] if l["status_history"] else l["status"],
            assigned_to=l["assigned_to"], branch_id=l["branch_id"], created_at=l["created_at"], created_ts=ts(l["created_at"]),
            last_activity_at=l["last_activity_at"], last_activity_ts=ts(l["last_activity_at"]),
            expected_close_date=l.get("expected_close_date"), deal_value=l["deal_value"], lost_reason=l.get("lost_reason"),
            status_history=l["status_history"]) for l in data["leads"])
        self.s.flush()
        self.s.add_all(TargetRow(**t) for t in data["targets"])
        self.s.add_all(DeliveryRow(**d) for d in data["deliveries"])
        self.s.execute(DatasetVersion.__table__.update().values(is_current=False))
        v = DatasetVersion(uploaded_by=uploaded_by, source_name=source_name[:255], meta=data.get("metadata") or {},
                           counts={k: len(data[k]) for k in ("branches", "sales_reps", "leads", "targets", "deliveries")},
                           is_current=True)
        self.s.add(v)
        self.s.flush()
        return VersionInfo(v.id, v.uploaded_at, v.uploaded_by, v.source_name, v.counts)

    def add_person(self, rep: dict[str, Any]) -> None:
        self.s.add(SalesRepRow(**rep))
        v = self.s.scalars(select(DatasetVersion).where(DatasetVersion.is_current.is_(True))).first()
        if v:
            v.revision = (v.revision or 0) + 1
            v.counts = {**v.counts, "sales_reps": v.counts.get("sales_reps", 0) + 1}
        self.s.flush()

    def next_rep_id(self) -> str:
        n = self.s.scalar(select(func.count()).select_from(SalesRepRow).where(SalesRepRow.id.like("ADM-%"))) or 0
        while self.s.get(SalesRepRow, f"ADM-{n + 1:03d}"):
            n += 1
        return f"ADM-{n + 1:03d}"

    def branch_exists(self, branch_id: str) -> bool:
        return self.s.get(BranchRow, branch_id) is not None

    def get_rep(self, rep_id: str) -> dict[str, Any] | None:
        r = self.s.get(SalesRepRow, rep_id)
        return {"id": r.id, "name": r.name, "branch_id": r.branch_id, "role": r.role, "joined": r.joined} if r else None

    def list_leads(self, q: LeadQuery, page: PageRequest) -> tuple[list[dict[str, Any]], int]:
        stmt = select(LeadRow)
        if q.scope_branch:
            stmt = stmt.where(LeadRow.branch_id == q.scope_branch)
        if q.scope_rep:
            stmt = stmt.where(LeadRow.assigned_to == q.scope_rep)
        if q.branch_id:
            stmt = stmt.where(LeadRow.branch_id == q.branch_id)
        if q.rep_id:
            stmt = stmt.where(LeadRow.assigned_to == q.rep_id)
        if q.status:
            stmt = stmt.where(LeadRow.current_status == q.status)
        if q.source:
            stmt = stmt.where(LeadRow.source == q.source)
        if q.search:
            stmt = stmt.where(or_(LeadRow.customer_name.ilike(_like(q.search), escape="\\"), LeadRow.id.ilike(_like(q.search), escape="\\")))
        if q.created_from is not None:
            stmt = stmt.where(LeadRow.created_ts >= q.created_from)
        if q.created_to is not None:
            stmt = stmt.where(LeadRow.created_ts < q.created_to)
        total = self.s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = self.s.scalars(stmt.order_by(_SORTS[q.sort], LeadRow.id).offset(page.offset).limit(page.page_size))
        return [_lead_dict(r) for r in rows], total

    def get_lead(self, lead_id: str) -> dict[str, Any] | None:
        r = self.s.get(LeadRow, lead_id)
        return _lead_dict(r) if r else None

    def list_table(self, table: str, scope_branch: str | None, scope_rep: str | None, page: PageRequest,
                   search: str | None = None) -> tuple[list[dict[str, Any]], int]:
        if table == "branches":
            stmt = select(BranchRow)
            if scope_branch:
                stmt = stmt.where(BranchRow.id == scope_branch)
            if search:
                stmt = stmt.where(or_(BranchRow.name.ilike(_like(search), escape="\\"), BranchRow.city.ilike(_like(search), escape="\\")))
            order, conv = BranchRow.id, lambda b: {"id": b.id, "name": b.name, "city": b.city}
        elif table == "sales_reps":
            stmt = select(SalesRepRow)
            if scope_branch:
                stmt = stmt.where(SalesRepRow.branch_id == scope_branch)
            if scope_rep:
                stmt = stmt.where(SalesRepRow.id == scope_rep)
            if search:
                stmt = stmt.where(SalesRepRow.name.ilike(_like(search), escape="\\"))
            order, conv = SalesRepRow.id, lambda r: {"id": r.id, "name": r.name, "branch_id": r.branch_id, "role": r.role, "joined": r.joined}
        elif table == "targets":
            stmt = select(TargetRow)
            if scope_branch:
                stmt = stmt.where(TargetRow.branch_id == scope_branch)
            order, conv = TargetRow.month, lambda t: {"branch_id": t.branch_id, "month": t.month, "target_units": _num(t.target_units), "target_revenue": _num(t.target_revenue)}
        elif table == "deliveries":
            stmt = select(DeliveryRow).join(LeadRow, LeadRow.id == DeliveryRow.lead_id)
            if scope_branch:
                stmt = stmt.where(LeadRow.branch_id == scope_branch)
            if scope_rep:
                stmt = stmt.where(LeadRow.assigned_to == scope_rep)
            order, conv = DeliveryRow.delivery_date.desc(), lambda d: {"lead_id": d.lead_id, "order_date": d.order_date, "delivery_date": d.delivery_date, "days_to_deliver": _num(d.days_to_deliver), "delay_reason": d.delay_reason}
        else:
            raise ValueError(table)
        total = self.s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        return [conv(r) for r in self.s.scalars(stmt.order_by(order).offset(page.offset).limit(page.page_size))], total


def _user(u: UserRow) -> UserRecord:
    def aware(d: datetime | None) -> datetime | None:
        return d.replace(tzinfo=timezone.utc) if d and d.tzinfo is None else d  # SQLite drops tzinfo
    return UserRecord(u.id, u.username, u.display_name, u.password_hash, u.role, u.rep_id, u.branch_id, u.active,
                      u.failed_attempts, aware(u.locked_until), u.token_version, aware(u.created_at), u.created_by,
                      aware(u.last_login_at))


class SqlUserRepo:
    def __init__(self, s: Session):
        self.s = s

    def get(self, user_id: int) -> UserRecord | None:
        u = self.s.get(UserRow, user_id)
        return _user(u) if u else None

    def by_username(self, username: str) -> UserRecord | None:
        u = self.s.scalars(select(UserRow).where(UserRow.username == username.strip().lower())).first()
        return _user(u) if u else None

    def list(self, page: PageRequest, search: str | None, role: str | None) -> tuple[list[UserRecord], int]:
        stmt = select(UserRow)
        if search:
            stmt = stmt.where(or_(UserRow.username.ilike(_like(search), escape="\\"), UserRow.display_name.ilike(_like(search), escape="\\")))
        if role:
            stmt = stmt.where(UserRow.role == role)
        total = self.s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = self.s.scalars(stmt.order_by(UserRow.id).offset(page.offset).limit(page.page_size))
        return [_user(u) for u in rows], total

    def rep_ids_with_login(self) -> set[str]:
        return {r for r in self.s.scalars(select(UserRow.rep_id).where(UserRow.rep_id.is_not(None)))}

    def create(self, **fields: Any) -> UserRecord:
        u = UserRow(**fields)
        self.s.add(u)
        self.s.flush()
        return _user(u)

    def update(self, user_id: int, **fields: Any) -> UserRecord:
        u = self.s.get(UserRow, user_id)
        for k, v in fields.items():
            setattr(u, k, v)
        self.s.flush()
        return _user(u)

    def delete(self, user_id: int) -> None:
        self.s.execute(delete(NotificationRead).where(NotificationRead.user_id == user_id))
        self.s.execute(delete(UserRow).where(UserRow.id == user_id))

    def count(self) -> int:
        return self.s.scalar(select(func.count()).select_from(UserRow)) or 0


class SqlReadRepo:
    def __init__(self, s: Session):
        self.s = s

    def read_ids(self, user_id: int) -> set[str]:
        return set(self.s.scalars(select(NotificationRead.notice_id).where(NotificationRead.user_id == user_id)))

    def mark(self, user_id: int, ids: Iterable[str]) -> None:
        have = self.read_ids(user_id)
        self.s.add_all(NotificationRead(user_id=user_id, notice_id=i) for i in set(ids) - have)


class SqlReviewRepo:
    def __init__(self, s: Session):
        self.s = s

    def all(self, version_id: int) -> dict[str, dict[str, Any]]:
        out = {}
        for r in self.s.scalars(select(AnomalyReview).where(AnomalyReview.version_id == version_id)):
            out[r.anomaly_id] = {"decision": r.decision, "note": r.note, "by": r.by_name, "role": r.role,
                                 "at": r.at.replace(tzinfo=r.at.tzinfo or timezone.utc).isoformat(), "branchId": r.branch_id,
                                 "repId": r.rep_id, "snapshot": r.snapshot}
        return out

    def upsert(self, version_id: int, anomaly_id: str, **fields: Any) -> None:
        row = self.s.get(AnomalyReview, (version_id, anomaly_id))
        if row:
            for k, v in fields.items():
                setattr(row, k, v)
        else:
            self.s.add(AnomalyReview(version_id=version_id, anomaly_id=anomaly_id, **fields))

    def delete(self, version_id: int, anomaly_id: str) -> None:
        self.s.execute(delete(AnomalyReview).where(AnomalyReview.version_id == version_id, AnomalyReview.anomaly_id == anomaly_id))

    def add_event(self, version_id: int, anomaly_id: str, **fields: Any) -> None:
        self.s.add(AnomalyReviewEvent(version_id=version_id, anomaly_id=anomaly_id, **fields))

    def events(self, version_id: int, anomaly_id: str) -> list[dict[str, Any]]:
        rows = self.s.scalars(select(AnomalyReviewEvent).where(AnomalyReviewEvent.version_id == version_id,
                                                               AnomalyReviewEvent.anomaly_id == anomaly_id).order_by(AnomalyReviewEvent.id))
        return [{"decision": e.decision, "note": e.note, "by": e.by_name, "role": e.role,
                 "at": e.at.replace(tzinfo=e.at.tzinfo or timezone.utc).isoformat()} for e in rows]

    def stamp(self, version_id: int) -> str:
        """Changes whenever any review changes; used by the notification stream to notice updates."""
        n, last = self.s.execute(select(func.count(AnomalyReviewEvent.id), func.max(AnomalyReviewEvent.id))
                                 .where(AnomalyReviewEvent.version_id == version_id)).one()
        return hashlib.sha1(f"{version_id}:{n}:{last}".encode()).hexdigest()[:12]


class SqlAuditRepo:
    def __init__(self, s: Session):
        self.s = s

    def add(self, actor: str, action: str, outcome: str, target: str = "", ip: str = "", detail: dict | None = None) -> None:
        self.s.add(AuditLog(actor=actor[:64], action=action, outcome=outcome, target=target[:200], ip=ip[:64], detail=detail or {}))

    def list(self, page: PageRequest, action: str | None) -> tuple[list[dict[str, Any]], int]:
        stmt = select(AuditLog)
        if action:
            stmt = stmt.where(AuditLog.action == action)
        total = self.s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        rows = self.s.scalars(stmt.order_by(AuditLog.id.desc()).offset(page.offset).limit(page.page_size))
        return [{"id": a.id, "at": a.at.replace(tzinfo=a.at.tzinfo or timezone.utc).isoformat(), "actor": a.actor,
                 "action": a.action, "target": a.target, "outcome": a.outcome, "ip": a.ip, "detail": a.detail} for a in rows], total


class UnitOfWork(AbstractContextManager):
    """One session and transaction per use case; commits on success, rolls back on any error."""

    def __init__(self, factory: sessionmaker):
        self._factory = factory

    def __enter__(self) -> "UnitOfWork":
        self.session = self._factory()
        self.datasets = SqlDatasetRepo(self.session)
        self.users = SqlUserRepo(self.session)
        self.reads = SqlReadRepo(self.session)
        self.reviews = SqlReviewRepo(self.session)
        self.audit = SqlAuditRepo(self.session)
        return self

    def __exit__(self, exc_type, exc, tb):  # noqa: ANN001
        try:
            if exc_type is None:
                self.session.commit()
            else:
                self.session.rollback()
        finally:
            self.session.close()
        return False
