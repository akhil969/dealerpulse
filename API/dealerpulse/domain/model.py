"""Dataset model: the uploaded file plus derived fields every rule needs.

Port of buildModel() in frontend/src/lib/analytics.ts. A lead's status follows its history,
and "today" (as_of) is the latest timestamp in the full file so every role shares one clock.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

FUNNEL_STAGES = ("new", "contacted", "test_drive", "negotiation", "order_placed", "delivered")
OPEN_STATUSES = ("new", "contacted", "test_drive", "negotiation")
DAY = 86_400.0
STALE_DAYS = 7
STUCK_ORDER_DAYS = 30


def ts(iso: str) -> float:
    """ISO 8601 (with or without Z / fraction / time) -> epoch seconds, UTC."""
    d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp()


def month_of(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m")


@dataclass
class Lead:
    raw: dict[str, Any]
    id: str
    status: str             # from history
    status_in_file: str
    branch_id: str
    assigned_to: str
    customer_name: str
    model_interested: str
    source: str
    deal_value: float
    lost_reason: str | None
    created: float
    created_month: str
    last_activity: float
    max_stage: int
    stage_at: dict[str, float]
    order_at: float | None
    order_month: str | None
    first_contact_hours: float | None
    delivery: dict[str, Any] | None
    days_since_activity: float = 0.0


@dataclass
class Model:
    branches: list[dict[str, Any]]
    reps: list[dict[str, Any]]
    targets: list[dict[str, Any]]
    leads: list[Lead]
    months: list[str]
    as_of: float
    branch_by_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    rep_by_id: dict[str, dict[str, Any]] = field(default_factory=dict)


def build_model(data: dict[str, Any], basis: tuple[float, list[str]] | None = None) -> Model:
    delivery_by_lead = {d["lead_id"]: d for d in data.get("deliveries", [])}
    as_of = 0.0
    leads: list[Lead] = []
    for l in data["leads"]:
        stage_at: dict[str, float] = {}
        max_stage = 0
        for ev in l["status_history"]:
            t = ts(ev["timestamp"])
            stage_at.setdefault(ev["status"], t)
            if ev["status"] in FUNNEL_STAGES:
                max_stage = max(max_stage, FUNNEL_STAGES.index(ev["status"]))
            as_of = max(as_of, t)
        last = ts(l["last_activity_at"])
        as_of = max(as_of, last)
        created = ts(l["created_at"])
        delivery = delivery_by_lead.get(l["id"])
        order_at = stage_at.get("order_placed")
        if order_at is None and delivery:
            order_at = ts(delivery["order_date"])
        if delivery:
            max_stage = 5
        status = l["status_history"][-1]["status"] if l["status_history"] else l["status"]
        leads.append(Lead(
            raw=l, id=l["id"], status=status, status_in_file=l["status"], branch_id=l["branch_id"],
            assigned_to=l["assigned_to"], customer_name=l["customer_name"], model_interested=l["model_interested"],
            source=l["source"], deal_value=float(l["deal_value"]), lost_reason=l.get("lost_reason") if status == "lost" else None,
            created=created, created_month=month_of(created), last_activity=last, max_stage=max_stage, stage_at=stage_at,
            order_at=order_at, order_month=month_of(order_at) if order_at is not None else None,
            first_contact_hours=(stage_at["contacted"] - created) / 3600 if "contacted" in stage_at else None,
            delivery=delivery,
        ))
    if basis:
        as_of = basis[0]
    for l in leads:
        l.days_since_activity = (as_of - l.last_activity) / DAY
    months = basis[1] if basis else sorted({t["month"] for t in data["targets"]} | {l.created_month for l in leads})
    return Model(
        branches=data["branches"], reps=data["sales_reps"], targets=data["targets"], leads=leads, months=months,
        as_of=as_of, branch_by_id={b["id"]: b for b in data["branches"]}, rep_by_id={r["id"]: r for r in data["sales_reps"]},
    )


def stale_leads(m: Model, days: int = STALE_DAYS) -> list[Lead]:
    return sorted((l for l in m.leads if l.status in OPEN_STATUSES and l.days_since_activity >= days),
                  key=lambda l: -l.days_since_activity)


def stuck_orders(m: Model) -> list[Lead]:
    return sorted((l for l in m.leads if l.status == "order_placed" and not l.delivery and l.order_at is not None
                   and (m.as_of - l.order_at) / DAY >= STUCK_ORDER_DAYS), key=lambda l: l.order_at or 0)


# ---------- Formatting (same output as the frontend) ----------

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def month_label(month: str, short: bool = False) -> str:
    y, mo = month.split("-")
    return _MONTHS[int(mo) - 1] if short else f"{_MONTHS[int(mo) - 1]} {y}"


def pct(v: float | None, digits: int = 0) -> str:
    return "—" if v is None else f"{v * 100:.{digits}f}%"


def inr(v: float, digits: int = 1) -> str:
    a = abs(v)
    sign = "-" if v < 0 else ""
    if a >= 1e7:
        return f"{sign}₹{a / 1e7:.{digits}f} Cr"
    if a >= 1e5:
        return f"{sign}₹{a / 1e5:.{digits}f} L"
    return f"{sign}₹{round(a):,}"


STATUS_LABEL = {"new": "New", "contacted": "Contacted", "test_drive": "Test drive", "negotiation": "Negotiation",
                "order_placed": "Order placed", "delivered": "Delivered", "lost": "Lost"}
