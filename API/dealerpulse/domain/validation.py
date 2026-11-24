"""Dataset validation. Port of frontend/src/lib/validate.ts with the same plain-language messages."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any

LEAD_STATUSES = ("new", "contacted", "test_drive", "negotiation", "order_placed", "delivered", "lost")
REP_ROLES = ("branch_manager", "sales_officer")
MAX_REPORTED = 500

# (type, allowed values). Types: string, number, date, month; a trailing "?" means optional/nullable.
SCHEMA: dict[str, dict[str, tuple[str, tuple[str, ...] | None]]] = {
    "branches": {"id": ("string", None), "name": ("string", None), "city": ("string", None)},
    "sales_reps": {"id": ("string", None), "name": ("string", None), "branch_id": ("string", None),
                   "role": ("string", REP_ROLES), "joined": ("date", None)},
    "leads": {"id": ("string", None), "customer_name": ("string", None), "phone": ("string", None),
              "source": ("string", None), "model_interested": ("string", None), "status": ("string", LEAD_STATUSES),
              "assigned_to": ("string", None), "branch_id": ("string", None), "created_at": ("date", None),
              "last_activity_at": ("date", None), "expected_close_date": ("date?", None), "deal_value": ("number", None),
              "lost_reason": ("string?", None)},
    "targets": {"branch_id": ("string", None), "month": ("month", None), "target_units": ("number", None),
                "target_revenue": ("number", None)},
    "deliveries": {"lead_id": ("string", None), "order_date": ("date", None), "delivery_date": ("date", None),
                   "days_to_deliver": ("number", None), "delay_reason": ("string?", None)},
}
EVENT_SCHEMA = {"status": ("string", LEAD_STATUSES), "timestamp": ("date", None), "note": ("string?", None)}

SECTION_LABEL = {"$": "The file", "metadata": "About this file", "branches": "Branches", "sales_reps": "Sales team",
                 "leads": "Leads", "targets": "Monthly targets", "deliveries": "Deliveries"}
ITEM_LABEL = {"branches": "Branch", "sales_reps": "Team member", "leads": "Lead", "targets": "Target", "deliveries": "Delivery"}
_PATH = re.compile(r"^(\w+)(?:\[(\d+)\])?(?:\.status_history\[(\d+)\])?(?:\.(\w+))?$")
_MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


@dataclass
class Issue:
    path: str
    where: str
    section: str
    message: str


@dataclass
class ValidationResult:
    ok: bool
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    error_count: int = 0
    counts: dict[str, int] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "error_count": self.error_count, "counts": self.counts,
                "errors": [asdict(e) for e in self.errors], "warnings": [asdict(w) for w in self.warnings]}


def _describe(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def _is_date(v: Any) -> bool:
    if not isinstance(v, str) or not v:
        return False
    try:
        datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _check(value: Any, spec: tuple[str, tuple[str, ...] | None], present: bool) -> str | None:
    kind, allowed = spec
    optional = kind.endswith("?")
    base = kind.rstrip("?")
    if not present:
        return None if optional else "is missing"
    if value is None:
        return None if optional else "is empty (null) but needs a value"
    if base == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
            return f"should be a number, but it is {_describe(value)}"
        return "can't be negative" if value < 0 else None
    if base == "string":
        if not isinstance(value, str):
            return f"should be text, but it is {_describe(value)}"
        if not optional and not value.strip():
            return "is blank"
        if allowed and value not in allowed:
            return f'is "{value}", which isn\'t allowed. Use one of: {", ".join(allowed)}'
        return None
    if base == "date":
        return None if _is_date(value) else f"should be a date like 2025-06-01 or 2025-06-01T10:30:00Z, but it is {value!r}"
    if base == "month":
        return None if isinstance(value, str) and _MONTH.match(value) else f"should be a month like 2025-06, but it is {value!r}"
    return None


def _where(path: str, data: Any) -> tuple[str, str]:
    m = _PATH.match(path)
    if not m:
        label = SECTION_LABEL.get(path, path)
        return label, label
    coll, idx, hist, fld = m.groups()
    section = SECTION_LABEL.get(coll, coll)
    if idx is None:
        return f"{section} section", section
    rec = data.get(coll, [None])[int(idx)] if isinstance(data, dict) and isinstance(data.get(coll), list) and int(idx) < len(data[coll]) else None
    rid = None
    if isinstance(rec, dict):
        rid = rec.get("id") or rec.get("lead_id") or (f"{rec.get('branch_id')}, {rec.get('month')}" if rec.get("month") else None)
    parts = [f"{ITEM_LABEL.get(coll, coll)} {int(idx) + 1}" + (f" ({rid})" if isinstance(rid, str) else "")]
    if hist is not None:
        parts.append(f"history step {int(hist) + 1}")
    if fld:
        parts.append(fld.replace("_", " ").capitalize())
    return ", ".join(parts), section


def validate_dataset(data: Any) -> ValidationResult:
    res = ValidationResult(ok=False)

    def err(path: str, msg: str) -> None:
        res.error_count += 1
        if len(res.errors) < MAX_REPORTED:
            where, section = _where(path, data)
            res.errors.append(Issue(path, where, section, msg))

    def warn(path: str, msg: str) -> None:
        if len(res.warnings) < MAX_REPORTED:
            where, section = _where(path, data)
            res.warnings.append(Issue(path, where, section, msg))

    if not isinstance(data, dict):
        err("$", f"should start with {{ and contain the required sections, but it is {_describe(data)}")
        return res
    if "metadata" in data and not isinstance(data["metadata"], dict):
        err("metadata", "should be a group of fields inside { }")

    for coll, fields in SCHEMA.items():
        if coll not in data:
            err(coll, "is missing. Every file needs this section, even if it's empty: []")
            continue
        arr = data[coll]
        if not isinstance(arr, list):
            err(coll, f"should be a list inside [ ], but it is {_describe(arr)}")
            continue
        if not arr and coll != "deliveries":
            err(coll, "is empty. Add at least one entry")
        for i, rec in enumerate(arr):
            p = f"{coll}[{i}]"
            if not isinstance(rec, dict):
                err(p, f"should be a group of fields inside {{ }}, but it is {_describe(rec)}")
                continue
            for f, spec in fields.items():
                problem = _check(rec.get(f), spec, f in rec)
                if problem:
                    err(f"{p}.{f}", problem)
            if coll == "leads":
                hist = rec.get("status_history")
                if not isinstance(hist, list):
                    err(f"{p}.status_history", f"should be a list of status changes inside [ ], but it is {_describe(hist)}")
                elif not hist:
                    err(f"{p}.status_history", 'is empty. Every lead needs at least its first "new" status')
                else:
                    for j, ev in enumerate(hist):
                        hp = f"{p}.status_history[{j}]"
                        if not isinstance(ev, dict):
                            err(hp, "should be a group of fields inside { }")
                            continue
                        for f, spec in EVENT_SCHEMA.items():
                            problem = _check(ev.get(f), spec, f in ev)
                            if problem:
                                err(f"{hp}.{f}", problem)
                    last = hist[-1]
                    if isinstance(last, dict) and last.get("status") != rec.get("status"):
                        warn(p, f'is marked "{rec.get("status")}", but its history ends at "{last.get("status")}". '
                                f'DealerPulse goes by the history and treats it as "{last.get("status")}". Your file is not changed')

    if res.error_count:
        return res

    def ids(coll: str) -> set[str]:
        seen: set[str] = set()
        for i, r in enumerate(data[coll]):
            if r["id"] in seen:
                err(f"{coll}[{i}].id", f'uses the ID "{r["id"]}", which another entry already has. IDs must be unique')
            seen.add(r["id"])
        return seen

    branch_ids, rep_ids, lead_ids = ids("branches"), ids("sales_reps"), ids("leads")
    for i, r in enumerate(data["sales_reps"]):
        if r["branch_id"] not in branch_ids:
            err(f"sales_reps[{i}].branch_id", f'points to branch "{r["branch_id"]}", which isn\'t in the branches list')
    for i, l in enumerate(data["leads"]):
        if l["branch_id"] not in branch_ids:
            err(f"leads[{i}].branch_id", f'points to branch "{l["branch_id"]}", which isn\'t in the branches list')
        if l["assigned_to"] not in rep_ids:
            err(f"leads[{i}].assigned_to", f'is assigned to "{l["assigned_to"]}", who isn\'t in the sales reps list')
    keys: set[str] = set()
    for i, t in enumerate(data["targets"]):
        if t["branch_id"] not in branch_ids:
            err(f"targets[{i}].branch_id", f'points to branch "{t["branch_id"]}", which isn\'t in the branches list')
        k = f'{t["branch_id"]}|{t["month"]}'
        if k in keys:
            err(f"targets[{i}]", f'is a second target for {t["branch_id"]} in {t["month"]}. Keep one per branch per month')
        keys.add(k)
    for i, d in enumerate(data["deliveries"]):
        if d["lead_id"] not in lead_ids:
            err(f"deliveries[{i}].lead_id", f'refers to lead "{d["lead_id"]}", which isn\'t in the leads list')
        elif d["delivery_date"] < d["order_date"]:
            warn(f"deliveries[{i}]", "has a delivery date earlier than its order date")

    res.counts = {k: len(data[k]) for k in SCHEMA}
    res.ok = res.error_count == 0
    return res
