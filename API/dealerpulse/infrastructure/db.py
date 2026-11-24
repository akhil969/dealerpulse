"""Database engine and tables (SQLAlchemy 2). Portable: SQLite locally, any SQL database via DATABASE_URL."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, Float, ForeignKey, Index, Integer, String, Text, create_engine, event)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# ---------- Dataset (the current upload; replaced as a whole on every import) ----------

class DatasetVersion(Base):
    __tablename__ = "dataset_versions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    uploaded_at: Mapped[datetime] = mapped_column(default=utcnow)
    uploaded_by: Mapped[str] = mapped_column(String(120))
    source_name: Mapped[str] = mapped_column(String(255))
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    counts: Mapped[dict] = mapped_column(JSON, default=dict)
    is_current: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)  # bumped when a person is added without a new upload


class BranchRow(Base):
    __tablename__ = "branches"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    city: Mapped[str] = mapped_column(String(120))


class SalesRepRow(Base):
    __tablename__ = "sales_reps"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    branch_id: Mapped[str] = mapped_column(String(40), ForeignKey("branches.id"), index=True)
    role: Mapped[str] = mapped_column(String(30))
    joined: Mapped[str] = mapped_column(String(40))


class LeadRow(Base):
    __tablename__ = "leads"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    customer_name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str] = mapped_column(String(40))
    source: Mapped[str] = mapped_column(String(60), index=True)
    model_interested: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(30))          # as written in the file
    current_status: Mapped[str] = mapped_column(String(30), index=True)  # from history (what the app uses)
    assigned_to: Mapped[str] = mapped_column(String(40), ForeignKey("sales_reps.id"), index=True)
    branch_id: Mapped[str] = mapped_column(String(40), ForeignKey("branches.id"), index=True)
    created_at: Mapped[str] = mapped_column(String(40))
    created_ts: Mapped[float] = mapped_column(Float, index=True)
    last_activity_at: Mapped[str] = mapped_column(String(40))
    last_activity_ts: Mapped[float] = mapped_column(Float, index=True)
    expected_close_date: Mapped[str | None] = mapped_column(String(40), nullable=True)
    deal_value: Mapped[float] = mapped_column(Float, index=True)
    lost_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status_history: Mapped[list] = mapped_column(JSON)

    __table_args__ = (Index("ix_leads_branch_created", "branch_id", "created_ts"),
                      Index("ix_leads_rep_created", "assigned_to", "created_ts"))


class TargetRow(Base):
    __tablename__ = "targets"
    branch_id: Mapped[str] = mapped_column(String(40), ForeignKey("branches.id"), primary_key=True)
    month: Mapped[str] = mapped_column(String(7), primary_key=True)
    target_units: Mapped[float] = mapped_column(Float)
    target_revenue: Mapped[float] = mapped_column(Float)


class DeliveryRow(Base):
    __tablename__ = "deliveries"
    lead_id: Mapped[str] = mapped_column(String(40), ForeignKey("leads.id"), primary_key=True)
    order_date: Mapped[str] = mapped_column(String(40))
    delivery_date: Mapped[str] = mapped_column(String(40), index=True)
    days_to_deliver: Mapped[float] = mapped_column(Float)
    delay_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)


# ---------- Accounts and app state (survive data uploads) ----------

class UserRow(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # stored lower-case
    display_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20))
    rep_id: Mapped[str | None] = mapped_column(String(40), nullable=True, unique=True)
    branch_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(nullable=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(nullable=True)


class NotificationRead(Base):
    __tablename__ = "notification_reads"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    notice_id: Mapped[str] = mapped_column(String(400), primary_key=True)
    read_at: Mapped[datetime] = mapped_column(default=utcnow)


class AnomalyReview(Base):
    __tablename__ = "anomaly_reviews"
    version_id: Mapped[int] = mapped_column(ForeignKey("dataset_versions.id", ondelete="CASCADE"), primary_key=True)
    anomaly_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    decision: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(Text, default="")
    by_user_id: Mapped[int] = mapped_column(Integer)
    by_name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20))
    at: Mapped[datetime] = mapped_column(default=utcnow)
    branch_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    rep_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    snapshot: Mapped[dict] = mapped_column(JSON)


class AnomalyReviewEvent(Base):
    __tablename__ = "anomaly_review_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version_id: Mapped[int] = mapped_column(Integer, index=True)
    anomaly_id: Mapped[str] = mapped_column(String(200), index=True)
    decision: Mapped[str] = mapped_column(String(20))   # confirmed | dismissed | reopened
    note: Mapped[str] = mapped_column(Text, default="")
    by_name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20))
    at: Mapped[datetime] = mapped_column(default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(60), index=True)
    target: Mapped[str] = mapped_column(String(200), default="")
    outcome: Mapped[str] = mapped_column(String(20))
    ip: Mapped[str] = mapped_column(String(64), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)


def make_engine(url: str) -> Engine:
    kwargs = {"connect_args": {"check_same_thread": False, "timeout": 15}} if url.startswith("sqlite") else {"pool_pre_ping": True}
    engine = create_engine(url, future=True, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _pragmas(conn, _):  # noqa: ANN001
            cur = conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")      # readers don't block the writer (SSE + requests)
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()
    return engine


def make_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def create_schema(engine: Engine) -> None:
    Base.metadata.create_all(engine)
