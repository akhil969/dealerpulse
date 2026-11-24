"""Interfaces the application layer depends on. Infrastructure implements them (dependency inversion)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Protocol


@dataclass(frozen=True)
class PageRequest:
    page: int
    page_size: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


@dataclass(frozen=True)
class Page:
    items: list[dict[str, Any]]
    page: int
    page_size: int
    total: int

    def to_dict(self) -> dict[str, Any]:
        pages = max(1, -(-self.total // self.page_size))
        return {"items": self.items, "page": self.page, "page_size": self.page_size, "total": self.total,
                "pages": pages, "has_next": self.page < pages}


@dataclass(frozen=True)
class VersionInfo:
    id: int
    uploaded_at: datetime
    uploaded_by: str
    source_name: str
    counts: dict[str, int]
    revision: int = 0

    @property
    def key(self) -> str:
        return f"{self.id}.{self.revision}"


@dataclass(frozen=True)
class LeadQuery:
    """Row scope is mandatory and comes from the principal, never from the request."""
    scope_branch: str | None = None
    scope_rep: str | None = None
    branch_id: str | None = None
    rep_id: str | None = None
    status: str | None = None
    source: str | None = None
    search: str | None = None
    created_from: float | None = None
    created_to: float | None = None
    sort: str = "-created_at"


@dataclass
class UserRecord:
    id: int
    username: str
    display_name: str
    password_hash: str
    role: str
    rep_id: str | None
    branch_id: str | None
    active: bool
    failed_attempts: int
    locked_until: datetime | None
    token_version: int
    created_at: datetime
    created_by: str | None
    last_login_at: datetime | None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "username": self.username, "display_name": self.display_name, "role": self.role,
                "rep_id": self.rep_id, "branch_id": self.branch_id, "active": self.active,
                "locked": bool(self.locked_until and self.locked_until > datetime.now(self.locked_until.tzinfo)),
                "created_at": self.created_at.isoformat(), "created_by": self.created_by,
                "last_login_at": self.last_login_at.isoformat() if self.last_login_at else None}


class DatasetRepo(Protocol):
    def current_version(self) -> VersionInfo | None: ...
    def load_current(self) -> dict[str, Any] | None: ...
    def replace(self, data: dict[str, Any], source_name: str, uploaded_by: str) -> VersionInfo: ...
    def add_person(self, rep: dict[str, Any]) -> None: ...
    def next_rep_id(self) -> str: ...
    def branch_exists(self, branch_id: str) -> bool: ...
    def get_rep(self, rep_id: str) -> dict[str, Any] | None: ...
    def list_leads(self, q: LeadQuery, page: PageRequest) -> tuple[list[dict[str, Any]], int]: ...
    def get_lead(self, lead_id: str) -> dict[str, Any] | None: ...
    def list_table(self, table: str, scope_branch: str | None, scope_rep: str | None, page: PageRequest,
                   search: str | None = None) -> tuple[list[dict[str, Any]], int]: ...


class UserRepo(Protocol):
    def get(self, user_id: int) -> UserRecord | None: ...
    def by_username(self, username: str) -> UserRecord | None: ...
    def list(self, page: PageRequest, search: str | None, role: str | None) -> tuple[list[UserRecord], int]: ...
    def rep_ids_with_login(self) -> set[str]: ...
    def create(self, **fields: Any) -> UserRecord: ...
    def update(self, user_id: int, **fields: Any) -> UserRecord: ...
    def delete(self, user_id: int) -> None: ...
    def count(self) -> int: ...


class ReadRepo(Protocol):
    def read_ids(self, user_id: int) -> set[str]: ...
    def mark(self, user_id: int, ids: Iterable[str]) -> None: ...


class ReviewRepo(Protocol):
    def all(self, version_id: int) -> dict[str, dict[str, Any]]: ...
    def upsert(self, version_id: int, anomaly_id: str, **fields: Any) -> None: ...
    def delete(self, version_id: int, anomaly_id: str) -> None: ...
    def add_event(self, version_id: int, anomaly_id: str, **fields: Any) -> None: ...
    def events(self, version_id: int, anomaly_id: str) -> list[dict[str, Any]]: ...
    def stamp(self, version_id: int) -> str: ...


class AuditRepo(Protocol):
    def add(self, actor: str, action: str, outcome: str, target: str = "", ip: str = "", detail: dict | None = None) -> None: ...
    def list(self, page: PageRequest, action: str | None) -> tuple[list[dict[str, Any]], int]: ...


class Repos(Protocol):
    datasets: DatasetRepo
    users: UserRepo
    reads: ReadRepo
    reviews: ReviewRepo
    audit: AuditRepo


class Hasher(Protocol):
    def hash(self, password: str) -> str: ...
    def verify(self, password_hash: str | None, password: str) -> bool: ...


class Tokens(Protocol):
    def access_token(self, user_id: int, token_version: int) -> tuple[str, int]: ...
    def stream_ticket(self, user_id: int, token_version: int) -> tuple[str, int]: ...
    def decode(self, token: str, audience: str) -> dict[str, Any]: ...


class SnapshotCache(Protocol):
    def get(self, key: str, loader: Any) -> Any: ...
    def memo(self, snap: Any, name: str, compute: Any) -> Any: ...
