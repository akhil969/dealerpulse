"""Role-based access control: row scope, field rules and resource checks.

Server-side twin of frontend/src/lib/access.ts (documented in ACCESS_CONTROL.md).
Deny by default: anything not explicitly allowed for a role is refused.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Literal

Role = Literal["ceo", "manager", "rep"]
FieldRule = Literal["full", "masked", "hidden"]
ROLES: tuple[Role, ...] = ("ceo", "manager", "rep")


@dataclass(frozen=True)
class Principal:
    """The authenticated caller, built from the user record (never from request input)."""
    user_id: int
    username: str
    display_name: str
    role: Role
    rep_id: str | None = None
    branch_id: str | None = None

    @property
    def key(self) -> str:
        return self.rep_id or self.role


FIELD_RULES: dict[str, dict[Role, FieldRule]] = {
    "lead.customer_name": {"ceo": "full", "manager": "full", "rep": "full"},
    "lead.phone": {"ceo": "masked", "manager": "full", "rep": "full"},
    "lead.deal_value": {"ceo": "full", "manager": "full", "rep": "full"},
    "lead.status_history.note": {"ceo": "full", "manager": "full", "rep": "full"},
    "lead.lost_reason": {"ceo": "full", "manager": "full", "rep": "full"},
    "sales_rep.joined": {"ceo": "full", "manager": "full", "rep": "full"},
    "target.target_units": {"ceo": "full", "manager": "full", "rep": "hidden"},
    "target.target_revenue": {"ceo": "full", "manager": "full", "rep": "hidden"},
    "metadata.notes": {"ceo": "full", "manager": "hidden", "rep": "hidden"},
}


def field_rule(role: Role, f: str) -> FieldRule:
    return FIELD_RULES[f][role]


def mask_phone(phone: str) -> str:
    return "•••" if len(phone) <= 3 else "•" * (len(phone) - 3) + phone[-3:]


# ---------- Row scope ----------

def in_branch(p: Principal, branch_id: str) -> bool:
    return p.role == "ceo" or branch_id == p.branch_id


def can_see_lead(p: Principal, lead: dict[str, Any]) -> bool:
    if p.role == "rep":
        return lead["assigned_to"] == p.rep_id
    return in_branch(p, lead["branch_id"])


def can_see_rep(p: Principal, rep: dict[str, Any]) -> bool:
    if p.role == "rep":
        return rep["id"] == p.rep_id
    return in_branch(p, rep["branch_id"])


def can_see_branch(p: Principal, branch_id: str) -> bool:
    return in_branch(p, branch_id)


def sees_targets(p: Principal) -> bool:
    return field_rule(p.role, "target.target_units") != "hidden"


def sees_benchmarks(p: Principal) -> bool:
    return p.role == "ceo"


def sees_peers(p: Principal) -> bool:
    return p.role != "rep"


# ---------- Field projection ----------

def project_lead(p: Principal, lead: dict[str, Any], include_history: bool = True) -> dict[str, Any]:
    out = {k: v for k, v in lead.items() if k != "status_history"}
    rule = lambda f: field_rule(p.role, f)  # noqa: E731
    if rule("lead.phone") == "masked":
        out["phone"] = mask_phone(lead["phone"])
    elif rule("lead.phone") == "hidden":
        out["phone"] = ""
    if rule("lead.deal_value") == "hidden":
        out["deal_value"] = 0
    if rule("lead.lost_reason") == "hidden":
        out["lost_reason"] = None
    if include_history:
        hist = copy.deepcopy(lead["status_history"])
        if rule("lead.status_history.note") == "hidden":
            for e in hist:
                e.pop("note", None)
        out["status_history"] = hist
    return out


def project_rep(p: Principal, rep: dict[str, Any]) -> dict[str, Any]:
    out = dict(rep)
    if field_rule(p.role, "sales_rep.joined") == "hidden":
        out.pop("joined", None)
    return out


def scope_dataset(data: dict[str, Any], p: Principal) -> dict[str, Any]:
    """The full file filtered to rows this person may see, each field shown, masked or removed."""
    leads = [project_lead(p, l) for l in data["leads"] if can_see_lead(p, l)]
    lead_ids = {l["id"] for l in leads}
    meta = dict(data.get("metadata") or {})
    if field_rule(p.role, "metadata.notes") != "full":
        meta.pop("notes", None)
    return {
        "metadata": meta,
        "branches": [dict(b) for b in data["branches"] if can_see_branch(p, b["id"])],
        "sales_reps": [project_rep(p, r) for r in data["sales_reps"] if can_see_rep(p, r)],
        "leads": leads,
        "targets": [dict(t) for t in data["targets"] if sees_targets(p) and can_see_branch(p, t["branch_id"])],
        "deliveries": [dict(d) for d in data["deliveries"] if d["lead_id"] in lead_ids],
    }


def can_review(p: Principal, finding_branch_id: str | None) -> bool:
    if p.role == "ceo":
        return True
    if p.role == "manager":
        return finding_branch_id is not None and finding_branch_id == p.branch_id
    return False


def finding_visible(p: Principal, branch_id: str | None, rep_id: str | None, confirmed: bool) -> bool:
    if p.role == "ceo":
        return True
    if p.role == "manager":
        return branch_id == p.branch_id
    return rep_id == p.rep_id and confirmed
