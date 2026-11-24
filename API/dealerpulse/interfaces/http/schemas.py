"""Request validation at the trust boundary. Unknown fields are rejected; strings are length-capped."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ...application.ports import LeadQuery, PageRequest


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginIn(Strict):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class PasswordChangeIn(Strict):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)


class NewPerson(Strict):
    name: str = Field(min_length=2, max_length=120)
    branch_id: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    role: Literal["branch_manager", "sales_officer"]


class UserCreateIn(Strict):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)
    rep_id: str | None = Field(default=None, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    new_person: NewPerson | None = None
    role: Literal["ceo"] | None = None
    display_name: str | None = Field(default=None, max_length=120)


class UserUpdateIn(Strict):
    active: bool | None = None
    password: str | None = Field(default=None, max_length=128)
    unlock: bool | None = None
    display_name: str | None = Field(default=None, max_length=120)


class ReadIn(Strict):
    ids: list[str] = Field(min_length=1, max_length=500)

    @field_validator("ids")
    @classmethod
    def _cap(cls, v: list[str]) -> list[str]:
        return [i[:400] for i in v]


class ReviewIn(Strict):
    decision: Literal["confirmed", "dismissed"]
    note: str = Field(default="", max_length=1000)


class ReopenIn(Strict):
    note: str = Field(default="", max_length=1000)


class PageArgs(Strict):
    model_config = ConfigDict(extra="ignore")
    page: int = Field(default=1, ge=1, le=100_000)
    page_size: int = Field(default=25, ge=1, le=200)

    def to_request(self) -> PageRequest:
        return PageRequest(self.page, self.page_size)


class LeadArgs(PageArgs):
    status: Literal["new", "contacted", "test_drive", "negotiation", "order_placed", "delivered", "lost"] | None = None
    branch_id: str | None = Field(default=None, max_length=40)
    rep_id: str | None = Field(default=None, max_length=40)
    source: str | None = Field(default=None, max_length=60)
    q: str | None = Field(default=None, max_length=80)
    created_from: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}(-\d{2})?$")
    created_to: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}(-\d{2})?$")
    sort: Literal["created_at", "-created_at", "last_activity_at", "-last_activity_at", "deal_value", "-deal_value"] = "-created_at"

    def to_query(self) -> LeadQuery:
        from ...domain.model import ts

        def bound(v: str | None, end: bool) -> float | None:
            if not v:
                return None
            if len(v) == 7:  # a month: start of it, or start of the next month for an end bound
                y, m = map(int, v.split("-"))
                if end:
                    y, m = (y + 1, 1) if m == 12 else (y, m + 1)
                return ts(f"{y:04d}-{m:02d}-01T00:00:00Z")
            return ts(f"{v}T00:00:00Z") + (86400 if end else 0)
        return LeadQuery(branch_id=self.branch_id, rep_id=self.rep_id, status=self.status, source=self.source, search=self.q,
                         created_from=bound(self.created_from, False), created_to=bound(self.created_to, True), sort=self.sort)


class SearchArgs(PageArgs):
    q: str | None = Field(default=None, max_length=80)
    role: Literal["ceo", "manager", "rep"] | None = None
    branch_id: str | None = Field(default=None, max_length=40)
    action: str | None = Field(default=None, max_length=60)


class NoticeArgs(PageArgs):
    unread_only: bool = False


class AnomalyArgs(PageArgs):
    status: Literal["flagged", "confirmed", "dismissed"] | None = None
    category: Literal["sales", "team", "delivery", "data"] | None = None
    branch_id: str | None = Field(default=None, max_length=40)
