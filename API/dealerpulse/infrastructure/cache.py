"""In-process cache of the current dataset and everything derived from it, keyed by dataset revision.

Reads are served from memory (fast); any upload or added person changes the revision key, so every
worker reloads on its next request. Scoped views and findings are cached per access scope.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable

from ..domain.model import Model, build_model


@dataclass
class Snapshot:
    key: str
    data: dict[str, Any]
    model: Model
    derived: dict[str, Any] = field(default_factory=dict)  # per-scope results (scoped JSON, findings, models)


class DatasetCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snap: Snapshot | None = None

    def get(self, key: str, loader: Callable[[], dict[str, Any] | None]) -> Snapshot | None:
        with self._lock:
            if self._snap and self._snap.key == key:
                return self._snap
        data = loader()
        if data is None:
            return None
        snap = Snapshot(key, data, build_model(data))
        with self._lock:
            self._snap = snap
        return snap

    @staticmethod
    def memo(snap: Snapshot, name: str, compute: Callable[[], Any]) -> Any:
        if name not in snap.derived:
            snap.derived[name] = compute()  # benign race: same deterministic value either way
        return snap.derived[name]

    def clear(self) -> None:
        with self._lock:
            self._snap = None
