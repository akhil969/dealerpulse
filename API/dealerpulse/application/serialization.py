"""Stable JSON bytes and a strong ETag, so unchanged data can be answered with 304 Not Modified."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def json_and_etag(payload: Any) -> tuple[bytes, str]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    return body, '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
